#!/bin/bash
set +e
# dropbox_ignore_artifacts.sh
# -----------------------------------------------------------------------------
# FLEET POLICY (AI_RULES §12): node_modules — and other regenerable build
# artifacts, plus every repo's .git dir — must NEVER sync to Dropbox, on ANY
# machine.
#
# Dropbox indexing/syncing a dev tree full of node_modules (tens of thousands of
# churning files per repo) pegs CPU + RAM and makes the Mac unusable. These dirs
# are reinstalled/rebuilt per machine (the framework is Docker-based) and are
# never version-controlled, so syncing them is pure waste.
#
# .git is the other must-never-sync dir: thousands of small churning objects,
# already replicated per machine via GitHub (not Dropbox), and — worst of all —
# Dropbox racing two machines' writes into the same .git corrupts the repo. But
# UNLIKE node_modules, marking .git ignored is DESTRUCTIVE across machines
# (deletes it from every other synced Mac). So this always-on hook only PRUNES
# .git (never descends into it) — it does NOT mark it. .git ignoring is applied
# ONLY by the precondition-gated scripts/dropbox_ignore_git.sh. See MARK_PRUNE_NAMES.
#
# Mechanism: Dropbox's official per-folder ignore flag — the extended attribute
# `com.dropbox.ignored=1`. The folder STAYS on local disk; Dropbox just stops
# indexing/syncing it. For regenerable artifact dirs (node_modules, dist, ...)
# this is fully reversible: `xattr -d com.dropbox.ignored <dir>`.
#
# ⚠️ .git is the ONE exception to "reversible" — marking it ignored PURGES the
# folder from the Dropbox SERVER as a sync-config change, not a user delete,
# leaving NO rewind point on Dropbox's side. `xattr -d` only restores local
# syncing going forward; it cannot bring back a server copy that's already gone.
# This is what stranded runner-host on 2026-08-27/28: the Mac hadn't
# synced since early July, another machine had already Dropbox-ignored its
# repos' .git dirs (2026-08-26 fleet sweep), and when this Mac came online every
# managed repo's .git was simply gone — no Dropbox restore, no rewind, nothing
# to search for (verified: absent from server listing, 0 hits searching deleted
# files for packed-refs). Recovery required rebuilding .git from GitHub refs via
# scripts/restore_git_metadata.sh, not a Dropbox restore.
# Because of this, GitHub — not Dropbox — MUST be the source of truth for every
# repo's .git. Never rely on Dropbox to distribute or back up .git; that's
# exactly the assumption that failed here.
#
# Idempotent — only sets the flag where missing (no needless metadata churn).
# macOS + Dropbox only; silent no-op elsewhere (Linux/cloud/container).
#
# Usage:
#   ./scripts/dropbox_ignore_artifacts.sh            # current repo only (fast; used by the session hook)
#   ./scripts/dropbox_ignore_artifacts.sh <dir>      # a specific dir tree
#   ./scripts/dropbox_ignore_artifacts.sh --all      # sweep the ENTIRE Dropbox root (manual fleet sweep)
#   ./scripts/dropbox_ignore_artifacts.sh --quiet    # suppress output when nothing changed (hook mode)
# -----------------------------------------------------------------------------

# Dirs that must never sync. node_modules is the mandated policy; the rest are
# the same class of regenerable junk and ride along.
ARTIFACT_NAMES=(node_modules .next dist build coverage .turbo .parcel-cache .nuxt .svelte-kit)

# Prune-class dirs: huge/deep trees find must never descend INTO (whether or not
# we mark them). node_modules (huge) and .git (thousands of churning objects).
PRUNE_NAMES=(node_modules .git)

# MARK set among the prune-class: node_modules is marked+pruned here.
# .git is DELIBERATELY EXCLUDED from auto-marking — marking .git ignored is
# DESTRUCTIVE across machines (Dropbox deletes it from every other synced Mac,
# taking any local-only commits with it — the 2026-08-27/28 strand + 2026-07-17
# exo corruption). So .git is pruned (never descended into) but NEVER marked by
# this always-on hook. .git ignoring is handled ONLY by the precondition-gated
# scripts/dropbox_ignore_git.sh (refuses unless the repo has no uncommitted /
# unpushed / upstream-less / stashed work, or a backup tarball was written).
MARK_PRUNE_NAMES=(node_modules)

