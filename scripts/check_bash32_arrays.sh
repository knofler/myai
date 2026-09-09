#!/usr/bin/env bash
# check_bash32_arrays.sh — static gate: an array that can be empty must not be
# expanded as "${NAME[@]}" unguarded in a `set -u` script (bash-3.2
# array-safety bug class; fixed fleet-wide 3x already: d49145f2, 773028eb,
# 6911067f).
#
# WHY: macOS ships bash 3.2 as /bin/bash (GPLv3 licensing freeze), and any
# bash before 4.4 throws "unbound variable" expanding "${arr[@]}" when arr has
# zero elements — even though it *is* declared, not unset. This has bitten the
# fleet three separate times (installer, myai_release.sh, myai setup
# --machine), always the same shape: an array declared empty (`NAME=()`),
# conditionally appended to, then expanded unguarded later in the same
# script. Every fix used one of two idioms, both of which this gate accepts
# as sufficient proof the file is safe:
#   1. ${arr[@]+"${arr[@]}"}   — expands to nothing when arr is empty
#   2. a length check ("${#arr[@]}" ...) anywhere in the file before relying
#      on unguarded "${arr[@]}" expansions later (this repo's own
#      local-ci.sh CONTEXTS pattern, and check_shellcheck.sh's FILES pattern)
#
# This is a heuristic, not real data-flow analysis — same trade-off as
# check_stat_ordering.sh: fast, dependency-free, aimed at the exact incidents
# that actually happened rather than full soundness. Whatever residual noise
# it has on today's tree is absorbed by the baseline
# (scripts/ci/bash32-arrays-baseline.txt), same mechanism as
# check_shellcheck.sh — this gate blocks NEW unguarded expansions, not every
# pre-existing one.
#
# Run by:
#   - scripts/local-ci.sh (CRITICAL gate — fails the run regardless of contexts)
#   - .github/workflows/script-unit-tests.yml (`static-lint` job)
#   - scripts/tests/test_check_bash32_arrays.sh (fixture-driven unit test)
#
# Usage: ./scripts/check_bash32_arrays.sh [--repo <path>] [--update-baseline]
# Exit codes: 0 pass, 1 new unguarded empty-array expansion found (BLOCKS),
#             2 skip (not a git repo)

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
BASELINE="$REPO_ROOT/scripts/ci/bash32-arrays-baseline.txt"

echo "[Bash 3.2 array safety] empty-array \"\${NAME[@]}\" expansion must be guarded under set -u"
if ! git -C "$REPO_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "  SKIP — $REPO_ROOT is not a git repo"; exit 2
fi

FILES=()
while IFS= read -r f; do
  case "$f" in
    scripts/*.sh|hooks/*.sh) FILES+=("$f") ;;
  esac
done < <(git -C "$REPO_ROOT" ls-files -- '*.sh')

CURRENT=""
for f in "${FILES[@]+"${FILES[@]}"}"; do
  path="$REPO_ROOT/$f"
  [ -f "$path" ] || continue
  # Only files that run under `set -u`/`set -eu*`/`set -o nounset` are at risk.
  grep -qE '^[[:space:]]*set[[:space:]]+(-[a-zA-Z]*u[a-zA-Z]*([[:space:]]|$)|-o[[:space:]]+nounset([[:space:]]|$))' "$path" \
    || continue

  # Candidate arrays: declared as an empty literal somewhere in the file
  # (plain, `local`, or `declare -a` — all end in the literal token `NAME=()`).
  names="$(grep -oE '(^|[[:space:]])[A-Za-z_][A-Za-z0-9_]*=\(\)' "$path" \
    | sed -E 's/^[[:space:]]*//; s/=\(\)$//' | sort -u)"
  [ -z "$names" ] && continue

  while IFS= read -r name; do
    [ -z "$name" ] && continue
    # A length-guard anywhere in the file is treated as sufficient proof the
    # author already reasoned about the empty case (this repo's own pattern).
    if grep -qE '\$\{#'"$name"'\[@\]\}' "$path"; then continue; fi
    # Unguarded expansions: ${name[@]} NOT using the ${name[@]+...} idiom.
    risky="$(grep -nE '\$\{'"$name"'\[@\]\}' "$path" | grep -vE '\$\{'"$name"'\[@\]\+')"
    [ -z "$risky" ] && continue
    while IFS=: read -r lineno _rest; do
      [ -z "$lineno" ] && continue
      CURRENT="${CURRENT}${f}:${name}:${lineno}"$'\n'
    done <<EOF_RISKY
$risky
EOF_RISKY
  done <<EOF_NAMES
$names
EOF_NAMES
done
CURRENT="$(printf '%s' "$CURRENT" | sed '/^$/d' | sort -u)"

if [ "$UPDATE_BASELINE" = 1 ]; then
  mkdir -p "$(dirname "$BASELINE")"
  printf '%s\n' "$CURRENT" | sed '/^$/d' > "$BASELINE"
  echo "  baseline updated: $BASELINE ($(printf '%s\n' "$CURRENT" | sed '/^$/d' | wc -l | tr -d ' ') hit(s))"
  exit 0
fi

BASELINE_SET=""
[ -f "$BASELINE" ] && BASELINE_SET="$(sort -u "$BASELINE")"

NEW="$(comm -23 <(printf '%s\n' "$CURRENT" | sed '/^$/d') <(printf '%s\n' "$BASELINE_SET" | sed '/^$/d'))"

echo "  $(printf '%s\n' "$CURRENT" | sed '/^$/d' | wc -l | tr -d ' ') candidate hit(s); $(printf '%s\n' "$BASELINE_SET" | sed '/^$/d' | wc -l | tr -d ' ') baselined"

if [ -n "$NEW" ]; then
  echo "  FAIL — unguarded empty-array expansion(s) not in baseline:"
  while IFS=: read -r file name lineno; do
    [ -z "$file" ] && continue
    echo "    $file:$lineno  \${$name[@]} — array can be empty under set -u (bash 3.2 'unbound variable' crash)"
    echo "      fix: \${${name}[@]+\"\${${name}[@]}\"}   OR guard with [ \"\${#${name}[@]}\" -gt 0 ] first"
  done <<EOF_NEW
$NEW
EOF_NEW
  echo "  If this is a deliberate/pre-existing pattern, run:"
  echo "    ./scripts/check_bash32_arrays.sh --update-baseline"
  exit 1
fi

echo "  OK — no new unguarded empty-array expansions beyond the baseline."
exit 0
