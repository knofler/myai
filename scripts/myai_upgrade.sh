#!/usr/bin/env bash
# myai_upgrade.sh — self-update the global CLI + run pending schema migrations (`myai upgrade`).
#
#   myai upgrade [--check] [--dry-run] [--no-self-update] [--json] [--quiet]
#       0. brain safety (v1 gate G6) — BEFORE anything else: snapshot the brain
#          to $MYAI_HOME/backups/brain-<ts>.bundle (git bundle --all, verified,
#          path printed before npm runs; last 3 kept). After migrating, verify
#          the brain (HEAD resolves, the old HEAD is an ancestor, atom count not
#          lower, objects connect); on any failure restore the bundle to the
#          exact old HEAD and exit 4. A brain.path pointer naming a missing
#          directory stops the upgrade (exit 3) instead of silently skipping it.
#       Then two phases, in order:
#         1. self-update  — `npm update -g ai-management` so the globally
#                           installed CLI matches the latest published version.
#         2. migrate      — bring on-disk state up to the framework's current
#                           schema (idempotent): the $MYAI_HOME/config file and
#                           the git-versioned brain layout. Safe to run repeatedly.
#            2b. swarm master — a host that already ran a swarm but has no
#                           per-device $MYAI_HOME/swarm/master.<host> gets its
#                           current master + legacy order written so it keeps
#                           working (scripts/swarm_master_set.sh migrate, gate G6).
#
#       --check          report pending migrations WITHOUT applying (exit 20 if any
#                        pending); also skips the npm self-update.
#       --dry-run        show what WOULD happen for both phases; touch nothing.
#       --no-self-update run migrations only; skip the npm global update.
#       --json           emit the migration result as a single JSON object.
#       --quiet          minimal output.
#
#       Idempotent: a second `myai upgrade` after a clean one is a no-op (0
#       migrations pending). The npm step is a global-package update — harmless
#       to repeat.
#
# Resolution (mirrors scripts/lib/brain.sh):
#   $MYAI_HOME       config home           (default ~/.myai)
#   $MYAI_BRAIN_DIR → $MYAI_HOME/brain.path → $MYAI_HOME/brain   (brain repo)
#
# Env:
#   MYAI_UPGRADE_NPM=0   force-skip the npm self-update (same as --no-self-update;
#                        used by the test suite so no network/global write happens)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG_NAME="ai-management"
MIGRATOR="${MYAI_MIGRATOR:-$HERE/lib/myai_migrate.py}"   # MYAI_MIGRATOR: test seam

# brain_home/brain_dir resolution lives in the shared lib; fall back to inline
# defaults if the lib is missing (keeps upgrade working from a partial checkout).
# shellcheck source=lib/brain.sh
if ! . "$HERE/lib/brain.sh" 2>/dev/null; then
  brain_home() { printf '%s\n' "${MYAI_HOME:-$HOME/.myai}"; }
  brain_dir() {
    if [ -n "${MYAI_BRAIN_DIR:-}" ]; then printf '%s\n' "$MYAI_BRAIN_DIR"; return 0; fi
    local ptr; ptr="$(brain_home)/brain.path"
    if [ -f "$ptr" ]; then local p; p="$(head -1 "$ptr" 2>/dev/null)"; [ -n "$p" ] && { printf '%s\n' "$p"; return 0; }; fi
    printf '%s\n' "$(brain_home)/brain"
  }
fi

usage() { sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'; }

CHECK=0 DRY=0 SELF_UPDATE=1 JSON=0 QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1;;
    --dry-run|-n) DRY=1;;
    --no-self-update|--skip-npm) SELF_UPDATE=0;;
    --json) JSON=1;;
    --quiet|-q) QUIET=1;;
    -h|--help) usage; exit 0;;
    -*) echo "myai upgrade: unknown flag $1" >&2; usage >&2; exit 2;;
    *) echo "myai upgrade: unexpected argument '$1'" >&2; usage >&2; exit 2;;
  esac; shift
done

# --check and --dry-run never touch the global npm install.
[ "$CHECK" = "1" ] && SELF_UPDATE=0
[ "$DRY" = "1" ] && SELF_UPDATE=0
[ "${MYAI_UPGRADE_NPM:-1}" = "0" ] && SELF_UPDATE=0

say() { [ "$QUIET" = "1" ] || echo "$@"; }

# A python3 interpreter runs the migration engine (read-modify-write JSON + git).
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "✗ myai upgrade: python3 not found — required for schema migrations" >&2
  exit 1
fi
if [ ! -f "$MIGRATOR" ]; then
  echo "✗ myai upgrade: missing migrator $MIGRATOR" >&2
  exit 1
fi

