#!/usr/bin/env bash
# schedule_task.sh — the STANDARD way to schedule autonomous work in ANY repo.
#
# Pushes a task into the myAI gateway task queue (http://localhost:3100/mcp).
# The launchd CLI task runner (every few hours, free Fable window, claude-tech,
# subscription-billed) pulls the highest-priority pending task and works it on a
# `test` branch, then flips it to "Needs Review" for a human `ship it`.
#
# This is the ONE correct mechanism. Do NOT create gateway *cron schedules* for
# per-repo work (those bill API tokens and are disabled fleet-wide) — create a
# TASK and let the runner schedule it by priority.
#
# Usage:
#   ./AI/scripts/schedule_task.sh --title "Add rate limiting to /api/foo" \
#        [--repo <name>] [--priority P0|P1|P2|P3] [--agent <specialist>] \
#        [--model <model-id>] [--desc "..."] [--notes "..."]
#   ./AI/scripts/schedule_task.sh --list           # show this repo's queued tasks
#   ./AI/scripts/schedule_task.sh --list-all        # show the whole queue (limit 500)
#
# Defaults: repo = git repo basename; priority = P2; model = free-window model
# (claude-fable-5 until 2026-06-22, else agent-tier default); source = manual.
#
# Env: GATEWAY_MCP (default http://localhost:3100/mcp), FABLE_FREE_UNTIL (YYYYMMDD).
set -euo pipefail

GATEWAY_MCP=${GATEWAY_MCP:-http://localhost:3100/mcp}
# /health/deep (the Mongo-pinging deep check) is served by the HTTP server on
# GATEWAY_HTTP_PORT (default 3200), NOT the MCP port (3100 serves only the shallow
# /health). Derive the HTTP health base from GATEWAY_MCP by swapping the port so the
# deep probe below hits the right server. Override with GATEWAY_HTTP_PORT / GATEWAY_HEALTH_BASE.
GATEWAY_HTTP_PORT=${GATEWAY_HTTP_PORT:-3200}
GATEWAY_HEALTH_BASE=${GATEWAY_HEALTH_BASE:-$(printf '%s' "${GATEWAY_MCP%/mcp}" | sed -E "s#:[0-9]+\$#:${GATEWAY_HTTP_PORT}#")}
# Local-token escape hatch — gateway enforces auth (ADR-010 M1); host calls aren't loopback.
. "$(dirname "$0")/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
DASH=${DASH_URL:-http://localhost:3210}
FABLE_FREE_UNTIL=${FABLE_FREE_UNTIL:-20260622}

REPO=""; TITLE=""; DESC=""; PRIORITY="P2"; AGENT=""; MODEL=""; NOTES=""; ACTION="create"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)      shift; REPO="${1:?}";;
    --title)     shift; TITLE="${1:?}";;
    --desc|--description) shift; DESC="${1:?}";;
    --priority)  shift; PRIORITY="${1:?}";;
    --agent)     shift; AGENT="${1:?}";;
    --model)     shift; MODEL="${1:?}";;
    --notes)     shift; NOTES="${1:?}";;
    --list)      ACTION="list";;
    --list-all)  ACTION="list-all";;
    -h|--help)   grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac; shift
done

# Resolve repo name from git toplevel if not given.
if [ -z "$REPO" ]; then
  if git rev-parse --show-toplevel >/dev/null 2>&1; then
    REPO="$(basename "$(git rev-parse --show-toplevel)")"
  else
    REPO="$(basename "$PWD")"
  fi
fi

# Gateway + backing-store reachability check (clear message; don't fall over
# silently). Deliberately probes /health/deep, not the shallow /health — the
# shallow endpoint always answers HTTP 200 even when MongoDB is unreachable
# (other scripts rely on that as a pure process-liveness probe), so a bare
# `curl -sf` against it never trips even when tasks would silently vanish
# into a broken store (2026-07-06 localhost:27017-misdirection incident).
# /health/deep actually pings Mongo and returns non-2xx when it's down.
_deep_rc=0
_deep="$(curl -s -m 8 -w '\n%{http_code}' "${GATEWAY_HEALTH_BASE}/health/deep" 2>/dev/null)" || _deep_rc=$?
_deep_status="${_deep##*$'\n'}"
_deep_body="${_deep%$'\n'*}"
if [ $_deep_rc -ne 0 ] || [ -z "$_deep_status" ]; then
  echo "✗ Gateway not reachable at $GATEWAY_MCP" >&2
  echo "  Start it (in the master AI repo): docker compose up -d  → then retry." >&2
  exit 1
