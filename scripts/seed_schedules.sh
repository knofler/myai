#!/usr/bin/env bash
# seed_schedules.sh — Seed the standard autonomous schedules into the gateway.
#
# Idempotently creates the default schedules via the `schedules_seed` MCP tool:
#   morning_sweep_daily  — 09:00 UTC daily (repo briefs across the fleet)
#   evening_sweep_daily  — 18:00 UTC daily (end-of-day status sweep)
# (dispatch_cycle @06:05 UTC self-registers at gateway boot — not seeded here.)
#
# NOTE: seeded schedules run autonomous agents that consume the shared Claude
# account token budget daily. Use --disabled to seed them switched off, then
# enable selectively via `schedules_update` when ready.
#
# Usage:
#   ./scripts/seed_schedules.sh              # seed enabled (live from next tick)
#   ./scripts/seed_schedules.sh --disabled   # seed but switched off
#   ./scripts/seed_schedules.sh --port 3100  # non-default gateway port
#
# bash 3.2-safe. See plan/AI_AUTOMATION_PLAN.md Phase 3.
set -euo pipefail

PORT=3100
ENABLED=true
while [ $# -gt 0 ]; do
    case "$1" in
        --disabled) ENABLED=false ;;
        --port) shift; PORT="${1:?--port needs a value}" ;;
        -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
    esac
    shift
done

MCP_URL="http://localhost:${PORT}/mcp"

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is required but not on PATH." >&2
    exit 1
fi

payload=$(printf '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"schedules_seed","arguments":{"enabled":%s}},"id":1}' "$ENABLED")
resp=$(curl -sf -X POST "$MCP_URL" -H 'content-type: application/json' -d "$payload" 2>/dev/null) || {
    echo "ERROR: gateway not reachable at $MCP_URL — is the container running? (docker compose up -d gateway)" >&2
    exit 1
}

result=$(echo "$resp" | jq -r '.result.content[0].text // empty')
if [ -z "$result" ]; then
    echo "ERROR: unexpected gateway response:" >&2
    echo "$resp" >&2
    exit 1
fi

echo "== Schedule seeding (enabled=$ENABLED) =="
echo "$result" | jq -r '"  created:  \(.created | join(", ") | if . == "" then "—" else . end)\n  existing: \(.existing | join(", ") | if . == "" then "—" else . end)"'
echo ""
echo "Current schedules:"
list_payload='{"jsonrpc":"2.0","method":"tools/call","params":{"name":"schedules_list","arguments":{}},"id":2}'
curl -sf -X POST "$MCP_URL" -H 'content-type: application/json' -d "$list_payload" 2>/dev/null \
    | jq -r '.result.content[0].text' \
    | jq -r '.schedules[]? | "  \(.name)  cron=\(.cronExpr)  enabled=\(.enabled)  next=\(.nextRun // "-")"'
