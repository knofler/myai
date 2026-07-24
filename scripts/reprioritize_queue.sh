#!/usr/bin/env bash
# reprioritize_queue.sh — enforce the CORE-PRODUCT schedule priority (user directive
# 2026-06-16). The myAI sellable platform (config/schedule_priority.txt: AI/ai_management/
# agentFlow/connect) must always sit ABOVE every other repo in the autonomous runner queue.
#
# Action: any PENDING task whose repo is NOT in the core list and whose priority is
# higher than P3 is capped to P3 (bottom of the queue). Core repos are left untouched —
# they keep their P0/P1/P2 ordering. Idempotent; safe to run every session.
#
# Run it at `agent mode` start and in `wrap up`, or any time the queue looks inverted.
#   ./scripts/reprioritize_queue.sh            # apply
#   ./scripts/reprioritize_queue.sh --dry-run  # show what would change
# Env: GATEWAY_MCP (default http://localhost:3100/mcp)
set -euo pipefail
GATEWAY_MCP=${GATEWAY_MCP:-http://localhost:3100/mcp}
. "$(dirname "$0")/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
DRY=false; [ "${1:-}" = "--dry-run" ] && DRY=true
CFG_DIR="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/config"
PRIO_FILE="$CFG_DIR/schedule_priority.txt"
FOCUS_FILE="$CFG_DIR/schedule_focus.txt"

if ! curl -sf -o /dev/null "${GATEWAY_MCP%/mcp}/health" 2>/dev/null; then
  echo "↷ gateway not reachable at $GATEWAY_MCP — skip (run on the gateway Mac)"; exit 0
fi
[ -f "$PRIO_FILE" ] || { echo "no $PRIO_FILE — nothing to enforce"; exit 0; }

GATEWAY_MCP="$GATEWAY_MCP" PRIO_FILE="$PRIO_FILE" FOCUS_FILE="$FOCUS_FILE" DRY="$DRY" GW_TOKEN="$GATEWAY_LOCAL_TOKEN" /usr/bin/python3 - <<'PY'
import json, os, urllib.request
MCP=os.environ["GATEWAY_MCP"]; dry=os.environ["DRY"]=="true"; GW_TOKEN=os.environ.get("GW_TOKEN","")
def _load(path):
    s=set()
    if path and os.path.exists(path):
        for ln in open(path):
            ln=ln.strip()
            if ln and not ln.startswith("#"): s.add(ln)
    return s
focus=_load(os.environ.get("FOCUS_FILE",""))
core=set()
for ln in open(os.environ["PRIO_FILE"]):
    ln=ln.strip()
    if ln and not ln.startswith("#"): core.add(ln)
def call(n,a):
    b=json.dumps({"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":n,"arguments":a}}).encode()
    d=json.loads(urllib.request.urlopen(urllib.request.Request(MCP,data=b,headers={"content-type":"application/json","x-gateway-local-token":GW_TOKEN}),timeout=30).read())
    return json.loads(d["result"]["content"][0]["text"]) if "result" in d else d
def rank(p): return {"P0":0,"P1":1,"P2":2,"P3":3}.get(p,3)
NOTE_F="capped to P2: focus-tier app — betaC core (%s) drains first, but focus apps outrank all other repos (user directive 2026-06-18, plan/PRODUCT_FOCUS.md)." % "/".join(sorted(core))
NOTE_3="capped to P3: core myAI platform (%s) + focus apps take schedule-build priority (user directive 2026-06-16/18)." % "/".join(sorted(core))
tasks=call("tasks_list",{"status":"pending","limit":500}).get("tasks",[])
n_f=n_3=0
for t in tasks:
    repo=t["repo"]; cur=t.get("priority","P3")
    if repo in core: continue                      # core trio — untouched
    if repo in focus:                              # focus tier — floor at P2
        if rank(cur) < rank("P2"):
            print(f"  {'(dry) ' if dry else ''}{cur}→P2  {repo:14} {t['title'][:50]}")
            if not dry: call("tasks_update",{"taskId":t["taskId"],"priority":"P2","notes":NOTE_F})
            n_f+=1
    else:                                          # everything else — floor at P3
        if cur!="P3":
            print(f"  {'(dry) ' if dry else ''}{cur}→P3  {repo:14} {t['title'][:50]}")
            if not dry: call("tasks_update",{"taskId":t["taskId"],"priority":"P3","notes":NOTE_3})
            n_3+=1
print(f"{'Would cap' if dry else 'Capped'}: {n_f} focus task(s)→P2, {n_3} other→P3. Core: {', '.join(sorted(core))}; Focus: {', '.join(sorted(focus))}")
PY
