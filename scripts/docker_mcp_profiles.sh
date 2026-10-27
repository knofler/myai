#!/usr/bin/env bash
# docker_mcp_profiles.sh — converge this Mac's Docker MCP gateway profiles onto
# config/docker_mcp_profiles.txt (Docker MCP rollout A, phase 0). Before this,
# profiles were made by hand with `docker mcp profile create`, so each Mac
# drifted on its own and a new Mac had none.
#
# Usage:
#   docker_mcp_profiles.sh ensure [--only <id>]  create missing profiles, add/
#                                                remove servers to match; reads
#                                                each profile back (rule d)
#   docker_mcp_profiles.sh check                 exit 1 when any profile drifts
#   docker_mcp_profiles.sh resolve [lane]        → profile id (lane defaults to
#                                                this session's, runner when
#                                                MYAI_RUNNER_FIRE=1)
#   docker_mcp_profiles.sh list                  the config's lane → profile map
#
# Only profiles named in the config are touched; never removes a profile.
# Env: DOCKER_MCP_PROFILES (config path), DOCKER_BIN (default docker).
# bash 3.2-safe. Source with DOCKER_MCP_PROFILES_LIB_ONLY=1 for resolve only.
set -u

DMP_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# The operator file (never shipped) replaces the shipped one when present, so a
# fleet keeps its named lanes; the shipped file speaks in roles (v1 G6 P5).
if [ -z "${DOCKER_MCP_PROFILES:-}" ]; then
  DOCKER_MCP_PROFILES="$DMP_HERE/../config/docker_mcp_profiles.operator.txt"
  [ -f "$DOCKER_MCP_PROFILES" ] || DOCKER_MCP_PROFILES="$DMP_HERE/../config/docker_mcp_profiles.txt"
fi
# A copy without the resolver (a partial propagation) treats no lane as the
# master — the worker profile, the safe side.
if [ -f "$DMP_HERE/lib/swarm_roles.sh" ]; then
  # shellcheck source=scripts/lib/swarm_roles.sh disable=SC1091
  . "$DMP_HERE/lib/swarm_roles.sh"
else
  role_is_master() { return 1; }
fi
DOCKER_BIN="${DOCKER_BIN:-docker}"
DMP_CATALOG="catalog://mcp/docker-mcp-catalog"

# _dmp_rows <kind> → the config's <kind> rows, comments and blanks stripped
_dmp_rows() {
  [ -f "$DOCKER_MCP_PROFILES" ] || return 0
  sed 's/#.*//' "$DOCKER_MCP_PROFILES" | awk -v k="$1" '$1 == k { $1 = ""; sub(/^ +/, ""); print }'
}

# _dmp_lane → this session's lane: runner for runner fires, else session_profile
_dmp_lane() {
  if [ "${MYAI_RUNNER_FIRE:-0}" = 1 ]; then echo runner; return; fi
  if [ -n "${MYAI_SESSION_PROFILE:-}" ]; then
    printf '%s' "$MYAI_SESSION_PROFILE" | tr '[:upper:]' '[:lower:]'; return
  fi
  case "${CLAUDE_CONFIG_DIR:-}" in
    */.claude-*) printf '%s' "${CLAUDE_CONFIG_DIR##*/.claude-}" | tr '[:upper:]' '[:lower:]' ;;
    *) echo default ;;
  esac
}

# _dmp_role <lane> → runner | master | worker (role_is_master: master.<host>)
_dmp_role() {
  if [ "$1" = runner ]; then echo runner
  elif role_is_master "$1"; then echo master
  else echo worker; fi
}

# dmp_resolve [lane] → profile id: a `lane` row, else the lane's `role` row,
# else the `default` lane row
dmp_resolve() {
  local lane="${1:-$(_dmp_lane)}" p
  p="$(_dmp_rows lane | awk -v l="$lane" '$1 == l { print $2; exit }')"
  [ -n "$p" ] || p="$(_dmp_rows role | awk -v r="$(_dmp_role "$lane")" '$1 == r { print $2; exit }')"
  [ -n "$p" ] || p="$(_dmp_rows lane | awk '$1 == "default" { print $2; exit }')"
  [ -n "$p" ] || return 1
  echo "$p"
}