# ── phase 0: brain safety — resolve, snapshot BEFORE npm, verify after ─────────
# Messages go to stderr under --json so stdout stays one JSON object.
note() { if [ "$JSON" = "1" ]; then echo "$@" >&2; else say "$@"; fi; }
HOME_DIR="$(brain_home)"
BRAIN="$(brain_dir)"
ptr="$HOME_DIR/brain.path"
if [ -z "${MYAI_BRAIN_DIR:-}" ] && [ -f "$ptr" ] && [ ! -d "$BRAIN" ]; then
  echo "✗ myai upgrade: $ptr points at $BRAIN, which does not exist." >&2
  echo "  Your brain was moved or restored elsewhere. Fix the pointer (or set MYAI_BRAIN_DIR) and re-run — not upgrading without it." >&2
  exit 3
fi
if [ -n "${MYAI_BRAIN_DIR:-}" ] && [ ! -d "$BRAIN" ]; then
  note "⚠ MYAI_BRAIN_DIR=$BRAIN does not exist — treating this host as having no brain yet"
fi

brain_atoms() { git -C "$1" ls-files 2>/dev/null | grep -c '\.md$' || true; }
SNAP="" BEFORE_HEAD="" BEFORE_BRANCH="" BEFORE_ATOMS=0
if [ -d "$BRAIN/.git" ] && git -C "$BRAIN" rev-parse --verify -q HEAD >/dev/null 2>&1; then
  BEFORE_HEAD="$(git -C "$BRAIN" rev-parse HEAD)"
  BEFORE_BRANCH="$(git -C "$BRAIN" symbolic-ref -q --short HEAD || true)"
  BEFORE_ATOMS="$(brain_atoms "$BRAIN")"
  if [ "$CHECK" = "1" ] || [ "$DRY" = "1" ]; then
    note "→ Brain: $BRAIN @ ${BEFORE_HEAD:0:8} ($BEFORE_ATOMS atoms) — a real run snapshots it to $HOME_DIR/backups/ first"
  else
    mkdir -p "$HOME_DIR/backups"
    SNAP="$HOME_DIR/backups/brain-$(date -u +%Y%m%dT%H%M%SZ).bundle"
    if ! git -C "$BRAIN" bundle create "$SNAP" --all >/dev/null 2>&1 || ! git -C "$BRAIN" bundle verify "$SNAP" >/dev/null 2>&1; then
      echo "✗ myai upgrade: could not write a verified brain snapshot to $SNAP — not upgrading" >&2
      rm -f "$SNAP"
      exit 1
    fi
    note "✓ Brain snapshot: $SNAP"
    note "  ($BRAIN @ ${BEFORE_HEAD:0:8}, $BEFORE_ATOMS atoms — restore with: git clone \"$SNAP\" <dir>)"
    # keep the newest 3 snapshots
    # (names carry a UTC timestamp, so a reverse name sort is newest-first)
    find "$HOME_DIR/backups" -maxdepth 1 -name 'brain-*.bundle' 2>/dev/null | sort -r | tail -n +4 \
      | while IFS= read -r old; do rm -f "$old"; done
    [ -n "$(git -C "$BRAIN" status --porcelain 2>/dev/null)" ] && note "⚠ the brain has uncommitted changes — they are NOT in the snapshot"
  fi
fi

# verify_brain → 0 when the brain still holds everything it held before.
verify_brain() {
  git -C "$BRAIN" rev-parse --verify -q HEAD >/dev/null 2>&1 || { echo "HEAD does not resolve"; return 1; }
  git -C "$BRAIN" merge-base --is-ancestor "$BEFORE_HEAD" HEAD 2>/dev/null || { echo "history no longer contains ${BEFORE_HEAD:0:8}"; return 1; }
  local atoms; atoms="$(brain_atoms "$BRAIN")"
  [ "$atoms" -ge "$BEFORE_ATOMS" ] || { echo "atoms dropped from $BEFORE_ATOMS to $atoms"; return 1; }
  git -C "$BRAIN" fsck --connectivity-only --no-progress >/dev/null 2>&1 || { echo "git fsck failed"; return 1; }
  return 0
}

# restore_brain → put the brain back exactly at BEFORE_HEAD from the snapshot.
restore_brain() {
  if git -C "$BRAIN" rev-parse --git-dir >/dev/null 2>&1; then
    # Fetch into a private namespace: git refuses to fetch into the checked-out
    # branch, and a rewrite + gc can have pruned the old objects — the bundle
    # must bring them back, and a failure must be seen, not swallowed.
    git -C "$BRAIN" fetch -q --force "$SNAP" '+refs/heads/*:refs/myai-restore/*' || return 1
    git -C "$BRAIN" cat-file -e "$BEFORE_HEAD^{commit}" 2>/dev/null || return 1
  else
    mv "$BRAIN" "$BRAIN.broken-$(date -u +%Y%m%dT%H%M%SZ)"
    git clone -q "$SNAP" "$BRAIN" || return 1
  fi
  if [ -n "$BEFORE_BRANCH" ]; then
    git -C "$BRAIN" checkout -q -f "$BEFORE_BRANCH" 2>/dev/null || git -C "$BRAIN" checkout -q -f -B "$BEFORE_BRANCH" "$BEFORE_HEAD" || return 1
  fi
  git -C "$BRAIN" reset -q --hard "$BEFORE_HEAD" || return 1
  git -C "$BRAIN" for-each-ref --format='%(refname)' refs/myai-restore/ | while IFS= read -r ref; do
    git -C "$BRAIN" update-ref -d "$ref"
  done
  [ "$(git -C "$BRAIN" rev-parse HEAD)" = "$BEFORE_HEAD" ]
}

