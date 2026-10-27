#!/usr/bin/env bash
# stack_limits.sh — resolve this machine's myAI APP-STACK limits (gateway mem,
# RAM-guard ceiling, login restart policy) from one per-host table.
#
# The app stack's sizing is a PER-HOST decision, not one fleet constant: a 48 GB
# office Mac gives the gateway real headroom and lifts the RAM-guard ceiling; a
# 16 GB laptop keeps the defaults. The decision table lives in
# config/stack_limits.txt keyed by `hostname -s`, so nothing machine-specific
# has to live in .env (which Dropbox-syncs everywhere) or in the compose
# defaults. This mirrors scripts/lib/runner_mem.sh (the CI-runner sibling):
# exact host row wins, the `*` row is the default, absent map/row → compose
# default.
#
# Table format (whitespace-separated, `#` comment rows ignored):
#   <hostname-or-*>  <gateway mem_limit>  <app-stack ceiling MB>  <restart mode>

# _stack_limits_field <column> <hard-default> [map_file] [hostname]
#   Shared awk lookup for all three resolvers below. <column> is the 1-based
#   field (2=gateway mem, 3=ceiling MB, 4=restart mode). Exact host row wins;
#   the `*` row is the default; absent map/row/column → <hard-default>.
_stack_limits_field() {
    local col="$1" def="$2" map="${3:-}" host="${4:-}" v=""
    [ -n "$map" ]  || map="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/config/stack_limits.txt"
    [ -n "$host" ] || host="$(hostname -s 2>/dev/null)"
    if [ -f "$map" ]; then
        v="$(awk -v h="$host" -v c="$col" '/^[[:space:]]*#/{next} tolower($1)==tolower(h) {print $c; exit}' "$map")"
        [ -n "$v" ] || v="$(awk -v c="$col" '/^[[:space:]]*#/{next} $1=="*" {print $c; exit}' "$map")"
    fi
    printf '%s' "${v:-$def}"
}

# resolve_gateway_mem [map_file] [hostname] — docker mem_limit for the `gateway`
# service, e.g. "1g" / "2g". Absent map/row → 1g (the compose default).
# Precedence (multi-Mac phase 4): exact host row → fleet-role profile
# (gateway_mem) → `*` row → 1g. office-mac's 2g host row stays authoritative; a new
# office Mac with no row gets its role's profile.
resolve_gateway_mem() {
    local map="${1:-}" host="${2:-}" v=""
    [ -n "$map" ]  || map="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/config/stack_limits.txt"
    [ -n "$host" ] || host="$(hostname -s 2>/dev/null)"
    [ -f "$map" ] && v="$(awk -v h="$host" '/^[[:space:]]*#/{next} tolower($1)==tolower(h) {print $2; exit}' "$map")"
    [ -n "$v" ] || v="$(_role_profile_value gateway_mem "$host")"
    [ -n "$v" ] || v="$(_stack_limits_field 2 1g "$map" "__no_such_host__")"
    printf '%s' "$v"
}

# resolve_stack_ceiling_mb [map_file] [hostname] — the 13-ram-guard.sh ceiling in
# MB, e.g. "2048" / "3072". Absent map/row → 2048.
resolve_stack_ceiling_mb() { _stack_limits_field 3 2048 "${1:-}" "${2:-}"; }

# resolve_restart_mode [map_file] [hostname] — "default" or "myai-only". Absent
# map/row → default (every container keeps its compose restart policy).
resolve_restart_mode() { _stack_limits_field 4 default "${1:-}" "${2:-}"; }

# resolve_task_ram_mb [map] [host] → the CLI runner's per-task RAM cap in MB
# (5th column; default 1536 — cli_task_runner.sh MAX_TASK_RAM_MB).
resolve_task_ram_mb() { _stack_limits_field 5 1536 "${1:-}" "${2:-}"; }

# stack_reassert_myai_only_restart — enact restart mode `myai-only`: set
# `restart=no` on every RUNNING container whose name does not start with
# `myai-`, so only the myAI stack auto-restarts at login. Other repos' compose
# files (e.g. `restart: unless-stopped`) re-set their own policy on their next
# `up`, so morning_boot re-asserts this every day. Prints one line per container
# it updated (the container name). Returns 0 on success (including zero
# containers), 1 if `docker ps` or any `docker update` failed. All docker access
# goes through whatever `docker` is on PATH (hermetic-testable via a stub).
stack_reassert_myai_only_restart() {
    local names rc=0 c
    names="$(docker ps --format '{{.Names}}' 2>/dev/null)" || return 1
    while IFS= read -r c; do
        [ -n "$c" ] || continue
        case "$c" in myai-*) continue ;; esac
        if docker update --restart=no "$c" >/dev/null 2>&1; then
            printf '%s\n' "$c"
        else
            rc=1
        fi
    done <<< "$names"
    return "$rc"
}

# _role_profile_value <key> [host] → the fleet-role profile value for <key> of
# <host> (default this Mac) from config/fleet_roles.txt (scripts/lib/
# fleet_role.sh); empty when that host has no role or the profile has no such
# key. The machine-local role override (~/.myai/role) only counts for THIS Mac.
# Multi-Mac phase 4 (2026-10-05).
_role_profile_value() {
    local here key="$1" h="${2:-}" me rf
    me="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
    h="$(printf '%s' "${h:-$me}" | tr '[:upper:]' '[:lower:]')"
    if ! command -v fleet_profile_get >/dev/null 2>&1; then
        here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        # shellcheck source=/dev/null
        [ -f "$here/fleet_role.sh" ] && . "$here/fleet_role.sh"
    fi
    command -v fleet_has_role >/dev/null 2>&1 || return 0
    rf="${FLEET_ROLE_FILE:-}"
    [ "$h" = "$me" ] || rf=/dev/null
    FLEET_HOST="$h" FLEET_ROLE_FILE="${rf:-${MYAI_HOME:-$HOME/.myai}/role}" fleet_has_role || return 0
    FLEET_HOST="$h" FLEET_ROLE_FILE="${rf:-${MYAI_HOME:-$HOME/.myai}/role}" fleet_profile_get "$key"
}
