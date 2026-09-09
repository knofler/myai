#!/usr/bin/env bash
# check_shellcheck.sh — shellcheck gate over every tracked scripts/*.sh and
# hooks/*.sh, baseline-suppressed so it lands green on day one.
#
# WHY: 480+ tracked shell scripts already sprinkle `# shellcheck disable=...`
# pragmas (scripts/local-ci.sh, scripts/betac_up.sh, scripts/lib/brain.sh, ...)
# yet no CI workflow ever actually ran shellcheck — the pragmas were written
# on faith, never verified. Fixing ~1000 pre-existing findings before this can
# land is out of scope for one task, so this gate snapshots the current state
# as a baseline (scripts/ci/shellcheck-baseline.txt, one "path:SCcode" per
# unique pair) and fails ONLY on a (file, code) pair that is NOT in that
# baseline — a brand-new warning class in a file, or the same warning class
# appearing for the first time in a file that didn't have it before. It does
# NOT re-count repeated instances of an already-baselined pair in the same
# file (line-number-based baselining churns on every unrelated edit; this
# repo's other static gates — check_stat_ordering.sh, check_tracked_hygiene.sh
# — use the same "flag the new, ignore the known" shape).
#
# Regenerate the baseline after a deliberate cleanup pass:
#   ./scripts/check_shellcheck.sh --update-baseline
#
# Run by:
#   - scripts/local-ci.sh (CRITICAL gate — fails the run regardless of contexts)
#   - .github/workflows/script-unit-tests.yml (`static-lint` job)
#   - scripts/tests/test_check_shellcheck.sh (fixture-driven unit test)
#
# Usage: ./scripts/check_shellcheck.sh [--repo <path>] [--update-baseline]
# Exit codes: 0 pass, 1 new warning(s) found (BLOCKS), 2 skip (no shellcheck
#             binary, or not a git repo)

set -uo pipefail

REPO_ROOT=""
UPDATE_BASELINE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_ROOT="$2"; shift 2 ;;
    --update-baseline) UPDATE_BASELINE=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
BASELINE="$REPO_ROOT/scripts/ci/shellcheck-baseline.txt"

echo "[Shellcheck] static analysis over tracked scripts/*.sh and hooks/*.sh"

if ! command -v shellcheck >/dev/null 2>&1; then
  echo "  SKIP — shellcheck not installed (brew install shellcheck)"; exit 2
fi
if ! git -C "$REPO_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "  SKIP — $REPO_ROOT is not a git repo"; exit 2
fi

FILES=()
while IFS= read -r f; do
  case "$f" in
    scripts/*.sh|hooks/*.sh) FILES+=("$f") ;;
  esac
done < <(git -C "$REPO_ROOT" ls-files -- '*.sh')

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "  SKIP — no tracked *.sh files under scripts/ or hooks/"; exit 2
fi

# gcc format: "path:line:col: severity: message [SCxxxx]" — easy to reduce to
# the (path, code) pair the baseline keys on. `-x` follows `source`d files so
# SC1090/SC1091 findings resolve where possible instead of every dynamic
# `source` guess triggering a "not following" note.
RAW="$(cd "$REPO_ROOT" && shellcheck -f gcc -x "${FILES[@]}" 2>&1 || true)"

# Reduce each "path:line:col: severity: message [SCxxxx]" line to its
# "path:SCxxxx" key, one line at a time (a path can itself contain ':' on
# some filesystems, so a single awk -F: split is not safe).
CURRENT=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  code="$(printf '%s' "$line" | grep -oE '\[SC[0-9]+\]$' | tr -d '[]')"
  [ -z "$code" ] && continue
  path="${line%%:*}"
  CURRENT="${CURRENT}${path}:${code}"$'\n'
done <<EOF_RAW
$RAW
EOF_RAW
CURRENT="$(printf '%s' "$CURRENT" | sort -u)"

if [ "$UPDATE_BASELINE" = 1 ]; then
  mkdir -p "$(dirname "$BASELINE")"
  printf '%s\n' "$CURRENT" | sed '/^$/d' > "$BASELINE"
  echo "  baseline updated: $BASELINE ($(wc -l < "$BASELINE" | tr -d ' ') pair(s))"
  exit 0
fi

BASELINE_SET=""
if [ -f "$BASELINE" ]; then
  BASELINE_SET="$(sort -u "$BASELINE")"
fi

NEW="$(comm -23 <(printf '%s\n' "$CURRENT" | sed '/^$/d') <(printf '%s\n' "$BASELINE_SET" | sed '/^$/d'))"

TOTAL_FINDINGS="$(printf '%s\n' "$RAW" | grep -cE '\[SC[0-9]+\]$' || true)"
echo "  $TOTAL_FINDINGS finding(s) across ${#FILES[@]} file(s); $(printf '%s\n' "$BASELINE_SET" | sed '/^$/d' | wc -l | tr -d ' ') baselined (file,code) pair(s)"

if [ -n "$NEW" ]; then
  echo "  FAIL — new shellcheck finding(s) not in baseline:"
  while IFS=: read -r path code; do
    [ -z "$path" ] && continue
    echo "    $path  [$code]"
    printf '%s\n' "$RAW" | grep -F "$path:" | grep -F "[$code]" | sed 's/^/      /'
  done <<EOF_NEW
$NEW
EOF_NEW
  echo "  Fix the warning, or if it's a deliberate/pre-existing pattern being"
  echo "  newly baselined, run: ./scripts/check_shellcheck.sh --update-baseline"
  exit 1
fi

echo "  OK — no new shellcheck findings beyond the baseline."
exit 0
