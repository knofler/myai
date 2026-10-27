#!/usr/bin/env bash
# power_settings.sh — resolve the AC-power pmset display-sleep timeout for
# THIS machine.
#
# The charger display-sleep minutes are a PER-HOST preference, not a fleet
# constant (operator 2026-10-02 set office-mac to 5 min; every other Mac keeps
# the fleet default of 30 — see config/power_settings.txt for why). The
# decision table lives there keyed by `hostname -s`, same shape as
# config/gh_runner_mem.txt / scripts/lib/runner_mem.sh.
#
# resolve_displaysleep [map_file] [hostname]
#   map_file  defaults to config/power_settings.txt (relative to the repo root)
#   hostname  defaults to `hostname -s`
# Exact host row wins; the `*` row is the default; absent map/row → 30.
resolve_displaysleep() {
    local map="${1:-}" host="${2:-}" row=""
    [ -n "$map" ]  || map="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/config/power_settings.txt"
    [ -n "$host" ] || host="$(hostname -s 2>/dev/null)"
    if [ -f "$map" ]; then
        row="$(awk -v h="$host" '/^[[:space:]]*#/{next} $1==h {print $2; exit}' "$map")"
        [ -n "$row" ] || row="$(awk '/^[[:space:]]*#/{next} $1=="*" {print $2; exit}' "$map")"
    fi
    row="${row#displaysleep=}"
    printf '%s' "${row:-30}"
}
