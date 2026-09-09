#!/usr/bin/env bash
# check_gh_list_pagination.sh — HARD static gate: every `gh pr list`,
# `gh issue list` and `gh search <sub>` invocation under scripts/ or hooks/
# MUST pass --limit or --paginate.
#
# WHY (task-39d2bf78, MYTHOS Track-1 applied to TOOLING): `gh pr list` /
# `gh issue list` / `gh search` default to a silent 30-item page and give NO
# signal they truncated. A count or bulk action taken against that partial set
# is silently wrong — a CLI that truncates silently fails exactly like a guard
# that silently passes. Measured 2026-09-04: knofler/app had 41 open PRs; the
# first query returned 26 and two cleanup rounds were planned against it before
# the cap was noticed.
#
# NO BASELINE — unlike check_shellcheck / check_bash32_arrays, this invariant
# admits no legacy exceptions: the tree is clean, and every new caller must be
# bounded from day one. Fix a violation by routing through
# scripts/lib/gh_list.sh (gh_pr_list / gh_issue_list / gh_search), or add
# --limit "$(gh_list_limit)" (or --paginate) inline.
#
# Intentionally NOT flagged: `gh run list --limit N` "latest-N" status widgets
# (they carry --limit already) and `gh api …` (paginate those with --paginate;
# this gate targets the three list/search commands with the documented cap).
#
# Run by: scripts/tests/test_check_gh_list_pagination.sh (fixture-driven, and
# also asserts the real tree is clean, so run_all.sh / script-unit-tests.yml
# enforce the invariant in CI).
#
# Usage: ./scripts/check_gh_list_pagination.sh [--repo <path>]
# Exit codes: 0 clean, 1 un-paginated call found (BLOCKS), 2 not a git repo.
set -uo pipefail

REPO_ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_ROOT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO_ROOT" ] || REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

echo "[gh list pagination] every gh pr/issue list + gh search must pass --limit/--paginate"
if ! git -C "$REPO_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "  SKIP — $REPO_ROOT is not a git repo"; exit 2
fi

viol=0
while IFS= read -r f; do
  case "$f" in
    scripts/lib/gh_list.sh)              continue ;;  # the sanctioned implementation
    scripts/check_gh_list_pagination.sh) continue ;;  # this gate documents the patterns
    scripts/tests/*)                     continue ;;  # fixtures + assertion strings
  esac
  path="$REPO_ROOT/$f"
  [ -f "$path" ] || continue

  # Join backslash line-continuations (so --limit on a wrapped line still
  # counts), skip full-line comments, then flag any gh pr/issue list or
  # gh search that carries neither --limit nor --paginate.
  hits="$(awk '
    {
      line=$0
      while (sub(/\\[[:space:]]*$/,"",line)) { if ((getline nxt) > 0) line=line " " nxt; else break }
      probe=line
      sub(/^[[:space:]]*/,"",probe)
      if (probe ~ /^#/) next
      if (line ~ /gh[[:space:]]+(pr|issue)[[:space:]]+list/ || line ~ /gh[[:space:]]+search[[:space:]]+[a-z]/) {
        if (line !~ /--limit/ && line !~ /--paginate/) { sub(/^[[:space:]]*/,"",line); print NR": "line }
      }
    }' "$path")"

  if [ -n "$hits" ]; then
    while IFS= read -r h; do
      [ -z "$h" ] && continue
      echo "  VIOLATION $f:$h"
      viol=$((viol+1))
    done <<EOF
$hits
EOF
  fi
done < <(git -C "$REPO_ROOT" ls-files -- 'scripts/*.sh' 'hooks/*.sh')

if [ "$viol" -gt 0 ]; then
  echo "  FAIL — $viol un-paginated gh list/search call(s)."
  echo "         Route through scripts/lib/gh_list.sh (gh_pr_list/gh_issue_list/gh_search),"
  echo "         or add --limit \"\$(gh_list_limit)\" / --paginate inline."
  exit 1
fi
echo "  OK — all gh pr/issue list + gh search calls are bounded."
exit 0
