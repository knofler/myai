#!/usr/bin/env bash
# myai_upgrade.sh — self-update the global CLI + run pending schema migrations (`myai upgrade`).
#
#   myai upgrade [--check] [--dry-run] [--no-self-update] [--json] [--quiet]
#       Two phases, in order:
#         1. self-update  — `npm update -g ai-management` so the globally
#                           installed CLI matches the latest published version.
#         2. migrate      — bring on-disk state up to the framework's current
#                           schema (idempotent): the $MYAI_HOME/config file and
#                           the git-versioned brain layout. Safe to run repeatedly.
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
MIGRATOR="$HERE/lib/myai_migrate.py"

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

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; }

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

set -- "$MIGRATOR" --home "$HOME_DIR" ${BRAIN:+--brain "$BRAIN"} $mode_flag
[ "$JSON" = "1" ] && set -- "$@" --json

if [ "$JSON" = "1" ]; then
  "$PY" "$@"
  exit $?
fi

say ""
"$PY" "$@"
rc=$?
exit $rc
