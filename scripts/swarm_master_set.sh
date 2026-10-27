#!/usr/bin/env bash
# swarm_master_set.sh — choose THIS device's swarm master (`myai swarm master
# set`). Operator rule 2026-10-22: every device always has exactly one swarm
# master, chosen at install, for any agent or profile. Writes the per-host
# config ~/.myai/swarm/master.<host> (scripts/lib/swarm_master_config.sh).
#
# Usage:
#   swarm_master_set.sh [set]                 interactive: list the agents and
#                                             profiles detected on this device,
#                                             ask "Which agent is this device's
#                                             swarm master?", write the config
#   swarm_master_set.sh set --agent A [--profile DIR] [--repo R] [--order "…"]
#                                             non-interactive
#   swarm_master_set.sh show                  print this device's config (exit 1: none)
#   swarm_master_set.sh list                  detected agents/profiles
#   swarm_master_set.sh migrate [--check|--dry-run]
#                                             existing hosts (run by `myai upgrade`):
#                                             no config yet → write the host's
#                                             current master + the legacy order so it
#                                             keeps working. Idempotent; --check
#                                             exits 20 when a migration is pending.
#
# Re-runnable: `set` overwrites the device's choice. bash 3.2-safe; safe under
# `set -euo pipefail`. SWARM_MASTER_SET_LIB_ONLY=1 to source.
set -u

SMS_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=/dev/null
. "$SMS_HERE/lib/session_registry.sh"
# shellcheck source=/dev/null
. "$SMS_HERE/lib/swarm_master_config.sh"

# The order a host used before per-device config, for the one-time migration
# of hosts that already ran a swarm (new devices never get it). It is the
# operator's data, so it comes from their operator defaults file (never
# shipped; MYAI_SWARM_LEGACY_ORDER), else from the profile dirs on disk.
# shellcheck source=scripts/lib/operator_defaults.sh disable=SC1091
[ -f "$SMS_HERE/lib/operator_defaults.sh" ] && . "$SMS_HERE/lib/operator_defaults.sh" && operator_defaults_load "$SMS_HERE/.."
_sms_derived_order() {
  local d out=""
  for d in "${SMC_HOME:-$HOME}"/.claude-*; do [ -d "$d" ] && out="$out ${d##*/.claude-}"; done
  printf '%s' "${out# } agy qwen"
}
SMS_LEGACY_ORDER="${MYAI_SWARM_LEGACY_ORDER:-$(_sms_derived_order)}"

# _sms_read <prompt> → one line from the terminal (empty when there is none).
_sms_read() {
  local ans=""
  printf '%s' "$1" > /dev/tty 2>/dev/null || return 1
  IFS= read -r ans < /dev/tty 2>/dev/null || return 1
  printf '%s' "$ans"
}

sms_show() {
  if ! smc_exists; then
    echo "swarm master: none configured on $(smc_host) — fix: myai swarm master set"
    return 1
  fi
  echo "swarm master for $(smc_host) ($(smc_file)):"
  sed 's/^/  /' "$(smc_file)"
  echo "  coordination order: $(smc_order)"
}

sms_list() {
  local n=0 row agent prof lane
  # cut, not `IFS=<tab> read`: tab is IFS whitespace, so read would collapse
  # the empty profile column of a non-Claude agent.
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    agent="$(printf '%s' "$row" | cut -f1)"; prof="$(printf '%s' "$row" | cut -f2)"; lane="$(printf '%s' "$row" | cut -f3)"
    n=$((n + 1))
    printf '  %d) %-7s lane %-10s %s\n' "$n" "$agent" "$lane" "${prof:-(agent CLI on PATH)}"
  done <<EOF
$(smc_detect)
EOF
  [ "$n" -gt 0 ] || echo "  (no agents or profiles detected on this device)"
}

sms_set() {
  local agent="" prof="" repo="" order="" pick det n row
  while [ $# -gt 0 ]; do
    case "$1" in
      --agent)   [ $# -ge 2 ] || { echo "swarm master set: --agent needs a value" >&2; return 2; }; agent="$2"; shift 2 ;;
      --profile) [ $# -ge 2 ] || { echo "swarm master set: --profile needs a value" >&2; return 2; }; prof="$2"; shift 2 ;;
      --repo)    [ $# -ge 2 ] || { echo "swarm master set: --repo needs a value" >&2; return 2; }; repo="$2"; shift 2 ;;
      --order)   [ $# -ge 2 ] || { echo "swarm master set: --order needs a value" >&2; return 2; }; order="$2"; shift 2 ;;
      *) echo "swarm master set: unknown argument $1" >&2; return 2 ;;
    esac
  done
  if [ -z "$agent" ]; then
    det="$(smc_detect)"
    if [ -z "$det" ]; then
      echo "swarm master: no agents or profiles detected on $(smc_host) — pass --agent <name> [--profile <dir>]" >&2
      return 1
    fi
    echo "Agents and profiles on $(smc_host):"
    sms_list
    if smc_exists; then echo "  current master: $(smc_master_agent) (lane $(smc_master_lane))"; fi
    pick="$(_sms_read "Which agent is this device's swarm master? [1-$(printf '%s\n' "$det" | grep -c .)]: ")" || {
      echo "swarm master: no terminal to ask on — run: myai swarm master set --agent <agent> [--profile <dir>]" >&2
      return 1
    }
    case "$pick" in ''|*[!0-9]*) echo "swarm master: '$pick' is not a number from the list — nothing written" >&2; return 1 ;; esac
    n=0
    while IFS= read -r row; do
      n=$((n + 1))
      if [ "$n" = "$pick" ]; then
        agent="$(printf '%s' "$row" | cut -f1)"; prof="$(printf '%s' "$row" | cut -f2)"
      fi
    done <<EOF
