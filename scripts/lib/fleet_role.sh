#!/usr/bin/env bash
# fleet_role.sh (lib) — the ONE place that answers "what role is this Mac, and
# what may it do?" for the multi-Mac fleet (plan/MULTI_MAC_SWARM_BRIEF.md,
# operator-approved 2026-10-05). Sourced, never executed; bash 3.2-safe.
#
# WHY ROLES: hostnames change (a new office Mac arrives 2026-10-06) and every
# hostname-keyed config broke on the last swap. Code asks for a ROLE (office /
# home / spare); config/fleet_roles.txt maps hosts to roles and roles to a
# resource profile.
#
#   fleet_host                    this Mac's short hostname, lowercased
#   fleet_my_role                 ~/.myai/role override, else the config's `role` line, else "unassigned"
#   fleet_has_role                0 when this Mac has a real role (fleet mode on)
#   fleet_role_hosts <role>       the hosts configured for a role (space-separated)
#   fleet_profile_get <key> [role] value from the role's profile (empty when unset)
#   fleet_local_llm_allowed       0 unless the profile says local_llm=off
#   fleet_runner_allowed [epoch]  0 when this host may fire the CLI runner (schedule
#                                 + failover; sets FLEET_RUNNER_WHY)
#   fleet_runner_scheduled_role [epoch]  the role scheduled to run the runner now (empty = nobody)
#   fleet_holds_coordinator       0 when THIS host holds the live coordinator lease
#   fleet_scheduled_role [epoch]  the role scheduled to coordinate now, empty = open
#   fleet_coordinator_ok [epoch]  0 when this Mac may take coordinator without --force
#   fleet_qwen_host               a host whose profile allows local LLM (office first)
#   fleet_db_expected             the shared DB every fleet gateway must use (<host>/<db>)
#   fleet_db_of_uri <uri>         <host>/<db> of a mongodb URI (credentials dropped)
#
# Env overrides (tests): FLEET_ROLES_FILE, FLEET_HOST, FLEET_ROLE_FILE, FLEET_NOW.
# Tests: scripts/tests/test_fleet_role.sh

_fr_here() { cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd; }
FLEET_LIB_DIR="$(_fr_here)"

fleet_roles_file() { printf '%s' "${FLEET_ROLES_FILE:-$FLEET_LIB_DIR/../../config/fleet_roles.txt}"; }
fleet_host() { printf '%s' "${FLEET_HOST:-$(hostname -s 2>/dev/null)}" | tr '[:upper:]' '[:lower:]'; }
fleet_role_file() { printf '%s' "${FLEET_ROLE_FILE:-${MYAI_HOME:-$HOME/.myai}/role}"; }

# _fr_lines <directive> → the matching lines' fields after the directive.
_fr_lines() {
  local f; f="$(fleet_roles_file)"
  [ -f "$f" ] || return 0
  awk -v d="$1" '{ sub(/#.*/, "") } $1 == d { $1 = ""; sub(/^ +/, ""); print }' "$f"
}

fleet_role_hosts() { _fr_lines role | awk -v r="$1" '$1 == r { $1 = ""; sub(/^ +/, ""); print tolower($0) }'; }

fleet_my_role() {
  local rf h r
  rf="$(fleet_role_file)"
  if [ -s "$rf" ]; then r="$(head -1 "$rf" | tr -d '[:space:]')"; [ -n "$r" ] && { printf '%s' "$r"; return 0; }; fi
  h="$(fleet_host)"
  r="$(_fr_lines role | awk -v h="$h" '{ for (i = 2; i <= NF; i++) if (tolower($i) == h) { print $1; exit } }')"
  printf '%s' "${r:-unassigned}"
}

fleet_has_role() { [ "$(fleet_my_role)" != unassigned ]; }

fleet_profile_get() { # <key> [role]
  local key="$1" role="${2:-$(fleet_my_role)}" prof
  prof="$(_fr_lines role_profile | awk -v r="$role" '$1 == r { print $2; exit }')"
  [ -n "$prof" ] || return 0
  _fr_lines profile | awk -v p="$prof" -v k="$key" '$1 == p { for (i = 2; i <= NF; i++) { split($i, a, "="); if (a[1] == k) { print a[2]; exit } } }'
}

fleet_local_llm_allowed() { [ "$(fleet_profile_get local_llm)" != off ]; }

