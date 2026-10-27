#!/usr/bin/env bash
# ship_lock.sh — the swarm ship lock (plan/SWARM_COORDINATOR_PLAN.md row 4,
# spec §4): while a swarm is ACTIVE on this Mac, only the coordinator SESSION
# merges. Workers open PRs (gh pr create is never locked — operator option 1)
# and mail the coordinator.
#
# Usage:
#   ship_lock.sh check
#     exit 0 (allow) when
#       • no swarm is active on this Mac (no ~/.myai/swarm/active.<host> marker —
#         written by `swarm master take`, removed by `swarm master stop`): the
#         normal single-session `ship it` is untouched, no gateway call is made;
#       • no VALID coordinator lease exists (`swarm-coordinator:<host>` —
#         active-active, each Mac's coordinator merges for its own agents — or
#         `swarm-coordinator:fleet` under `coordinator_mode fleet`; both are read
#         during a migration, a fleet lease from ANOTHER Mac never counts in
#         active-active — scripts/lib/keyed_lease.sh kl_coord_keys/kl_coord_get);
#       • THIS session holds it — holder "<host>/<lane>/<pid>" with <pid> the
#         claude/agy session pid (_lanes_self_pid); another session of the same
#         lane does NOT count;
#       • SHIP_LOCK_OFF=1 in the session's environment; or
#       • the gateway can't be reached (one-line warning — never brick shipping).
#     exit 1 (refuse) otherwise; the message names the coordinator and says
#       what to do instead.
#   ship_lock.sh is-merge   (command text on stdin)
#     exit 0 when the shell command MERGES a PR: `gh … pr … merge` as command
#     words (any spacing, inside chains with && ; || |), or `gh api` on
#     …/pulls/<n>/merge (or a GraphQL mergePullRequest). Quoted text is data,
#     not a command: `git commit -m "… gh pr merge …"` is not a merge.
#
# Enforced by hooks/pre-tool/01-block-push-main.sh (no .claude/settings.json
# change). Limits: like every hook rail it binds only sessions that run the
# hooks; a hand-run `gh` in a plain terminal, `bash -c "<string>"`, and the
# GitHub MCP server's merge tool (an MCP call, not Bash) are outside it.
# GitHub branch protection stays the real backstop.
#
# bash 3.2-safe; safe under `set -euo pipefail`. Source with SHIP_LOCK_LIB_ONLY=1;
# tests stub kl_call or set MYAI_LEASE_STUB (scripts/lib/keyed_lease.sh).
set -u

SL_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=/dev/null
. "$SL_HERE/lib/session_registry.sh"
# shellcheck source=/dev/null
. "$SL_HERE/lib/session_lanes.sh"
# shellcheck source=/dev/null
. "$SL_HERE/lib/keyed_lease.sh"

ship_lock_check() {
  local key info holder epoch stale me pid lane
  if [ "${SHIP_LOCK_OFF:-0}" = 1 ]; then return 0; fi
  [ -f "$(kl_active_marker)" ] || return 0
  # This Mac's key first, then (during a migration) the other coordinator key:
  # the first VALID lease is the coordinator (kl_coord_keys, keyed_lease.sh).
  holder=""
  for key in $(kl_coord_keys); do
    if ! info="$(KL_TIMEOUT="${SHIP_LOCK_TIMEOUT:-3}" kl_coord_get "$key")"; then
      echo "ship_lock: gateway unreachable — coordinator lease not checked, allowing" >&2
      return 0
    fi
    case "$info" in present*) ;; *) continue ;; esac
    IFS="$(printf '\t')" read -r _ holder epoch stale _ <<EOF
$info
EOF
    if [ "$stale" = true ]; then holder=""; continue; fi
    break
  done
  [ -n "$holder" ] || return 0
  pid="$(_lanes_self_pid)"
  me="$(kl_host)/$(session_profile)/${pid:-<no-session>}"
  if [ -n "$pid" ] && [ "$holder" = "$me" ]; then return 0; fi
  lane="$(kl_holder_lane "$holder")"
  if [ "$lane" = "$(session_profile)" ]; then
    echo "ship_lock: BLOCKED — another $lane session is coordinator ($holder, epoch $epoch); this session is $me." >&2
  else
    echo "ship_lock: BLOCKED — coordinator is $lane ($holder, epoch $epoch) on ${holder%%/*}." >&2
  fi
  echo "  Only the coordinator session merges. Open the PR (gh pr create is allowed) and mail it instead:" >&2
  echo "    ./scripts/tell.sh --kind merge-go $lane \"ready to merge: <PR url> — <summary>\"" >&2
  echo "  (who coordinates: ./scripts/swarm_master.sh who · operator override: start the session with SHIP_LOCK_OFF=1)" >&2
  return 1
}

# ship_lock_is_merge — stdin = a shell command line. 0 = it merges a PR.
ship_lock_is_merge() {
  /usr/bin/python3 -c '
import re, shlex, sys

cmd = sys.stdin.read()
API_MERGE = re.compile(r"(^|/)pulls/[^/\s]+/merge/?$")
FALLBACK = re.compile(r"\bgh\s+(-\S+\s+)*pr\s+(-\S+\s+)*merge\b|pulls/[^/\s]+/merge|mergePullRequest")
PUNCT = set(";&|()<>\n")
WRAPPERS = {"env", "command", "exec", "time", "nohup", "sudo", "builtin", "noglob"}
VALUE_FLAGS = {"-R", "--repo", "-X", "--method", "-H", "--header", "-f", "--raw-field",
               "-F", "--field", "-q", "--jq", "-t", "--template", "--hostname", "--input",
               "-p", "--preview", "--cache"}

try:
    lex = shlex.shlex(cmd, posix=True, punctuation_chars=";&|()<>\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    tokens = list(lex)
except ValueError:
    sys.exit(0 if FALLBACK.search(cmd) else 1)

segments, cur = [], []
for t in tokens:
    if t and set(t) <= PUNCT:
        segments.append(cur); cur = []
    else:
        cur.append(t)
segments.append(cur)

def is_merge(words):
    i = 0
    while i < len(words) and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[i]) or words[i] in WRAPPERS):
        i += 1
    words = words[i:]
    if not words or words[0].rsplit("/", 1)[-1] != "gh":
        return False
    pos, j, rest = [], 1, words[1:]
    while j < len(words):
        w = words[j]
        if w in VALUE_FLAGS:
            j += 2; continue
        if not w.startswith("-"):
            pos.append(w)
        j += 1
    if len(pos) >= 2 and pos[0] == "pr" and pos[1] == "merge":
        return True
    if pos and pos[0] == "api":
        return any(API_MERGE.search(w) or "mergePullRequest" in w for w in rest)
    return False

sys.exit(0 if any(is_merge(s) for s in segments) else 1)
'
}

[ -n "${SHIP_LOCK_LIB_ONLY:-}" ] && return 0

case "${1:-check}" in
  check) ship_lock_check ;;
  is-merge) ship_lock_is_merge ;;
  *) echo "usage: ship_lock.sh check | is-merge (command on stdin)" >&2; exit 2 ;;
esac
