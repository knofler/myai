#!/usr/bin/env bash
# check_stat_ordering.sh — static gate: `stat` fallback chains must be
# GNU-first, never BSD-first (AI_RULES §4, MANDATORY).
#
# WHY: a failing GNU `stat -c ... || stat -f ...` chain fails over cleanly on
# Linux (GNU stat errors to stderr on unknown `-c` usage... no — the actual
# bug is the reverse: BSD-first `stat -f FMT file || stat -c FMT file` is
# broken on Linux because GNU's `-f` means `--file-system` (a boolean flag,
# not "format"). `stat -f '%m' "$f"` on Linux SUCCEEDS — it treats '%m' as a
# bogus extra file operand (error to stderr, but stat -f itself still exits
# 0 and prints a mount-point/filesystem line to stdout) — so the `||` never
# fires and the captured value is garbage instead of the mtime. This is a
# SILENT CORRUPTION bug, not a clean failure, which is what makes it so easy
# to miss in review and so damaging in CI (473a19a; recurred again in
# machine_selfheal.sh / test_myai_login.sh, see commit b5a6a8bd). The fix is
# always the same: GNU form (`-c`) must be attempted FIRST in the `||` chain.
#
# This gate scans every tracked shell script for a `stat -f ... || stat -c`
# ordering on the same line/statement and fails the build if one is found —
# so the ordering documented in AI_RULES §4 cannot silently regress again.
#
# Run by:
#   - scripts/local-ci.sh (CRITICAL gate — fails the run regardless of contexts)
#   - scripts/tests/test_check_stat_ordering.sh, exercised via
#     scripts/tests/run_all.sh in .github/workflows/script-unit-tests.yml
#
# Usage: ./scripts/check_stat_ordering.sh [--repo <path>]
# Exit codes: 0 pass, 1 BSD-first ordering found (BLOCKS), 2 skip (not a git repo)

set -uo pipefail

REPO_ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_ROOT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

echo "[Stat Ordering] fallback chains must try GNU 'stat -c' before BSD 'stat -f'"
if ! git -C "$REPO_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "  SKIP — $REPO_ROOT is not a git repo"; exit 2
fi

# Self-exclude: this file and its test document/exercise the anti-pattern in
# prose/fixtures and would otherwise false-positive on themselves.
SELF="scripts/check_stat_ordering.sh"
SELF_TEST="scripts/tests/test_check_stat_ordering.sh"

VIOLATIONS=""
while IFS= read -r f; do
  [ "$f" = "$SELF" ] && continue
  [ "$f" = "$SELF_TEST" ] && continue
  # Skip pure-comment lines (leading '#' after optional whitespace) so this
  # gate's own explanatory prose about the anti-pattern doesn't self-match.
  hits="$(grep -nE '^[[:space:]]*[^#[:space:]].*stat[[:space:]]+-f.*\|\|.*stat[[:space:]]+-c' "$REPO_ROOT/$f" 2>/dev/null || true)"
  [ -z "$hits" ] && continue
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    VIOLATIONS="${VIOLATIONS}${f}:${hit}"$'\n'
  done <<EOF_HITS
$hits
EOF_HITS
done < <(git -C "$REPO_ROOT" ls-files -- '*.sh')

if [ -n "$VIOLATIONS" ]; then
  echo "  FAIL — BSD-first 'stat -f ... || stat -c ...' ordering found:"
  echo "$VIOLATIONS" | sed 's/^/    /'
  echo "  Fix: swap to 'stat -c ... 2>/dev/null || stat -f ... 2>/dev/null' (GNU first, AI_RULES §4)."
  exit 1
fi

echo "  OK — no BSD-first stat orderings found."
exit 0
