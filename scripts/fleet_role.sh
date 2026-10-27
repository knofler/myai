#!/usr/bin/env bash
# fleet_role.sh — see / set this Mac's fleet ROLE (office / home / spare).
# Config by role, never by hostname (plan/MULTI_MAC_SWARM_BRIEF.md):
# config/fleet_roles.txt maps hosts → roles → resource profile + schedule.
#
# Usage:
#   fleet_role.sh [show]       host, role, profile values, coordinator schedule
#                              now, runner gate, local LLM, fleet DB
#   fleet_role.sh set <role>   machine-local override in ~/.myai/role (outside
#                              Dropbox) — e.g. the new office Mac before its host
#                              is added to config/fleet_roles.txt; prints the
#                              config line to commit so the whole fleet knows
#   fleet_role.sh clear        remove the machine-local override
#   fleet_role.sh schedule     the coordinator + runner schedules, who is on now
#   fleet_role.sh doctor       this Mac vs its role profile: Docker VM size,
#                              gateway / gh-runner caps, local LLM — with the
#                              exact fix for anything off (exit 1 when off)
# bash 3.2-safe. Tests: scripts/tests/test_fleet_role.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=scripts/lib/fleet_role.sh
. "$HERE/lib/fleet_role.sh"
# shellcheck source=scripts/lib/swarm_roles.sh disable=SC1091
. "$HERE/lib/swarm_roles.sh"
# keyed leases: `show` must see the live coordinator lease (a holder Mac never fires).
# shellcheck source=scripts/lib/keyed_lease.sh
[ -f "$HERE/lib/keyed_lease.sh" ] && . "$HERE/lib/keyed_lease.sh"

known_role() { _fr_lines role | awk -v r="$1" '$1 == r { ok = 1 } END { exit ok ? 0 : 1 }'; }

show() {
  local role k v sched
  role="$(fleet_my_role)"
  echo "fleet role — host $(fleet_host)"
  if [ -s "$(fleet_role_file)" ]; then echo "  role:      $role (machine-local override $(fleet_role_file))"
  else echo "  role:      $role (config/fleet_roles.txt)"; fi
  if [ "$role" = unassigned ]; then
    echo "  this Mac is not in the fleet: per-host swarm key, runner unrestricted (as before)"
    echo "  join: scripts/fleet_role.sh set <office|home|spare>  (and add the host to config/fleet_roles.txt)"
    return 0
  fi
  printf '  profile:  '
  for k in gateway_mem gh_runner_mem gh_runner_cpus docker_vm_gb workers local_llm; do
    v="$(fleet_profile_get "$k")"; [ -n "$v" ] && printf ' %s=%s' "$k" "$v"
  done
  echo
  if [ "$(fleet_coordinator_mode)" = fleet ]; then
    sched="$(fleet_scheduled_role)"
    echo "  coordinator now: ${sched:-open (any role may take)}$(fleet_coordinator_ok || printf ' — a take HERE needs --force')"
  else
    echo "  coordinator: active-active — this Mac's swarm master is its $(role_master_lane) lane (swarm-coordinator:$(fleet_host))"
  fi
  if fleet_runner_allowed; then echo "  runner:    fires here now — $FLEET_RUNNER_WHY"; else echo "  runner:    idles here now — $FLEET_RUNNER_WHY"; fi
  if fleet_local_llm_allowed; then echo "  local LLM: allowed"; else echo "  local LLM: OFF — qwen jobs go to $(fleet_qwen_host)/qwen"; fi
  echo "  fleet DB:  $(fleet_db_expected)"
}

# _to_mb <docker size like 768m / 4g / 16G> → megabytes (empty when unparseable)
_to_mb() {
  printf '%s' "$1" | awk '{ v = tolower($0); n = v + 0; if (v ~ /g$/) n *= 1024; else if (v !~ /m$/) { if (n > 1048576) n = n / 1048576; } printf "%d", n }'
}

# _container_mem_mb <name> → that container's memory cap in MB (empty if none/not running)
_container_mem_mb() {
  local b; b="$(docker inspect -f '{{.HostConfig.Memory}}' "$1" 2>/dev/null)" || return 0
  case "$b" in ''|0) return 0 ;; esac
  awk -v b="$b" 'BEGIN { printf "%d", b / 1048576 }'
}