# ── phase 1: self-update the global package ─────────────────────────────────────
if [ "$SELF_UPDATE" = "1" ] && [ "$JSON" != "1" ]; then
  if command -v npm >/dev/null 2>&1; then
    say "→ Self-update: npm update -g $PKG_NAME"
    if npm update -g "$PKG_NAME" >/dev/null 2>&1; then
      ver="$(npm ls -g "$PKG_NAME" --depth=0 2>/dev/null | grep -oE "$PKG_NAME@[0-9][^ ]*" | head -1)"
      say "✓ CLI up to date${ver:+ ($ver)}"
    else
      say "⚠ npm self-update failed (offline, or not a global install) — continuing with migrations"
    fi
  else
    say "⚠ npm not on PATH — skipping self-update, continuing with migrations"
  fi
elif [ "$JSON" != "1" ]; then
  say "→ Self-update: skipped ($([ "$CHECK" = 1 ] && echo --check || { [ "$DRY" = 1 ] && echo --dry-run || echo disabled; }))"
fi

# ── phase 2: schema migrations (config + brain), idempotent ─────────────────────
HOME_DIR="$(brain_home)"
BRAIN="$(brain_dir)"
[ -d "$BRAIN" ] || BRAIN=""   # empty = "no brain" to the migrator

mode_flag=""
[ "$CHECK" = "1" ] && mode_flag="--check"
[ "$DRY" = "1" ] && mode_flag="--dry-run"

# ── phase 2a: record the runner's profile in runner.conf (G6 P3a) — detect, never hard-code; stderr keeps --json clean.
#     runner.conf is per-USER (~/.myai or $MYAI_USER_DIR), never under the brain
#     home / MYAI_HOME, which can be the framework checkout.
[ -f "$HERE/lib/runner_profile_detect.sh" ] && { bash "$HERE/lib/runner_profile_detect.sh" $mode_flag >&2 || true; }

# ── phase 2b: per-device swarm master (G6) — output to stderr under --json so
#    stdout stays one JSON object. --check: a pending one makes the run exit 20.
sm_rc=0
if [ -f "$HERE/swarm_master_set.sh" ]; then
  if [ "$JSON" = "1" ]; then
    SWARM_DIR="${SWARM_DIR:-$HOME_DIR/swarm}" bash "$HERE/swarm_master_set.sh" migrate $mode_flag >&2
    sm_rc=$?
  else
    sm_out="$(SWARM_DIR="${SWARM_DIR:-$HOME_DIR/swarm}" bash "$HERE/swarm_master_set.sh" migrate $mode_flag 2>&1)"
    sm_rc=$?
    say "$sm_out"
  fi
fi

set -- "$MIGRATOR" --home "$HOME_DIR" ${BRAIN:+--brain "$BRAIN"} $mode_flag
[ "$JSON" = "1" ] && set -- "$@" --json

if [ "$JSON" = "1" ]; then
  "$PY" "$@"
  rc=$?
else
  say ""
  "$PY" "$@"
  rc=$?
fi
# A pending swarm-master migration counts as pending under --check (exit 20);
# a failed one fails a run whose schema migrations passed.
if [ "$rc" = 0 ] && [ "$sm_rc" != 0 ]; then
  if [ "$sm_rc" = 20 ]; then rc=20; else rc=1; fi
fi

# ── post-check: the brain must still hold everything it held before ───────────
if [ -n "$SNAP" ]; then
  if why="$(verify_brain)"; then
    note "✓ Brain verified after upgrade ($(brain_atoms "$BRAIN") atoms, @ $(git -C "$BRAIN" rev-parse --short=8 HEAD))"
  else
    echo "✗ myai upgrade: the brain failed verification after upgrading — $why" >&2
    if restore_brain; then
      echo "  Restored $BRAIN to ${BEFORE_HEAD:0:8} from $SNAP. Nothing was lost; please report this upgrade failure." >&2
    else
      echo "  Automatic restore FAILED. Your snapshot is safe at $SNAP — restore with: git clone \"$SNAP\" <dir>" >&2
    fi
    exit 4
  fi
fi
exit $rc
