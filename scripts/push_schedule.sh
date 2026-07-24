#!/usr/bin/env bash
# push_schedule.sh — ingest a repo's committed schedule artifact into the local
# gateway (the "master runner" on THIS Mac). The cross-device bridge:
#   • Mobile/cloud `schedule plan` can't reach localhost:3100 — it just commits
#     AI/plan/schedule.json and merges to main.
#   • A CLI `agent mode -a` on any Mac runs this to register that schedule with
#     the gateway: plan_set (→ dashboard /plan) + schedule_task for each task.
# Idempotent: records the ingested artifact's git blob hash in
# AI/state/.schedule-ingested and skips if unchanged.
#
# Artifact format — AI/plan/schedule.json (master: plan/schedule.json):
#   { "repo":"name", "startDate":"YYYY-MM-DD",
#     "days":[{"day":1,"focus":"...","status":"enabled"}, ...],
#     "tasks":[{"title":"...","priority":"P1","agent":"...","category":"...","day":1}, ...] }
#
# Usage: ./AI/scripts/push_schedule.sh            # this repo
#        ./AI/scripts/push_schedule.sh --force    # re-ingest even if unchanged
# Env: GATEWAY_MCP (default http://localhost:3100/mcp)
set -euo pipefail
GATEWAY_MCP=${GATEWAY_MCP:-http://localhost:3100/mcp}
. "$(dirname "$0")/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
FORCE=false; [ "${1:-}" = "--force" ] && FORCE=true

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
AI_DIR="$ROOT/AI"; [ -d "$AI_DIR" ] || AI_DIR="$ROOT"
ART="$AI_DIR/plan/schedule.json"
SENTINEL="$AI_DIR/state/.schedule-ingested"
[ -f "$ART" ] || { echo "no schedule artifact at $ART — nothing to ingest"; exit 0; }

# Skip if already ingested (same content) unless --force.
HASH="$(git -C "$ROOT" hash-object "$ART" 2>/dev/null || shasum "$ART" | cut -d' ' -f1)"
if [ "$FORCE" != true ] && [ -f "$SENTINEL" ] && grep -q "$HASH" "$SENTINEL" 2>/dev/null; then
    echo "schedule.json unchanged (already ingested) — skip"; exit 0
fi

# Deliberately probes /health/deep, not the shallow /health — the shallow
# endpoint always answers HTTP 200 even when MongoDB is unreachable (other
# scripts rely on that as a pure process-liveness probe), so a bare
# `curl -sf` against it never trips even when ingested tasks would silently
# vanish into a broken store (2026-07-06 localhost:27017-misdirection
# incident). /health/deep actually pings Mongo and returns non-2xx when down.
_deep_rc=0
_deep="$(curl -s -m 8 -w '\n%{http_code}' "${GATEWAY_MCP%/mcp}/health/deep" 2>/dev/null)" || _deep_rc=$?
_deep_status="${_deep##*$'\n'}"
_deep_body="${_deep%$'\n'*}"
if [ $_deep_rc -ne 0 ] || [ -z "$_deep_status" ]; then
    echo "✗ gateway not reachable at $GATEWAY_MCP — cannot push schedule (run on the gateway Mac)"; exit 0
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
    echo "✗ gateway is unhealthy (HTTP $_deep_status, mongodb=$_mongo_state) — refusing to ingest a schedule that would silently vanish." >&2
    echo "  Check MONGODB_URI in the gateway's .env — it must point at the compose service host (e.g. 'mongo'), not 'localhost'." >&2
    exit 1
fi

# Consent gate — skip repos on the no-autonomous-schedule list unless consented
# (user directive 2026-06-16). Override: SCHEDULE_CONSENT=1 ./push_schedule.sh
IGNORE_FILE="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/config/schedule_ignore.txt"
ART_REPO="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("repo",""))' "$ART" 2>/dev/null)"
if [ "${SCHEDULE_CONSENT:-0}" != "1" ] && [ -f "$IGNORE_FILE" ] && [ -n "$ART_REPO" ] \
   && grep -qxF "$ART_REPO" <(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$IGNORE_FILE"); then
  echo "↷ '$ART_REPO' is on the no-autonomous-schedule list — NOT ingesting plan/tasks."
  echo "  This app needs your explicit consent. To ingest anyway: SCHEDULE_CONSENT=1 $0"
  exit 0
fi

SCHED_SCRIPT="$(dirname "$0")/schedule_task.sh"
GATEWAY_MCP="$GATEWAY_MCP" ART="$ART" SCHED="$SCHED_SCRIPT" GW_TOKEN="$GATEWAY_LOCAL_TOKEN" /usr/bin/python3 - <<'PY'
import json, os, subprocess, urllib.request
MCP=os.environ["GATEWAY_MCP"]; art=os.environ["ART"]; sched=os.environ["SCHED"]; GW_TOKEN=os.environ.get("GW_TOKEN","")
d=json.load(open(art))
repo=d["repo"]
def call(n,a):
    b=json.dumps({"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":n,"arguments":a}}).encode()
    return urllib.request.urlopen(urllib.request.Request(MCP,data=b,headers={"content-type":"application/json","x-gateway-local-token":GW_TOKEN}),timeout=30).read()
# 1) plan_set (dashboard /plan view)
if d.get("days"):
    call("plan_set",{"repo":repo,"startDate":d.get("startDate"),"replace":True,"days":d["days"]})
    print(f"  plan_set: {len(d['days'])} days for {repo}")
# 2) schedule_task each work item (the runner queue). check=False on purpose
# (one bad task shouldn't abort the rest) but the result is NOT discarded —
# a swallowed failure here is exactly the class of bug this task exists to
# close, so every non-zero exit is reported and turns into a hard exit code.
n=0
failed=0
for t in d.get("tasks",[]):
    cmd=[sched,"--repo",repo,"--title",t["title"],"--priority",t.get("priority","P2"),
         "--model",t.get("model","claude-fable-5")]
    if t.get("agent"): cmd+=["--agent",t["agent"]]
    notes=f"[{t.get('category','')}] day {t.get('day','?')} | from schedule.json"
    if t.get("desc"): cmd+=["--desc",t["desc"]]
    cmd+=["--notes",notes]
    r=subprocess.run(cmd,check=False,capture_output=True,text=True)
    if r.returncode != 0:
        failed+=1
        print(f"  ✗ failed to schedule '{t['title']}' (exit {r.returncode}): {(r.stderr or r.stdout).strip()}")
    else:
        n+=1
print(f"  scheduled {n} tasks for {repo}" + (f" — {failed} FAILED" if failed else ""))
if failed:
    raise SystemExit(1)
PY

mkdir -p "$(dirname "$SENTINEL")"
echo "$HASH  $(date -u +%FT%TZ)" > "$SENTINEL"
echo "✓ schedule ingested into gateway for $(basename "$ROOT") → dashboard /plan + /schedule"