fi
if [ "$_deep_status" -lt 200 ] || [ "$_deep_status" -ge 300 ]; then
  _mongo_state="$(echo "$_deep_body" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("checks", {}).get("mongodb", {}).get("status", "unknown"))
except Exception:
    print("unknown")
' 2>/dev/null)"
  echo "✗ Gateway is unhealthy (HTTP $_deep_status, mongodb=$_mongo_state) — refusing to queue a task that would silently vanish." >&2
  echo "  Check MONGODB_URI in the gateway's .env — it must point at the compose service host (e.g. 'mongo'), not 'localhost'." >&2
  exit 1
fi

mcp_call() { # $1 tool, $2 args-json
  curl -sf -X POST "$GATEWAY_MCP" -H 'content-type: application/json' \
    -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
}

if [ "$ACTION" = "list" ] || [ "$ACTION" = "list-all" ]; then
  if [ "$ACTION" = "list" ]; then ARGS="{\"repo\":\"$REPO\",\"limit\":200}"; HDR="Queued tasks for '$REPO'";
  else ARGS='{"limit":500}'; HDR="Full queue"; fi
  echo "== $HDR =="
  mcp_call tasks_list "$ARGS" | python3 -c "
import sys,json
d=json.load(sys.stdin); t=json.loads(d['result']['content'][0]['text'])
t=t if isinstance(t,list) else t.get('tasks',[])
op=[x for x in t if x.get('status')!='done']
for x in sorted(op,key=lambda r:(r.get('priority','P9'),r.get('repo',''))):
    print(f\"  [{x.get('status'):8}] {x.get('priority')} {x.get('repo'):16} {x.get('title','')[:60]} (model={x.get('recommendedModel') or 'tier-default'})\")
print(f'  -- {len(op)} open --')
"
  echo "Dashboard: $DASH/tasks   ·   $DASH/schedule"
  exit 0
fi

[ -n "$TITLE" ] || { echo "✗ --title is required" >&2; exit 2; }

# Consent gate — repos on the no-autonomous-schedule list (config/schedule_ignore.txt)
# must NOT be queued without the user's explicit consent (user directive 2026-06-16).
# Override for a single consented call: SCHEDULE_CONSENT=1 ./schedule_task.sh ...
IGNORE_FILE="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/config/schedule_ignore.txt"
if [ "${SCHEDULE_CONSENT:-0}" != "1" ] && [ -f "$IGNORE_FILE" ] \
   && grep -qxF "$REPO" <(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$IGNORE_FILE"); then
  echo "✗ '$REPO' is on the no-autonomous-schedule list (config/schedule_ignore.txt)." >&2
  echo "  This app does NOT get scheduled work without your clear consent." >&2
  echo "  To queue anyway (consented): SCHEDULE_CONSENT=1 $0 --title \"...\" ..." >&2
  exit 3
fi

# Default model: free-window Fable until the window closes, else tier-default (empty).
if [ -z "$MODEL" ]; then
  TODAY="$(date +%Y%m%d)"
  if [ "$TODAY" -lt "$FABLE_FREE_UNTIL" ]; then MODEL="claude-fable-5"; fi
fi

ARGS=$(python3 -c "
import json,sys
a={'repo':sys.argv[1],'title':sys.argv[2],'priority':sys.argv[4],'source':'manual'}
if sys.argv[3]: a['description']=sys.argv[3]
if sys.argv[5]: a['assignedAgent']=sys.argv[5]
if sys.argv[6]: a['recommendedModel']=sys.argv[6]
if sys.argv[7]: a['notes']=sys.argv[7]
print(json.dumps(a))
" "$REPO" "$TITLE" "$DESC" "$PRIORITY" "$AGENT" "$MODEL" "$NOTES")

mcp_call tasks_create "$ARGS" | python3 -c "
import sys,json
d=json.load(sys.stdin); r=json.loads(d['result']['content'][0]['text'])
print(f\"✓ Scheduled: {r.get('taskId')}\")
print(f\"  repo={r.get('repo')}  priority={r.get('priority')}  model={r.get('recommendedModel') or 'tier-default'}  agent={r.get('assignedAgent') or '-'}\")
print(f\"  title: {r.get('title')}\")
"
echo "The CLI runner will work it by priority on the free window. Check: $DASH/tasks  ·  $DASH/schedule"
