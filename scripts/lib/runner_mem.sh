#!/usr/bin/env bash
# runner_mem.sh — resolve the CI gh-runner memory + CPU caps for THIS machine.
#
# The gh-runner is CI infra (excluded from the 2 GB app-stack RAM guard), so its
# caps are a PER-HOST decision, not one fleet constant: detect the Mac, then decide.
# The decision table lives in config/gh_runner_mem.txt keyed by `hostname -s`, so
# nothing machine-specific has to live in .env (which Dropbox-syncs everywhere).
#
# resolve_runner_mem [map_file] [hostname]
#   map_file  defaults to config/gh_runner_mem.txt (relative to the repo root)
#   hostname  defaults to `hostname -s`
# Exact host row wins; the `*` row is the default; absent map/row → 4g.
resolve_runner_mem() {
    local map="${1:-}" host="${2:-}" limit=""
    [ -n "$map" ]  || map="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/config/gh_runner_mem.txt"
    [ -n "$host" ] || host="$(hostname -s 2>/dev/null)"
    # Precedence (phase 4): exact host row → fleet-role profile (gh_runner_mem) → `*` row → 4g.
    # A host row is deliberate per-Mac tuning; a new Mac with no row gets its role's profile.
    if [ -f "$map" ]; then
        limit="$(awk -v h="$host" '/^[[:space:]]*#/{next} tolower($1)==tolower(h) {print $2; exit}' "$map")"
    fi
    [ -n "${limit}" ] || limit="$(_role_profile_value gh_runner_mem "$host")"
    if [ -z "${limit}" ] && [ -f "$map" ]; then
        limit="$(awk '/^[[:space:]]*#/{next} $1=="*" {print $2; exit}' "$map")"
    fi
    printf '%s' "${limit:-4g}"
}

# resolve_runner_cpus [map_file] [hostname]
# Same table (3rd column), same fallback order; absent map/row/column → 4.
resolve_runner_cpus() {
    local map="${1:-}" host="${2:-}" cpus=""
    [ -n "$map" ]  || map="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/config/gh_runner_mem.txt"
    [ -n "$host" ] || host="$(hostname -s 2>/dev/null)"
    # Precedence (phase 4): exact host row → fleet-role profile (gh_runner_cpus) → `*` row → 4.
    # A host row is deliberate per-Mac tuning; a new Mac with no row gets its role's profile.
    if [ -f "$map" ]; then
        cpus="$(awk -v h="$host" '/^[[:space:]]*#/{next} tolower($1)==tolower(h) {print $3; exit}' "$map")"
    fi
    [ -n "${cpus}" ] || cpus="$(_role_profile_value gh_runner_cpus "$host")"
    if [ -z "${cpus}" ] && [ -f "$map" ]; then
        cpus="$(awk '/^[[:space:]]*#/{next} $1=="*" {print $3; exit}' "$map")"
    fi
    printf '%s' "${cpus:-4}"
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