# _dmp_have <id> → the profile's server names, one per line (rc 1: no profile)
_dmp_have() {
  "$DOCKER_BIN" mcp profile show "$1" >/dev/null 2>&1 || return 1
  "$DOCKER_BIN" mcp profile server ls --format json 2>/dev/null \
    | jq -r --arg id "$1" '.[] | select(.id == $id) | .servers[]?.snapshot.server.name' | sort
}

# _dmp_words <lines> → the lines joined by single spaces
_dmp_words() { printf '%s\n' "$1" | grep . | tr '\n' ' ' | sed 's/ $//'; }

# _dmp_converge <id> <servers...> [--dry] → prints one status line; rc 1 on drift/failure
_dmp_converge() {
  local id="$1"; shift
  local dry=0 want have s add="" rm="" args=""
  case " $* " in *" --dry "*) dry=1 ;; esac
  want="$(printf '%s\n' "$@" | grep -v '^--dry$' | sort)"
  if ! have="$(_dmp_have "$id")"; then
    if [ "$dry" = 1 ]; then echo "$id: MISSING"; return 1; fi
    for s in $want; do args="$args --server $DMP_CATALOG/$s"; done
    # shellcheck disable=SC2086  # $args is a deliberate flag list
    "$DOCKER_BIN" mcp profile create --name "$id" --id "$id" $args >/dev/null 2>&1 \
      || { echo "$id: create FAILED"; return 1; }
    have="$(_dmp_have "$id")" || { echo "$id: created but not readable"; return 1; }
    [ "$have" = "$want" ] || { echo "$id: created but servers [$(_dmp_words "$have")] ≠ [$(_dmp_words "$want")]"; return 1; }
    echo "$id: created ($(_dmp_words "$want"))"; return 0
  fi
  for s in $want; do printf '%s\n' "$have" | grep -qx "$s" || add="$add $s"; done
  for s in $have; do printf '%s\n' "$want" | grep -qx "$s" || rm="$rm $s"; done
  if [ -z "$add$rm" ]; then echo "$id: current"; return 0; fi
  if [ "$dry" = 1 ]; then echo "$id: DRIFT +[${add# }] -[${rm# }]"; return 1; fi
  args=""
  for s in $add; do args="$args --server $DMP_CATALOG/$s"; done
  # shellcheck disable=SC2086
  [ -z "$add" ] || "$DOCKER_BIN" mcp profile server add "$id" $args >/dev/null 2>&1 || { echo "$id: add FAILED"; return 1; }
  # shellcheck disable=SC2086
  [ -z "$rm" ] || "$DOCKER_BIN" mcp profile server remove "$id" $rm >/dev/null 2>&1 || { echo "$id: remove FAILED"; return 1; }
  have="$(_dmp_have "$id")"
  [ "$have" = "$want" ] || { echo "$id: updated but still drifts"; return 1; }
  echo "$id: updated +[${add# }] -[${rm# }]"
}

# dmp_ensure [--dry] [--only <id>] → one line per profile; rc 1 if any failed/drifted
dmp_ensure() {
  local dry="" only="" rc=0 row id
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry) dry="--dry"; shift ;;
      --only) only="${2:-}"; shift 2 ;;
      *) shift ;;
    esac
  done
  command -v "$DOCKER_BIN" >/dev/null 2>&1 || { echo "docker not installed"; return 2; }
  "$DOCKER_BIN" mcp version >/dev/null 2>&1 || { echo "docker mcp unavailable (Docker Desktop not running, or MCP Toolkit off)"; return 2; }
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    id="${row%% *}"
    [ -z "$only" ] || [ "$only" = "$id" ] || continue
    # shellcheck disable=SC2086  # row tail = space-separated server names
    _dmp_converge "$id" ${row#"$id"} $dry || rc=1
  done <<EOF
$(_dmp_rows profile)
EOF
  return "$rc"
}

[ -n "${DOCKER_MCP_PROFILES_LIB_ONLY:-}" ] && return 0

case "${1:-}" in
  ensure)  shift; dmp_ensure "$@" ;;
  check)   shift; dmp_ensure --dry "$@" ;;
  resolve) shift; dmp_resolve "$@" ;;
  list)    _dmp_rows lane; _dmp_rows role | sed 's/^/role:/' ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
