#!/usr/bin/env bash
# runner_lanes.sh — sourceable helper: parses config/runner_lanes.txt
# (host-keyed local-lane capabilities, task-972913b7) into shell globals.
# Not executed directly — sourced by cli_task_runner.sh. bash 3.2-safe (no
# arrays, no associative arrays — the fleet still runs stock macOS bash in
# places).

# runner_lanes_load [host] — reads config/runner_lanes.txt (path overridable
# via RUNNER_LANES_FILE, for tests), finds the row matching `host` (falling
# back to the '*' default row when host has none, or when host is empty), and
# sets:
#   LANE_LOCAL_MODELS — space-separated set of Ollama model ids this host has
#                       pulled ("" when the row says local=- or is missing)
#   LANE_CODEX        — "on" or "off": Codex CLI external-lane vendor
#   LANE_AGY          — "on" or "off": Antigravity CLI external-lane vendor
#                       (`agy -p … --print-timeout`; task-7fd4320e — until
#                       2026-10-02 this field gated the DeepSeek/Kimi fallback,
#                       which now lives under its real name, fallback=)
#   LANE_COPILOT      — "on" or "off" (default off): Copilot CLI vendor
#   LANE_FALLBACK     — "on" or "off": non-Claude agentic DeepSeek/Kimi
#                       fallback lane (agentic_fallback.sh, AGENTIC_FALLBACK)
#   LANE_CLAIM        — "on" (default) or "off": may this host's runner claim
#                       queue work at all (operator 2026-10-02: "everything
#                       should run on this mac" — only the big office Mac claims)
# rc 0 when a row (host-specific or '*') was found and parsed; rc 1 when the
# file is missing/unreadable or neither a host row nor a '*' row exists — the
# caller should treat that exactly like an empty local-lane set.
runner_lanes_load() {
    local host="${1:-}" file="${RUNNER_LANES_FILE:-}"
    if [ -z "$file" ]; then
        file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)/config/runner_lanes.txt"
    fi
    LANE_LOCAL_MODELS=""
    LANE_CODEX="off"
    LANE_AGY="off"
    LANE_COPILOT="off"
    LANE_FALLBACK="off"
    LANE_CLAIM="on"
    [ -f "$file" ] || return 1

    local line key matched_host="" matched_default=""
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            ''|'#'*) continue ;;
        esac
        key="${line%% *}"
        if [ -n "$host" ] && [ "$key" = "$host" ]; then
            matched_host="$line"
            break
        fi
        [ "$key" = "*" ] && matched_default="$line"
    done < "$file"

    local use="${matched_host:-$matched_default}"
    [ -z "$use" ] && return 1

    local field
    for field in $use; do
        case "$field" in
            local=*)    LANE_LOCAL_MODELS="${field#local=}" ;;
            codex=*)    LANE_CODEX="${field#codex=}" ;;
            agy=*)      LANE_AGY="${field#agy=}" ;;
            copilot=*)  LANE_COPILOT="${field#copilot=}" ;;
            fallback=*) LANE_FALLBACK="${field#fallback=}" ;;
            claim=*)    LANE_CLAIM="${field#claim=}" ;;
        esac
    done
    [ "$LANE_LOCAL_MODELS" = "-" ] && LANE_LOCAL_MODELS=""
    LANE_LOCAL_MODELS="$(printf '%s' "$LANE_LOCAL_MODELS" | tr ',' ' ')"
    # read by cli_task_runner.sh after sourcing this file
    export LANE_LOCAL_MODELS LANE_CODEX LANE_AGY LANE_COPILOT LANE_FALLBACK LANE_CLAIM
    return 0
}
