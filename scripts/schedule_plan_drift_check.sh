#!/usr/bin/env bash
# schedule_plan_drift_check.sh — scheduled/CI-able wrapper for
# scripts/lib/schedule_plan_drift.py (task-cea1ef6f).
#
# Pulls every repo's registered plan_set days (plan_list, no repo filter —
# paginated) and its task queue (tasks_list, statuses pending/working/review/
# done — paginated) from the myAI gateway, hands both to the pure Python
# diff (schedule_plan_drift.py), and prints its report.
#
# READ-ONLY: never calls plan_set / tasks_update / any mutating tool.
# FAILS LOUDLY on drift (exit 1) — unlike the silent self-checks such as
# pool_capacity_drift_check.sh, this one is meant to be a visible gate: a
# repo's dashboard /plan slice that no longer matches its actual queue is
# exactly the kind of thing that should interrupt a scheduled run or a CI
# job, not just log quietly.
#
# Usage:
#   ./scripts/schedule_plan_drift_check.sh                 # all repos
#   ./scripts/schedule_plan_drift_check.sh --repo agentFlow
#   ./scripts/schedule_plan_drift_check.sh --threshold 0.4
#
# Env: GATEWAY_MCP (default http://localhost:3100/mcp), GATEWAY_HTTP_PORT
#      (default 3200), SCHEDULE_PLAN_DRIFT_STATUS_OUT (optional JSON
#      bridge-artifact path, default state/schedule-plan-drift-status.json).
#
# Exit codes:
#   0  no drift found (or gateway unreachable — an infra problem, not a
#      plan/queue drift finding, so it does NOT fail this check)
#   1  drift found — FAIL LOUDLY
#   2  usage / input error
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DRIFT_PY="$SCRIPT_DIR/lib/schedule_plan_drift.py"
PY="${PYTHON_BIN:-python3}"

GATEWAY_MCP="${GATEWAY_MCP:-http://localhost:3100/mcp}"
GATEWAY_HTTP_PORT="${GATEWAY_HTTP_PORT:-3200}"
GATEWAY_HEALTH_BASE="${GATEWAY_HEALTH_BASE:-$(printf '%s' "${GATEWAY_MCP%/mcp}" | sed -E "s#:[0-9]+\$#:${GATEWAY_HTTP_PORT}#")}"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
export SCHEDULE_PLAN_DRIFT_STATUS_OUT="${SCHEDULE_PLAN_DRIFT_STATUS_OUT:-$REPO_ROOT/state/schedule-plan-drift-status.json}"

REPO_FILTER=""
THRESHOLD="0.34"
while [ $# -gt 0 ]; do
    case "$1" in
        --repo)      shift; REPO_FILTER="${1:?--repo needs a value}" ;;
        --threshold) shift; THRESHOLD="${1:?--threshold needs a value}" ;;
        -h|--help)   grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

if ! command -v "$PY" >/dev/null 2>&1; then
    echo "SKIP — python3 not on PATH"; exit 0
fi

# Same deep-health probe convention as schedule_task.sh / push_schedule.sh:
# the shallow /health always answers 200 even with Mongo down, so this checks
# /health/deep instead. Gateway unreachable/unhealthy is an infra problem —
# this check reports it and exits 0 (it did not find drift; it couldn't look).
_deep_rc=0
_deep="$(curl -s -m 8 -w '\n%{http_code}' "${GATEWAY_HEALTH_BASE}/health/deep" 2>/dev/null)" || _deep_rc=$?
_deep_status="${_deep##*$'\n'}"
if [ $_deep_rc -ne 0 ] || [ -z "$_deep_status" ] || [ "$_deep_status" -lt 200 ] || [ "$_deep_status" -ge 300 ]; then
    echo "SKIP — gateway not reachable/healthy at $GATEWAY_MCP (cannot verify plan/queue drift)"
    exit 0
fi

mcp_call() { # mcp_call <tool> <json-args>
    curl -sf -X POST "$GATEWAY_MCP" -H 'content-type: application/json' \
        -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
}

TMP_IN="$(mktemp -t schedule-plan-drift-input.XXXXXX.json)"
trap 'rm -f "$TMP_IN"' EXIT

# Fetch every page of plan_list + tasks_list (pending/working/review/done)
# and merge into the single {days:[...], tasks:[...]} shape
# schedule_plan_drift.py expects. Cursor-paginated so this stays correct
# regardless of fleet size, same convention as reconcile_review_tasks.sh.
REPO_FILTER="$REPO_FILTER" TMP_IN="$TMP_IN" GATEWAY_MCP="$GATEWAY_MCP" GW_TOKEN="$GATEWAY_LOCAL_TOKEN" "$PY" - <<'PY'
import json, os, sys, urllib.request

MCP = os.environ["GATEWAY_MCP"]
TOKEN = os.environ.get("GW_TOKEN", "")
REPO_FILTER = os.environ.get("REPO_FILTER", "")


def call(name, args):
    body = json.dumps({"jsonrpc": "2.0", "method": "tools/call", "id": 1,
                        "params": {"name": name, "arguments": args}}).encode()
    req = urllib.request.Request(MCP, data=body, headers={
        "content-type": "application/json",
        "x-gateway-local-token": TOKEN,
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = json.loads(resp.read())
    return json.loads(raw["result"]["content"][0]["text"])


def paginate(tool, base_args, list_key):
    out = []
    cursor = None
    for _ in range(500):  # hard cap — never spin forever on a buggy cursor
        args = dict(base_args)
        args["limit"] = 200
        if cursor:
            args["cursor"] = cursor
        result = call(tool, args)
        out.extend(result.get(list_key, []) or [])
        cursor = result.get("nextCursor")
        if not cursor:
            break
    return out


days_args = {"repo": REPO_FILTER} if REPO_FILTER else {}
days = paginate("plan_list", days_args, "days")

tasks = []
for status in ("pending", "working", "review", "done"):
    task_args = {"status": status}
    if REPO_FILTER:
        task_args["repo"] = REPO_FILTER
    tasks.extend(paginate("tasks_list", task_args, "tasks"))

with open(os.environ["TMP_IN"], "w", encoding="utf-8") as fh:
    json.dump({"days": days, "tasks": tasks}, fh)
PY
FETCH_RC=$?

if [ $FETCH_RC -ne 0 ]; then
    echo "SKIP — could not fetch plan_list/tasks_list from the gateway (fetch exit $FETCH_RC)"
    exit 0
fi

"$PY" "$DRIFT_PY" "$TMP_IN" --threshold "$THRESHOLD"
exit $?
