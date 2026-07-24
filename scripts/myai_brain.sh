#!/usr/bin/env bash
# myai_brain.sh — CLI surface for the Brain store (git-versioned agent memory).
# Thin dispatcher over scripts/lib/brain.sh (the single source of truth);
# `myai brain <cmd>` lands here via bin/myai.cjs. See plan/jam/brain-layer.md.
#
#   myai brain init [path] [--remote <url>]   create/adopt the brain repo (no local dir + remote → clone)
#   myai brain status                          where it lives, branch, atoms, stashes
#   myai brain health                          composite health score (0-100) + trend
#   myai brain write <kind> <repo|-> <slug>    append one immutable atom (stdin)
#   myai brain stash <slug> [repo]             freeze context on main (stdin) — resume anywhere
#   myai brain stash list                      stashes waiting on main, newest first
#   myai brain pop [slug]                      print + remove the newest (matching) stash
#   myai brain branch <slug>                   idea/<slug> parallel-thought branch (alias: idea)
#   myai brain checkout <ref>                  switch to main | session/* | idea/*
#   myai brain merge [branch]                  merge session/idea → main + distill (wrap up)
#   myai brain session start [profile]         session/<date>-<host>-<profile>
#   myai brain session merge [branch]          same as `merge`
#   myai brain log [n]                         recent brain commits (default 10)
#   myai brain diff [from] [to]                what <to> adds over <from> (default main..HEAD)
#   myai brain search <query…> [--repo r] [--k N] [--since d] [--json]
#                                               federated semantic search: atoms + session
#                                               corpus, ranked together (needs the gateway —
#                                               the ONE brain subcommand that isn't local-git-only)
#   myai brain distill [ns …]                  recompile brief/working/rollup on main
#   myai brain blame <code-sha|brain-ref>      code↔memory provenance, both directions
#   myai brain revert <sha>                    undo a commit with an inverse commit
#   myai brain gc [--dry-run] [--stash-age N]  compact: dedup atoms, prune orphans/old stashes, repack
#   myai brain dream [--dry-run] [--sim-threshold N] [--min-keep-ratio N]
#                                               idle consolidation: near-dup supersedes + blue-green
#                                               recompile of brief/working/rollup (BRAIN B5)
#   myai brain stamp <code-dir> <repo> <slug> [sha…]  stamp session atom + git notes (stdin)
#
# `merge` auto-runs the distiller (compile-at-write, BRAIN B3) — `distill` is
# the manual/backfill form. Gateway mirror: brain_* MCP tools. Scripted
# walkthrough: TRY_BRAIN.md.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/brain.sh
. "$HERE/lib/brain.sh"
# search is the one subcommand that calls the gateway (Mongo vector recall
# lives there, not in the local git store) — same token-resolution lib every
# other host→gateway script uses.
# shellcheck source=lib/gateway.sh
. "$HERE/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3100}"

usage() { sed -n '6,30p' "$0" | sed 's/^# \{0,3\}//'; }

cmd_search() {
  local repo="" k="" since="" json=0
  local words=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo)  shift; repo="${1:?--repo needs a value}" ;;
      --k)     shift; k="${1:?--k needs a value}" ;;
      --since) shift; since="${1:?--since needs a value}" ;;
      --json)  json=1 ;;
      -h|--help)
        echo "myai brain search <query…> [--repo r] [--k N] [--since date] [--json]"; return 0 ;;
      -*) echo "myai brain search: unknown flag $1" >&2; return 2 ;;
      *) words+=("$1") ;;
    esac
    shift
  done
  local query="${words[*]:-}"
  [ -n "$query" ] || {
    echo "myai brain search: query required" >&2
    echo "usage: myai brain search <query…> [--repo r] [--k N] [--since date] [--json]" >&2
    return 2
  }

  command -v curl >/dev/null 2>&1 || { echo "myai brain search: curl is required" >&2; return 3; }
  command -v jq   >/dev/null 2>&1 || { echo "myai brain search: jq is required" >&2; return 3; }

  curl -sf -o /dev/null "$GATEWAY_URL/health" 2>/dev/null || {
    echo "✗ Gateway not reachable at $GATEWAY_URL — run 'myai up' first." >&2
    return 1
  }

  local qs; qs="query=$(jq -rn --arg v "$query" '$v|@uri')"
  [ -n "$repo" ]  && qs="${qs}&repo=$(jq -rn --arg v "$repo" '$v|@uri')"
  [ -n "$k" ]     && qs="${qs}&k=$(jq -rn --arg v "$k" '$v|@uri')"
  [ -n "$since" ] && qs="${qs}&since=$(jq -rn --arg v "$since" '$v|@uri')"

  local result
  result=$(curl -sf -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
    "$GATEWAY_URL/api/brain/search?$qs") || {
    echo "✗ Search request failed (check gateway logs)." >&2; return 1
  }

  if printf '%s' "$result" | jq -e 'has("error")' >/dev/null 2>&1; then
    echo "✗ $(printf '%s' "$result" | jq -r '.error')" >&2
    return 1
  fi

  if [ "$json" = "1" ]; then
    printf '%s\n' "$result"
    return 0
  fi

  local count; count=$(printf '%s' "$result" | jq -r '.count')
  if [ -z "$count" ] || [ "$count" = "0" ]; then
    echo "No hits for \"$query\"."
    return 0
  fi

  echo "$count hit(s) for \"$query\" — atoms + session corpus, ranked together:"
  printf '%s' "$result" | jq -r '
    .hits[] |
    "  [\(.kind)\(if .atomKind then "/" + .atomKind elif .source then "/" + .source else "" end)] "
    + (.repo // "-") + "  (score \(.score | tostring))\n    " + .snippet'
}

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  init)     brain_init "$@" ;;
  status)   brain_status ;;
  health)   brain_health_report ;;
  write)    brain_atom_write "$@" ;;
  stash)
    if [ "${1:-}" = "list" ]; then brain_stash_list
    else brain_stash "$@"; fi ;;
  pop)      brain_pop "$@" ;;
  branch|idea) brain_idea "$@" ;;
  checkout) brain_checkout "$@" ;;
  merge)    brain_session_merge "$@" ;;
  session)
    sub="${1:-}"; shift 2>/dev/null || true
    case "$sub" in
      start) brain_session_start "$@" ;;
      merge) brain_session_merge "$@" ;;
      *) echo "myai brain session: expected start|merge (got '${sub:-}')" >&2; exit 2 ;;
    esac ;;
  log)      brain_git log --oneline --graph -n "${1:-10}" ;;
  diff)     brain_diff "$@" ;;
  search)   cmd_search "$@" ;;
  distill)  brain_distill "$@" ;;
  blame)    brain_blame "$@" ;;
  revert)   brain_revert "$@" ;;
  gc)       brain_gc "$@" ;;
  dream)    brain_dream "$@" ;;
  stamp)    brain_stamp_code "$@" ;;
  ''|help|-h|--help) usage ;;
  *) echo "myai brain: unknown command '$cmd'" >&2; usage >&2; exit 2 ;;
esac
