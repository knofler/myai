#!/usr/bin/env bash
# register_pr_review_recurring.sh — idempotently register the recurring
# runner-task template that fires scripts/pr_review_step.sh, via the gateway's
# `recurring_tasks_create` MCP tool (documentation/PR_REVIEW_RUBRIC.md's LANE).
#
# Cadence: every 2h, 08:00–20:00 AEST (AEST = UTC+10 → UTC hours 22,00,02,04,
# 06,08,10 covers the AEST 08:00–20:00 window inclusive of both ends):
#   cron: "0 22,0,2,4,6,8,10 * * *"
#
# This is a QUEUE-TASK template (like nightly_state_rotation), not a gateway
# `schedules_*` entry: on each fire it enqueues a one-shot task for the CLI
# runner ("run ./scripts/pr_review_step.sh"), which then does the actual
# gh/claude work from the runner's host environment — matching the DEPLOY
# GUARD posture (this script only calls the already-running gateway's MCP
# endpoint; it never touches docker compose / the gateway stack itself).
#
# NOT auto-installed by any agent session, same posture as
# setup_reconcile_review_schedule.sh: this creates unattended, fleet-wide,
# cost-incurring, GitHub-comment-posting automation, so the operator runs it
# once, explicitly, after reviewing pr_review_step.sh's behavior.
#
#   ./scripts/register_pr_review_recurring.sh                # create (skip if it already exists, by name)
#   ./scripts/register_pr_review_recurring.sh --dry-run       # print the recurring_tasks_create call, do nothing
#   ./scripts/register_pr_review_recurring.sh --status        # show the existing template, if any
#
# ENV: GATEWAY_MCP (default http://localhost:3100/mcp), RECURRING_NAME
#      (default pr_review_fleet_sweep), RECURRING_REPO (default ai_management
#      — the repo whose checkout the enqueued one-shot task runs
#      pr_review_step.sh from).
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SELF_DIR/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

GATEWAY_MCP="${GATEWAY_MCP:-http://localhost:3100/mcp}"
RECURRING_NAME="${RECURRING_NAME:-pr_review_fleet_sweep}"
RECURRING_REPO="${RECURRING_REPO:-ai_management}"
CRON_EXPR="0 22,0,2,4,6,8,10 * * *"

mcp() { # mcp <tool> <json-args>
    local body raw
    body="{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
    raw="$(curl -sf -m 15 -X POST "$GATEWAY_MCP" -H 'content-type: application/json' \
        -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" -d "$body" 2>/dev/null || true)"
    [ -n "$raw" ] || return 1
    printf '%s' "$raw" | /usr/bin/python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["content"][0]["text"])' 2>/dev/null
}

ACTION=create
[ "${1:-}" = "--dry-run" ] && ACTION=dry-run
[ "${1:-}" = "--status" ]  && ACTION=status

CREATE_ARGS="$(/usr/bin/python3 -c '
import json, sys
print(json.dumps({
    "name": sys.argv[1],
    "cronExpr": sys.argv[2],
    "repo": sys.argv[3],
    "title": "Fleet PR review sweep (myai-review)",
    "description": "Run scripts/pr_review_step.sh: review open PRs across the fleet per documentation/PR_REVIEW_RUBRIC.md, post one consolidated comment + commit status myai-review + label per PR, cost-capped by config/session-limits.json pr_review.max_usd.",
    "priority": "P2",
    "notes": "Registered by scripts/register_pr_review_recurring.sh. Runner should execute: ./scripts/pr_review_step.sh",
    "overlapPolicy": "skip",
    "enabled": True,
}))' "$RECURRING_NAME" "$CRON_EXPR" "$RECURRING_REPO" 2>/dev/null | sed 's/True/true/')"

if [ "$ACTION" = "dry-run" ]; then
    echo "Would call recurring_tasks_create with:"
    printf '%s\n' "$CREATE_ARGS"
    exit 0
fi

existing="$(mcp recurring_tasks_list "{\"repo\":\"$RECURRING_REPO\"}" 2>/dev/null || echo '{}')"
match="$(printf '%s' "$existing" | NAME="$RECURRING_NAME" /usr/bin/python3 -c '
import sys, json, os
try:
    d = json.loads(sys.stdin.read() or "{}")
except Exception:
    d = {}
for t in d.get("recurringTasks", d.get("tasks", [])) or []:
    if t.get("name") == os.environ["NAME"]:
        print(json.dumps(t)); break
' 2>/dev/null)"

if [ "$ACTION" = "status" ]; then
    if [ -n "$match" ]; then echo "REGISTERED: $match"; else echo "NOT registered ($RECURRING_NAME)."; fi
    exit 0
fi

if [ -n "$match" ]; then
    echo "Already registered — skipping (idempotent by name): $RECURRING_NAME"
    exit 0
fi

echo "Registering recurring task '$RECURRING_NAME' (every 2h, 08:00-20:00 AEST -> cron: $CRON_EXPR)..."
mcp recurring_tasks_create "$CREATE_ARGS"
echo "Done."
