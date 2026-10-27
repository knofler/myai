#!/usr/bin/env bash
# scripts/lib/gh_list.sh — SOURCE-ONLY. Safe wrappers around `gh` list/search
# commands that REFUSE to act on a silently TRUNCATED result set.
#
# WHY THIS EXISTS (MYTHOS Track-1 — "a guard that cannot run must say so",
# applied to TOOLING rather than hooks):
#   `gh pr list`, `gh issue list` and `gh search *` default to a 30-item page
#   and give NO indication they truncated. Any COUNT or BULK ACTION taken
#   against that partial set is silently wrong — it fails in exactly the same
#   way as a guard that silently passes. Measured 2026-09-04: one fleet repo had
#   41 open PRs; the first query returned 26, and two rounds of PR cleanup were
#   planned against that partial set before the cap was noticed (a third round
#   was needed once `--limit 200` revealed PRs #2–#11).
#
# CONTRACT:
#   * Every wrapper requests up to GH_LIST_LIMIT items (default 1000) instead
#     of the silent 30 — so real-world repos come back COMPLETE.
#   * If the returned count EQUALS the limit, the wrapper FAILS LOUDLY (message
#     on stderr, exit GH_LIST_TRUNCATED=3) instead of handing back a possibly
#     truncated set. `count == limit` is the truncation tell: you asked for N,
#     got exactly N, so an N+1th may exist that you cannot see. Callers get
#     either the COMPLETE set or a HARD ERROR — never a quiet partial.
#   * `gh api` LIST endpoints (arrays / {…,items:[]}) have a complete-by-
#     construction fix: `--paginate` follows Link headers to the last page.
#     Use gh_api_list() for that, or add `--paginate` inline.
#
# USAGE:
#   source "$(cd "$(dirname "$0")" && pwd)/lib/gh_list.sh"
#   prs="$(gh_pr_list --state open --json number,title)" || exit   # complete or dies
#   n="$(printf '%s' "$prs" | gh_list_count)"
#   # calls that must run behind `timeout` (which wraps a binary, not a shell
#   # function) request the limit inline and guard the count after:
#   raw="$(timeout 20 gh pr list --limit "$(gh_list_limit)" --state open --json number)"
#   gh_list_guard "$(printf '%s' "$raw" | gh_list_count)" "open PRs in $repo" || : # handle
#
# NOTE: the list wrappers require the caller to pass `--json …` — truncation is
# detected by counting JSON array elements. Table output cannot be counted
# reliably and disables the equality check.
#
# This file is sourced; it deliberately sets no shell options (the caller owns
# `set -e`/`set -u`). Every function is self-contained and safe under either.

# Exit code a wrapper/guard returns when it suspects truncation.
GH_LIST_TRUNCATED=3

# gh_list_limit — the effective per-call cap (override with GH_LIST_LIMIT).
gh_list_limit() { printf '%s' "${GH_LIST_LIMIT:-1000}"; }

# gh_list_count — read a JSON array on stdin, print its element count.
# Prefers jq; falls back to python3. Non-array / unparseable input → 0.
gh_list_count() {
  if command -v jq >/dev/null 2>&1; then
    jq 'if type=="array" then length else 0 end' 2>/dev/null || printf '0'
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
    print(len(d) if isinstance(d,list) else 0)
except Exception:
    print(0)' 2>/dev/null || printf '0'
  else
    printf '0'
  fi
}

# gh_list_guard <count> <label> — return GH_LIST_TRUNCATED (loud) if count has
# reached the limit (== the truncation tell), else 0. Reusable for callers that
# invoke gh directly (e.g. behind `timeout`).
gh_list_guard() {
  local count="${1:-0}" label="${2:-gh list}" limit
  limit="$(gh_list_limit)"
  case "$count" in ''|*[!0-9]*) count=0 ;; esac
  if [ "$count" -ge "$limit" ]; then
    {
      printf 'gh_list: FATAL — %s returned %s item(s) == GH_LIST_LIMIT (%s).\n' "$label" "$count" "$limit"
      printf 'gh_list:   The result set is CAPPED and may be TRUNCATED. Refusing to act on a\n'
      printf 'gh_list:   partial set (a count or bulk action here would be silently wrong).\n'
      printf 'gh_list:   Re-run with a higher GH_LIST_LIMIT and confirm the count drops below it.\n'
    } >&2
    return "$GH_LIST_TRUNCATED"
  fi
  return 0
}

# _gh_list_run <count-label> <gh> <subcommand...> -- <args...>
# Internal: run a gh list-style command with --limit injected, count the JSON
# result, guard it, then emit the JSON on success.
_gh_list_wrap() {
  local label="$1"; shift
  local out rc n
  out="$("$@" --limit "$(gh_list_limit)")" ; rc=$?
  if [ "$rc" -ne 0 ]; then
    # Surface gh's own failure; do NOT pass a partial off as data.
    printf '%s' "$out"
    return "$rc"
  fi
  n="$(printf '%s' "$out" | gh_list_count)"
  gh_list_guard "$n" "$label" || return "$GH_LIST_TRUNCATED"
  printf '%s' "$out"
}

# gh_pr_list <args...>   — pass --json …; emits complete JSON array or dies loud.
gh_pr_list()    { _gh_list_wrap "gh pr list $*"    gh pr list "$@"; }

# gh_issue_list <args...> — pass --json …; emits complete JSON array or dies loud.
gh_issue_list() { _gh_list_wrap "gh issue list $*" gh issue list "$@"; }

# gh_search <prs|issues|repos|…> <args...> — pass --json …; complete or dies loud.
gh_search() {
  local sub="$1"; shift
  _gh_list_wrap "gh search $sub $*" gh search "$sub" "$@"
}

# gh_api_list <endpoint> <args...> — `gh api --paginate <endpoint> …`. Complete
# by construction (follows Link headers). Use for array / {…,items:[]} list
# endpoints where the default 30-item page would truncate.
gh_api_list() { gh api --paginate "$@"; }