QUIET=0
TARGET=""
ALL=0
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=1 ;;
    --all)   ALL=1 ;;
    *)       TARGET="$arg" ;;
  esac
done

log() { [ "$QUIET" = "1" ] && [ "$1" = "noop" ] && return 0; shift 2>/dev/null; echo "$@"; }

# --- guards: macOS + Dropbox only -------------------------------------------
if [ "$(uname)" != "Darwin" ]; then
  [ "$QUIET" = "1" ] || echo "dropbox-ignore: skipped (not macOS)"
  exit 0
fi
if [ -f /.dockerenv ] || [ -n "$MYAI_IN_CONTAINER" ]; then
  [ "$QUIET" = "1" ] || echo "dropbox-ignore: skipped (inside container)"
  exit 0
fi

# --- resolve roots to scan ---------------------------------------------------
ROOTS=()
if [ "$ALL" = "1" ]; then
  # every Dropbox root variant: $HOME/Dropbox, "$HOME/Dropbox (Personal)", business, etc.
  for d in "$HOME"/Dropbox*; do [ -d "$d" ] && ROOTS+=("$d"); done
elif [ -n "$TARGET" ]; then
  ROOTS+=("$TARGET")
else
  # default: the current repo root — but ONLY if it lives under Dropbox
  R=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  case "$R" in
    */Dropbox*|*/Dropbox\ */) ROOTS+=("$R") ;;
    *) [ "$QUIET" = "1" ] || echo "dropbox-ignore: repo not under Dropbox — nothing to do"; exit 0 ;;
  esac
fi

[ "${#ROOTS[@]}" -eq 0 ] && { [ "$QUIET" = "1" ] || echo "dropbox-ignore: no Dropbox roots found"; exit 0; }

mark() {
  # mark one dir ignored if not already; echo 1 if newly set
  local d="$1"
  if [ "$(xattr -p com.dropbox.ignored "$d" 2>/dev/null)" != "1" ]; then
    xattr -w com.dropbox.ignored 1 "$d" 2>/dev/null && echo 1
  fi
}

# prune expression shared by both passes: \( -name node_modules -o -name .git \)
PEXPR=()
for n in "${PRUNE_NAMES[@]}"; do PEXPR+=(-name "$n" -o); done
unset 'PEXPR[${#PEXPR[@]}-1]'  # drop trailing -o

NEW=0
ALREADY=0
MEXPR=()
for n in "${MARK_PRUNE_NAMES[@]}"; do MEXPR+=(-name "$n" -o); done
unset 'MEXPR[${#MEXPR[@]}-1]'  # drop trailing -o

for ROOT in "${ROOTS[@]}"; do
  [ -d "$ROOT" ] || continue
  # 1) prune-class MARK dirs — node_modules only (prune + mark). .git is pruned
  #    by PEXPR in pass 2 but never marked here (see MARK_PRUNE_NAMES comment).
  while IFS= read -r d; do
    if [ "$(mark "$d")" = "1" ]; then NEW=$((NEW+1)); else ALREADY=$((ALREADY+1)); fi
  done < <(find "$ROOT" -type d \( "${MEXPR[@]}" \) -prune 2>/dev/null)

  # 2) other build artifacts that live OUTSIDE the prune-class dirs
  EXPR=()
  for n in "${ARTIFACT_NAMES[@]}"; do
    [ "$n" = "node_modules" ] && continue
    EXPR+=(-name "$n" -o)
  done
  unset 'EXPR[${#EXPR[@]}-1]'  # drop trailing -o
  while IFS= read -r d; do
    if [ "$(mark "$d")" = "1" ]; then NEW=$((NEW+1)); else ALREADY=$((ALREADY+1)); fi
  done < <(find "$ROOT" -type d \( "${PEXPR[@]}" \) -prune -o -type d \( "${EXPR[@]}" \) -print 2>/dev/null)
done

if [ "$NEW" -gt 0 ]; then
  echo "dropbox-ignore: marked $NEW new artifact dir(s) as Dropbox-ignored ($ALREADY already ignored)"
elif [ "$QUIET" != "1" ]; then
  echo "dropbox-ignore: all $ALREADY artifact dir(s) already ignored — nothing to do"
fi
exit 0
