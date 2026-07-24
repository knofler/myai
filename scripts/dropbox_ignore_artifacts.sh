#!/bin/bash
set +e
# dropbox_ignore_artifacts.sh
# -----------------------------------------------------------------------------
# FLEET POLICY (AI_RULES §12): node_modules — and other regenerable build
# artifacts — must NEVER sync to Dropbox, on ANY machine.
#
# Dropbox indexing/syncing a dev tree full of node_modules (tens of thousands of
# churning files per repo) pegs CPU + RAM and makes the Mac unusable. These dirs
# are reinstalled/rebuilt per machine (the framework is Docker-based) and are
# never version-controlled, so syncing them is pure waste.
#
# Mechanism: Dropbox's official per-folder ignore flag — the extended attribute
# `com.dropbox.ignored=1`. The folder STAYS on local disk; Dropbox just stops
# indexing/syncing it. Fully reversible: `xattr -d com.dropbox.ignored <dir>`.
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

NEW=0
ALREADY=0
for ROOT in "${ROOTS[@]}"; do
  [ -d "$ROOT" ] || continue
  # 1) node_modules (prune so we don't descend into them)
  while IFS= read -r d; do
    if [ "$(mark "$d")" = "1" ]; then NEW=$((NEW+1)); else ALREADY=$((ALREADY+1)); fi
  done < <(find "$ROOT" -type d -name node_modules -prune 2>/dev/null)

  # 2) other build artifacts that live OUTSIDE node_modules
  EXPR=()
  for n in "${ARTIFACT_NAMES[@]}"; do
    [ "$n" = "node_modules" ] && continue
    EXPR+=(-name "$n" -o)
  done
  unset 'EXPR[${#EXPR[@]}-1]'  # drop trailing -o
  while IFS= read -r d; do
    if [ "$(mark "$d")" = "1" ]; then NEW=$((NEW+1)); else ALREADY=$((ALREADY+1)); fi
  done < <(find "$ROOT" -type d -name node_modules -prune -o -type d \( "${EXPR[@]}" \) -print 2>/dev/null)
done

if [ "$NEW" -gt 0 ]; then
  echo "dropbox-ignore: marked $NEW new artifact dir(s) as Dropbox-ignored ($ALREADY already ignored)"
elif [ "$QUIET" != "1" ]; then
  echo "dropbox-ignore: all $ALREADY artifact dir(s) already ignored — nothing to do"
fi
exit 0
