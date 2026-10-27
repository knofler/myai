#!/usr/bin/env bash
# claim.sh — the `claim` keyword: claim a file or directory before working on
# it (plan/SWARM_COORDINATOR_PLAN.md row 5, spec §5b). Library:
# scripts/lib/claims.sh (key claim:<repo-id>:<relpath>, holder
# <host>/<lane>/<session-pid>, TTL 1800s renewed by `swarm_master.sh tick`).
#
# Usage:
#   claim.sh take <path> [--note "…"]   claim it (a directory — trailing "/" or an
#                                       existing dir — covers everything under it).
#                                       Overlap with another session's claim →
#                                       refused (exit 1), heldBy printed, and ONE
#                                       mail per path per hour to the holder's
#                                       lane + the coordinator: "propose split /
#                                       sequence / handover".
#   claim.sh release <path> [--force]   release this session's claim; --force is
#                                       the coordinator override (any holder).
#   claim.sh list [--all]               valid claims in this repo (all repos: --all)
#   claim.sh check <path>               exit 1 + the holder when another session
#                                       holds the path or a parent/child dir;
#                                       0 free or ours; 2 not claimable; 3 gateway
#                                       down.
#
# Claims are advisory and the edit hook only WARNS (hooks/pre-tool/04). Run from
# inside a claude/agy session (the holder is the session pid).
# bash 3.2-safe; safe under `set -euo pipefail`. CLAIM_LIB_ONLY=1 to source.
set -u

CLAIM_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=/dev/null
. "$CLAIM_HERE/lib/claims.sh"

claim_main() {
  local verb="${1:-list}" path="" note="" force="" all=0
  shift || true
  while [ $# -gt 0 ]; do
    case "$1" in
      --note) [ $# -ge 2 ] || { echo "claim: --note needs a value" >&2; return 2; }; note="$2"; shift 2 ;;
      --force) force=--force; shift ;;
      --all) all=1; shift ;;
      -*) echo "claim: unknown flag $1" >&2; return 2 ;;
      *) path="$1"; shift ;;
    esac
  done
  case "$verb" in
    take|release|check)
      [ -n "$path" ] || { echo "usage: claim.sh $verb <path>" >&2; return 2; } ;;
  esac
  case "$verb" in
    take)
      if [ -n "$force" ]; then echo "claim: take has no --force — ask the holder, or the coordinator runs: claim release <path> --force" >&2; return 2; fi
      cl_take "$path" "$note" ;;
    release) cl_release "$path" "$force" ;;
    check) cl_check "$path" ;;
    list)
      local repo="" rc
      if [ "$all" = 0 ]; then
        if cl_resolve "$(pwd)/.claim-probe" 2>/dev/null; then repo="$CL_REPO_ID"; fi
      fi
      echo "claims${repo:+ in $repo} on $(kl_host):"
      cl_list_repo "$repo"; rc=$?
      if [ "$rc" != 0 ]; then echo "  (gateway unreachable)"; return 3; fi
      return 0 ;;
    -h|--help|help) sed -n '2,26p' "$CLAIM_HERE/claim.sh" | sed 's/^# \{0,1\}//' ;;
    *) echo "claim: unknown verb '$verb' (take | release | list | check)" >&2; return 2 ;;
  esac
}

[ -n "${CLAIM_LIB_ONLY:-}" ] && return 0
claim_main "$@"
