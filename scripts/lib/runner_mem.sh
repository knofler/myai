#!/usr/bin/env bash
# runner_mem.sh — resolve the CI gh-runner memory cap for THIS machine.
#
# The gh-runner is CI infra (excluded from the 2 GB app-stack RAM guard), so its
# cap is a PER-HOST decision, not one fleet constant: detect the Mac, then decide.
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
    if [ -f "$map" ]; then
        limit="$(awk -v h="$host" '/^[[:space:]]*#/{next} $1==h {print $2; exit}' "$map")"
        [ -n "$limit" ] || limit="$(awk '/^[[:space:]]*#/{next} $1=="*" {print $2; exit}' "$map")"
    fi
    printf '%s' "${limit:-4g}"
}