# doctor — this Mac vs its role profile; every mismatch prints the exact fix.
doctor() {
  local role bad=0 want got vmgb llm repo_root
  role="$(fleet_my_role)"
  repo_root="$(cd "$HERE/.." && pwd)"
  echo "fleet doctor — host $(fleet_host), role $role"
  if [ "$role" = unassigned ]; then echo "  not in the fleet — nothing to check"; return 0; fi
  if ! docker info >/dev/null 2>&1; then echo "  WARN  Docker is not running — start Docker Desktop, then re-run"; return 1; fi
  vmgb="$(fleet_profile_get docker_vm_gb)"
  if [ -n "$vmgb" ]; then
    got="$(docker info --format '{{.MemTotal}}' 2>/dev/null | awk '{ printf "%.0f", $1 / 1073741824 }')"
    # ±1 GB tolerance: Docker reports the VM a little under the setting.
    if [ -n "$got" ] && awk -v g="$got" -v w="$vmgb" 'BEGIN { d = g - w; exit !(d < -1 || d > 1) }'; then
      echo "  OFF   Docker VM memory ${got} GB, profile wants ${vmgb} GB"
      echo "        fix: Docker Desktop → Settings → Resources → Memory = ${vmgb} GB → Apply & restart (a script can't set it)"
      bad=1
    else echo "  ok    Docker VM memory ${got:-?} GB (profile ${vmgb} GB)"; fi
  fi
  # shellcheck source=scripts/lib/stack_limits.sh
  want="$(. "$HERE/lib/stack_limits.sh"; resolve_gateway_mem "" "$(fleet_host)")"; got="$(_container_mem_mb myai-gateway)"
  if [ -n "$got" ] && [ "$got" != "$(_to_mb "$want")" ]; then
    echo "  OFF   myai-gateway cap ${got} MB, this Mac resolves ${want}"
    echo "        fix: cd $repo_root && GATEWAY_MEM_LIMIT=$want docker compose up -d gateway"; bad=1
  else echo "  ok    myai-gateway cap ${got:-not running} (resolves ${want})"; fi
  # Runner slots (2026-10-22): the host budget is split by weight across every
  # runner in ~/.myai/runners/slots.<host> — check each one against its share.
  local slot c share
  # shellcheck source=scripts/lib/runner_slots.sh disable=SC1091
  . "$HERE/lib/runner_slots.sh"
  for slot in $(rs_rows | cut -f1); do
    c="$(rs_field "$slot" 4)"
    share="$(rs_share "$slot" | cut -f1)"
    got="$(_container_mem_mb "$c")"
    if [ -n "$got" ] && [ "$got" != "$(_to_mb "$share")" ]; then
      echo "  OFF   $c cap ${got} MB, its share of this Mac's runner budget is ${share}"
      echo "        fix: scripts/runner_selfhosted.sh rebalance   (docker update, no restart)"; bad=1
    else echo "  ok    $c cap ${got:-not running} (share ${share})"; fi
  done
  llm="$(fleet_profile_get local_llm)"
  if [ "$llm" = off ] && pgrep -x ollama >/dev/null 2>&1; then
    echo "  OFF   Ollama is running but this role's profile is local_llm=off (lean Mac — no local models)"
    echo "        fix: quit Ollama (menu bar → Quit Ollama) and remove it from Login Items"; bad=1
  else echo "  ok    local LLM ${llm:-unset} (ollama $(pgrep -x ollama >/dev/null 2>&1 && echo running || echo not running))"; fi
  echo "  workers cap: $(fleet_profile_get workers || true) (runner concurrency is capped, never raised)"
  return "$bad"
}

case "${1:-show}" in
  show) show ;;
  set)
    r="${2:-}"
    [ -n "$r" ] || { echo "usage: fleet_role.sh set <office|home|spare>" >&2; exit 2; }
    known_role "$r" || { echo "fleet_role: unknown role '$r' — roles in config/fleet_roles.txt: $(_fr_lines role | awk '{print $1}' | tr '\n' ' ')" >&2; exit 2; }
    mkdir -p "$(dirname "$(fleet_role_file)")"
    printf '%s\n' "$r" > "$(fleet_role_file)"
    echo "fleet_role: this Mac ($(fleet_host)) is now role $r (machine-local: $(fleet_role_file))"
    case " $(fleet_role_hosts "$r") " in
      *" $(fleet_host) "*) ;;
      *) echo "  so the WHOLE fleet knows, add the host to config/fleet_roles.txt:  role $r $(fleet_role_hosts "$r") $(fleet_host)  — then commit" ;;
    esac ;;
  clear) rm -f "$(fleet_role_file)"; echo "fleet_role: override removed — role now $(fleet_my_role)" ;;
  schedule)
    echo "  coordinator:"
    _fr_lines coordinator | awk '{ printf "    %-8s %-12s %s\n", $1, $2, $3 }'
    s="$(fleet_scheduled_role)"; echo "    now: ${s:-open (any role)}"
    echo "  runner (first match wins):"
    _fr_lines runner | awk '{ printf "    %-8s %-12s %s\n", $1, $2, $3 }'
    s="$(fleet_runner_scheduled_role)"; echo "    now: ${s:-no runner window}" ;;
  doctor) doctor ;;
  -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) echo "usage: fleet_role.sh show|set <role>|clear|schedule|doctor" >&2; exit 2 ;;
esac
