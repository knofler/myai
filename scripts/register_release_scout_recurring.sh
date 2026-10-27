#!/usr/bin/env bash
# register_release_scout_recurring.sh — idempotently register the recurring
# runner-task template that fires scripts/release_scout_step.sh, via the
# gateway's `recurring_tasks_create` MCP tool (agents/standing-release-scout.md's
# Integration Notes).
#
# Cadence: weekly, Saturday 20:00 Sydney (off-hours per AI_RULES §7 — weekday
# 6pm-9am + all weekend). Cron fires in UTC; AEDT (UTC+11, roughly Oct-Apr)
# puts Saturday 09:00 UTC at Saturday 20:00 Sydney. During AEST months
# (UTC+10) the same cron fires at Saturday 19:00 Sydney instead — still
# inside the off-hours window, so the twice-yearly DST drift is accepted
# rather than chased with a second cron entry (same posture as
# register_blog_scout_recurring.sh). Deliberately NOT the same slot as
# blog_scout_weekly_sweep (Sunday 10:00) so the two weekly sweeps don't
# contend for the runner at the same moment.
#   cron: "0 9 * * 6"
#
# This is a QUEUE-TASK template (like pr_review_fleet_sweep /
# blog_scout_weekly_sweep), not a gateway `schedules_*` entry and not a
# claude.ai/code cloud routine (config/cloud_routines.md: all cloud routines
# disabled 2026-09-20, a new one needs the five-part justification in
# documentation/ROUTINE_MANAGEMENT.md §2 — a weekly local check that only
# needs `npm view` + a `git` checkout fails that test outright, the CLI
# runner already does this for free).
# On each fire it enqueues a one-shot task for the CLI runner ("run
# ./scripts/release_scout_step.sh"), which does the actual npm/git/mailbox
# work from the runner's host environment — matching the DEPLOY GUARD
# posture (this script only calls the already-running gateway's MCP
# endpoint; it never touches docker compose / the gateway stack itself).
#
# NOT auto-installed by any agent session, same posture as
# register_blog_scout_recurring.sh: this creates unattended, cost-incurring
# automation that commits a version bump + CHANGELOG entry to `test` and
# mails the operator, so the operator runs it once, explicitly, after
# reviewing release_scout_step.sh (and ideally a --dry-run of it).
#
#   ./scripts/register_release_scout_recurring.sh                # create (skip if it already exists, by name)
#   ./scripts/register_release_scout_recurring.sh --dry-run       # print the recurring_tasks_create call, do nothing
#   ./scripts/register_release_scout_recurring.sh --status        # show the existing template, if any
#
# ENV: GATEWAY_MCP (default http://localhost:3100/mcp), RECURRING_NAME
#      (default release_scout_weekly_check), RECURRING_REPO (default
#      ai_management — the repo whose checkout the enqueued one-shot task
#      runs release_scout_step.sh from).
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/.." && pwd)"
. "$SELF_DIR/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

GATEWAY_MCP="${GATEWAY_MCP:-http://localhost:3100/mcp}"
RECURRING_NAME="${RECURRING_NAME:-release_scout_weekly_check}"
RECURRING_REPO="${RECURRING_REPO:-ai_management}"
CRON_EXPR="0 9 * * 6"
IGNORE_FILE="${SCHEDULE_IGNORE_FILE:-$REPO_ROOT/config/schedule_ignore.txt}"

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

# Consent gate (defense in depth — mirrors the step script's own check): if
# RECURRING_REPO is ever added to schedule_ignore.txt, refuse to register
# without explicit consent.
if grep -v '^[[:space:]]*#' "$IGNORE_FILE" 2>/dev/null | grep -v '^[[:space:]]*$' | grep -qx "$RECURRING_REPO" \
    && [ "${SCHEDULE_CONSENT:-0}" != "1" ]; then
    echo "REFUSING: $RECURRING_REPO is in $IGNORE_FILE — no autonomous scheduling without explicit consent (SCHEDULE_CONSENT=1)." >&2
    exit 1
fi

CREATE_ARGS="$(/usr/bin/python3 -c '
import json, sys
print(json.dumps({
    "name": sys.argv[1],
    "cronExpr": sys.argv[2],
    "repo": sys.argv[3],
    "title": "Weekly release scout check (standing-release-scout)",
    "description": "Run scripts/release_scout_step.sh: compare the npm-published ai-management version against commits since its tag, and PREPARE a release (package.json bump + CHANGELOG.md entry, test branch) when warranted. Mails the operator (kind=request, subject \"release vX.Y.Z ready — run publish_release.sh\") with the proposed version + changelog notes. Skips quietly when nothing release-worthy landed, or sends a reminder when a prepared version is already waiting to be published. Never publishes, never tags, never opens a PR — publishing stays scripts/publish_release.sh --interactive-otp, run by the operator.",
    "priority": "P3",
    "notes": "Registered by scripts/register_release_scout_recurring.sh. Runner should execute: ./scripts/release_scout_step.sh",
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

echo "Registering recurring task '$RECURRING_NAME' (weekly, Saturday 20:00 Sydney -> cron: $CRON_EXPR)..."
mcp recurring_tasks_create "$CREATE_ARGS"
echo "Done."