$det
EOF
    [ -n "$agent" ] || { echo "swarm master: $pick is not on the list — nothing written" >&2; return 1; }
  fi
  if [ "$agent" = claude ] && [ -z "$prof" ]; then prof="$HOME/.claude"; fi
  smc_write "$agent" "$prof" "$repo" "$order" || return 1
  echo "swarm master: $(smc_host) → $agent (lane $(smc_master_lane), repo $(smc_master_repo)) — $(smc_file)"
  echo "  its next session takes the coordinator lease itself (hooks/session/38-swarm-master-ensure.sh)"
}

# sms_legacy_state → 0 when this host already ran a swarm before per-device
# config (coordinator record / state, active marker, or session ticks in
# SWARM_DIR). A device with none is NEW: it gets the install prompt, never the
# legacy order.
sms_legacy_state() {
  local d h f
  d="$(smc_dir)"; h="$(smc_host)"
  for f in "$d/active.$h" "$d/coordinator.$h.current" "$d/coordinator.$h".*.json "$d/tick.$h".*; do
    [ -e "$f" ] && return 0
  done
  return 1
}

# sms_legacy_master → the lane this host already treats as master: the
# coordinator record, else the newest per-session coordinator state, else the
# first legacy-order lane that exists here.
sms_legacy_master() {
  local cf holder lane l newest
  cf="$(session_coordinator_file)"
  if [ -f "$cf" ]; then
    holder="$(head -1 "$cf" 2>/dev/null || true)"
    lane="$(printf '%s' "$holder" | cut -d/ -f2)"
    if [ -n "$lane" ]; then printf '%s' "$lane"; return 0; fi
  fi
  # shellcheck disable=SC2012  # names are ours (coordinator.<host>.<lane>.<pid>.json)
  newest="$(ls -t "$(smc_dir)/coordinator.$(smc_host)".*.json 2>/dev/null | head -1)"
  if [ -n "$newest" ]; then
    lane="$(basename "$newest" .json | awk -F. '{print $(NF-1)}')"
    if [ -n "$lane" ]; then printf '%s' "$lane"; return 0; fi
  fi
  for l in $SMS_LEGACY_ORDER; do
    case "$l" in
      agy|qwen) if command -v "$l" >/dev/null 2>&1 || [ -x "${SMC_HOME:-$HOME}/.local/bin/$l" ]; then printf '%s' "$l"; return 0; fi ;;
      *) if [ -d "${SMC_HOME:-$HOME}/.claude-$l" ]; then printf '%s' "$l"; return 0; fi ;;
    esac
  done
  return 1
}

sms_migrate() {
  local mode="${1:-}" lane agent prof
  if smc_exists; then
    echo "swarm master migration: $(smc_host) already configured ($(smc_master_agent), lane $(smc_master_lane)) — nothing to do"
    return 0
  fi
  if ! sms_legacy_state; then
    echo "swarm master migration: $(smc_host) never ran a swarm — nothing to migrate; choose its master: myai swarm master set"
    return 0
  fi
  if ! lane="$(sms_legacy_master)"; then
    echo "swarm master migration: no legacy master on $(smc_host) — choose one: myai swarm master set"
    return 0
  fi
  case "$lane" in
    agy|qwen) agent="$lane"; prof="" ;;
    default)  agent=claude; prof="${SMC_HOME:-$HOME}/.claude" ;;
    *)        agent=claude; prof="${SMC_HOME:-$HOME}/.claude-$lane" ;;
  esac
  case "$mode" in
    --check)   echo "swarm master migration PENDING: would write $(smc_file) (master $agent, lane $lane, order $SMS_LEGACY_ORDER)"; return 20 ;;
    --dry-run) echo "swarm master migration (dry-run): would write $(smc_file) (master $agent, lane $lane, order $SMS_LEGACY_ORDER)"; return 0 ;;
  esac
  smc_write "$agent" "$prof" "" "$SMS_LEGACY_ORDER" || return 1
  echo "swarm master migration: wrote $(smc_file) — master $agent (lane $lane), order $SMS_LEGACY_ORDER"
}

sms_main() {
  local verb="${1:-set}"
  case "$verb" in --*) verb="set" ;; *) shift || true ;; esac
  case "$verb" in
    set) sms_set "$@" ;;
    show) sms_show ;;
    list) echo "Agents and profiles on $(smc_host):"; sms_list ;;
    migrate) sms_migrate "$@" ;;
    -h|--help|help) sed -n '2,24p' "$SMS_HERE/swarm_master_set.sh" | sed 's/^# \{0,1\}//' ;;
    *) echo "swarm master: unknown verb '$verb' (set | show | list | migrate)" >&2; return 2 ;;
  esac
}

[ -n "${SWARM_MASTER_SET_LIB_ONLY:-}" ] && return 0
sms_main "$@"