# No runner_host line, or an unassigned host → unrestricted (legacy behaviour).
# fleet_runner_scheduled_role [epoch] → the role whose Mac runs the runner now,
# from `runner <days> <HH:MM-HH:MM> <role>` lines. FIRST match wins (order is
# precedence). A span whose end is before its start crosses midnight: it covers
# <days> from the start AND the following morning up to the end ("mon 18:00-09:00"
# = Mon 18:00 → Tue 09:00). "23:59" means to the end of the day. Empty = no
# runner window right now (nobody fires).
fleet_runner_scheduled_role() {
  local now dow pdow hm line days span role from to
  now="${1:-${FLEET_NOW:-$(date +%s)}}"
  dow="$(date -r "$now" +%u 2>/dev/null || date -d "@$now" +%u)"
  pdow=$(( dow == 1 ? 7 : dow - 1 ))
  hm="$(date -r "$now" +%H%M 2>/dev/null || date -d "@$now" +%H%M)"
  hm=$((10#$hm))
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    # shellcheck disable=SC2086
    set -- $line
    days="$1"; span="$2"; role="$3"
    from=$((10#$(printf '%s' "${span%-*}" | tr -d ':'))); to=$((10#$(printf '%s' "${span#*-}" | tr -d ':')))
    [ "$to" = 2359 ] && to=2400
    if [ "$from" -lt "$to" ]; then
      if _fr_day_in "$days" "$dow" && [ "$hm" -ge "$from" ] && [ "$hm" -lt "$to" ]; then printf '%s' "$role"; return 0; fi
    else
      if _fr_day_in "$days" "$dow" && [ "$hm" -ge "$from" ]; then printf '%s' "$role"; return 0; fi
      if _fr_day_in "$days" "$pdow" && [ "$hm" -lt "$to" ]; then printf '%s' "$role"; return 0; fi
    fi
  done <<EOF
$(_fr_lines runner)
EOF
  return 0
}

# fleet_runner_allowed [epoch] → 0 when THIS host may fire the CLI runner now.
# Phase 3 (2026-10-05): with `runner` schedule lines, only the scheduled role's
# Macs fire; the Mac the operator works on (the `coordinator` role in its
# window) never fires; a role whose runner has gone silent hands over
# (failover — `rs_role_alive`, scripts/lib/runner_slot.sh, when loaded). Two
# hosts of one role may both fire: runner-slot:<account> leases make sure they
# never spend the same account at once. Without schedule lines: the phase-1
# `runner_host` list (or unrestricted). An unassigned host is unrestricted.
# FLEET_RUNNER_WHY says why (logged by the runner).
# fleet_holds_coordinator → 0 when a live (non-stale) coordinator lease is held
# by THIS host (any lane): the per-host key (active-active) or the shared
# swarm-coordinator:fleet key (fleet mode, or mid-migration). Needs
# scripts/lib/keyed_lease.sh (kl_get); without it, or with every lease
# unreadable, → 1 (not known to hold).
fleet_holds_coordinator() {
  local row holder key
  command -v kl_get >/dev/null 2>&1 || return 1
  for key in ${FLEET_COORD_KEY:-swarm-coordinator:$(fleet_host) swarm-coordinator:fleet}; do
    row="$(kl_get "$key" 2>/dev/null)" || continue
    case "$row" in present*) ;; *) continue ;; esac
    [ "$(printf '%s' "$row" | cut -f4)" = true ] && continue
    holder="$(printf '%s' "$row" | cut -f2)"
    [ "$(printf '%s' "${holder%%/*}" | tr '[:upper:]' '[:lower:]')" = "$(fleet_host)" ] && return 0
  done
  return 1
}

# fleet_coordinator_mode → `active-active` (default — operator rule 2026-10-19:
# EACH Mac's configured master holds its own swarm-coordinator:<host>) or
# `fleet` (ONE coordinator for the whole fleet on swarm-coordinator:fleet, with
# the `coordinator` schedule). Set by a `coordinator_mode` line.
fleet_coordinator_mode() {
  case "$(_fr_lines coordinator_mode | awk '{ print tolower($1); exit }')" in
    fleet) echo fleet ;;
    *) echo active-active ;;
  esac
}

# shellcheck disable=SC2034  # FLEET_RUNNER_WHY is this function's public result
fleet_runner_allowed() {
  local me sched coord hosts h
  FLEET_RUNNER_WHY=""
  fleet_has_role || { FLEET_RUNNER_WHY="unassigned host — unrestricted"; return 0; }
  me="$(fleet_my_role)"
  # The Mac HOLDING the live coordinator lease is the operator's interactive Mac
  # — whatever the schedule says (2026-10-05: office-mac unplugged, home becomes
  # the interactive Mac Mon–Thu too, and the schedule alone would have fired
  # the runner there all day). Checked first; lease unreadable → schedule only.
  if fleet_holds_coordinator; then
    FLEET_RUNNER_WHY="this Mac holds the coordinator lease (operator's interactive Mac) — never fires"; return 1
  fi
  if [ -n "$(_fr_lines runner)" ]; then
    coord="$(fleet_scheduled_role "${1:-}")"
    if [ -n "$coord" ] && [ "$coord" = "$me" ]; then
      FLEET_RUNNER_WHY="role $me is the operator's interactive Mac now (coordinator window) — never fires"; return 1
    fi
    sched="$(fleet_runner_scheduled_role "${1:-}")"
    if [ -z "$sched" ]; then FLEET_RUNNER_WHY="no runner window now"; return 1; fi
    if [ "$sched" = "$me" ]; then FLEET_RUNNER_WHY="role $me is scheduled to run now"; return 0; fi
    if command -v rs_role_alive >/dev/null 2>&1 && ! rs_role_alive "$sched"; then
      FLEET_RUNNER_WHY="FAILOVER — scheduled role $sched has no live runner; $me covers"; return 0
    fi
    FLEET_RUNNER_WHY="role $sched is scheduled to run now, not $me"; return 1
  fi
  hosts="$(_fr_lines runner_host | tr '[:upper:]' '[:lower:]')"
  [ -n "$hosts" ] || { FLEET_RUNNER_WHY="no runner schedule — unrestricted"; return 0; }
  h="$(fleet_host)"
  case " $(printf '%s' "$hosts" | tr '\n' ' ') " in *" $h "*) FLEET_RUNNER_WHY="runner_host"; return 0 ;; esac
  FLEET_RUNNER_WHY="not a runner_host"; return 1
}

# _fr_day_in <spec> <dow 1..7, Mon=1> — "mon-thu", "fri", "sat,sun", "mon-sun".
_fr_day_in() {
  printf '%s' "$1" | awk -v d="$2" '
    BEGIN { split("mon tue wed thu fri sat sun", n, " "); for (i = 1; i <= 7; i++) idx[n[i]] = i }
    { m = split($0, parts, ","); for (j = 1; j <= m; j++) {
        if (split(parts[j], ab, "-") == 2) { a = idx[ab[1]]; b = idx[ab[2]]; if (a && b && d >= a && d <= b) ok = 1 }
        else if (idx[parts[j]] == d) ok = 1 } }
    END { exit ok ? 0 : 1 }'
}

fleet_scheduled_role() { # [epoch]
  local now dow hm line days span role from to
  now="${1:-${FLEET_NOW:-$(date +%s)}}"
  dow="$(date -r "$now" +%u 2>/dev/null || date -d "@$now" +%u)"
  hm="$(date -r "$now" +%H%M 2>/dev/null || date -d "@$now" +%H%M)"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    # shellcheck disable=SC2086
    set -- $line
    days="$1"; span="$2"; role="$3"
    from="$(printf '%s' "${span%-*}" | tr -d ':')"; to="$(printf '%s' "${span#*-}" | tr -d ':')"
    if _fr_day_in "$days" "$dow" && [ "$hm" -ge "$from" ] 2>/dev/null && [ "$hm" -lt "$to" ] 2>/dev/null; then
      printf '%s' "$role"; return 0
    fi
    # 23:59 means "to the end of the day".
    if [ "$to" = 2359 ] && _fr_day_in "$days" "$dow" && [ "$hm" -ge "$from" ] 2>/dev/null; then printf '%s' "$role"; return 0; fi
  done <<EOF
$(_fr_lines coordinator)
EOF
  return 0
}

# Coordinator take without --force: open window, or this Mac's role is the scheduled one.
fleet_coordinator_ok() {
  local s; s="$(fleet_scheduled_role "${1:-}")"
  [ -z "$s" ] || [ "$s" = "$(fleet_my_role)" ]
}

fleet_qwen_host() {
  local r h
  for r in office spare home; do
    [ "$(fleet_profile_get local_llm "$r")" = off ] && continue
    for h in $(fleet_role_hosts "$r"); do printf '%s' "$h"; return 0; done
  done
  return 0
}

fleet_db_expected() { _fr_lines fleet_db | awk '{ print tolower($1); exit }'; }

fleet_db_of_uri() {
  printf '%s' "$1" | /usr/bin/python3 -c '
import sys, urllib.parse
u = urllib.parse.urlsplit(sys.stdin.read().strip())
host = (u.hostname or "").lower()
db = u.path.lstrip("/").split("?")[0]
print(host + "/" + db if host else "")' 2>/dev/null
}
