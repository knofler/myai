#!/usr/bin/env bash
# repo_card.sh — contribute THIS repo's entry to the myAI App Directory.
#
# Called by `wrap up` in every repo. Upserts the repo's card (description, local
# + deployed URLs, datastore, rolling status) into the gateway, which the
# dashboard /directory page renders as a one-point pointer across all apps.
#
# Zero-arg usage (what `wrap up` runs): auto-derives repoName + a git status
# summary, merges any static metadata from AI/state/app-card.json, auto-detects
# the Vercel URL (.vercel/project.json) and a local port (docker-compose), and
# upserts. Re-runnable; partial — only provided fields are written.
#
# Static metadata file (optional) — AI/state/app-card.json:
#   { "description": "...", "group": "...", "localhostUrl": "http://localhost:3000",
#     "appUrl": "...", "apiUrl": "...", "mongo": "Atlas cluster0 / db myapp",
#     "vercelUrl": "...", "dnsUrl": "..." }
#   Store NON-SECRET mongo info only (host + db name, never credentials).
#
# Flags override everything: --name --desc --group --localhost --app --api
#   --mongo --vercel --dns --status --level ok|warn|error|unknown --by --ahead
#
# --ahead <n>     override the auto-computed commits-ahead count (mainly for tests).
# --print-ahead   print the auto-computed commits-ahead count and exit 0 — no
#                 gateway call, no network. Hermetic seam for tests.
#
# Env: GATEWAY_MCP (default http://localhost:3100/mcp)
set -euo pipefail

GATEWAY_MCP=${GATEWAY_MCP:-http://localhost:3100/mcp}
. "$(dirname "$0")/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

NAME=""; DESC=""; GROUP=""; LOCAL=""; APP=""; API=""; MONGO=""; VERCEL=""; DNS=""; STATUS=""; LEVEL=""; BY=""; AHEAD=""; PRINT_AHEAD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --name) shift; NAME="${1:?}";;
    --desc|--description) shift; DESC="${1:?}";;
    --group) shift; GROUP="${1:?}";;
    --localhost) shift; LOCAL="${1:?}";;
    --app) shift; APP="${1:?}";;
    --api) shift; API="${1:?}";;
    --mongo) shift; MONGO="${1:?}";;
    --vercel) shift; VERCEL="${1:?}";;
    --dns) shift; DNS="${1:?}";;
    --status) shift; STATUS="${1:?}";;
    --level) shift; LEVEL="${1:?}";;
    --by) shift; BY="${1:?}";;
    --ahead) shift; AHEAD="${1:?}";;
    --print-ahead) PRINT_AHEAD=1;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac; shift
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
[ -n "$NAME" ] || NAME="$(basename "$ROOT")"

# Commits sitting on test that haven't reached main yet — the "pending ship it"
# signal for /apps. Reads only the local remote-tracking refs (no `git fetch`
# here — repo_card.sh runs at the tail of `wrap up`, right after a push, so
# origin/test is already fresh; a stale origin/main just under-counts by
# whatever landed on main since the last fetch, never wrongly over-counts).
if [ -z "$AHEAD" ]; then
  if git -C "$ROOT" rev-parse --verify -q origin/main >/dev/null 2>&1 \
     && git -C "$ROOT" rev-parse --verify -q origin/test >/dev/null 2>&1; then
    AHEAD="$(git -C "$ROOT" rev-list --count origin/main..origin/test 2>/dev/null || echo '')"
  fi
fi
if [ "$PRINT_AHEAD" = "1" ]; then
  echo "${AHEAD:-0}"
  exit 0
fi

# Locate the AI/ folder (this repo may be the master, or a managed repo with AI/).
AI_DIR="$ROOT/AI"; [ -d "$AI_DIR" ] || AI_DIR="$ROOT"
CARD_JSON="$AI_DIR/state/app-card.json"

# Gateway reachability.
if ! curl -sf -o /dev/null "${GATEWAY_MCP%/mcp}/health" 2>/dev/null; then
  echo "✗ Gateway not reachable at $GATEWAY_MCP — card not updated (non-fatal)." >&2
  exit 0   # never fail a wrap-up over the directory
fi

# Derive a git status summary + level if not supplied.
if [ -z "$STATUS" ]; then
  branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  last="$(git -C "$ROOT" log -1 --pretty='%h %s' 2>/dev/null | cut -c1-60 || echo 'no commits')"
  dirty="$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  when="$(TZ=Australia/Sydney date '+%d %b %H:%M AEST')"
  STATUS="branch=$branch · last: $last · uncommitted=$dirty · $when"
  if [ -z "$LEVEL" ]; then [ "$dirty" = "0" ] && LEVEL="ok" || LEVEL="warn"; fi
fi
[ -n "$LEVEL" ] || LEVEL="unknown"
[ -n "$BY" ] || BY="${CLAUDE_PROFILE:-$(basename "${CLAUDE_CONFIG_DIR:-claude}")}"

# Auto-detect Vercel URL from .vercel/project.json (projectName) if not set.
if [ -z "$VERCEL" ] && [ -f "$ROOT/.vercel/project.json" ]; then
  pn="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('projectName',''))" "$ROOT/.vercel/project.json" 2>/dev/null || true)"
  [ -n "$pn" ] && VERCEL="https://$pn.vercel.app"
fi
# Auto-detect a local port from docker-compose if no localhost set.
if [ -z "$LOCAL" ]; then
  compose="$(ls "$ROOT"/docker-compose*.y*ml 2>/dev/null | head -1 || true)"
  if [ -n "$compose" ]; then
    port="$(grep -oE '"?[0-9]{2,5}:[0-9]{2,5}"?' "$compose" 2>/dev/null | head -1 | tr -d '"' | cut -d: -f1 || true)"
    [ -n "$port" ] && LOCAL="http://localhost:$port"
  fi
fi

# Build the upsert args, layering: app-card.json (static) < auto-detect < flags.
ARGS=$(python3 - "$NAME" "$DESC" "$GROUP" "$LOCAL" "$APP" "$API" "$MONGO" "$VERCEL" "$DNS" "$STATUS" "$LEVEL" "$BY" "$CARD_JSON" "$AHEAD" <<'PY'
import json, os, sys
name,desc,group,local,app,api,mongo,vercel,dns,status,level,by,card_json,ahead = sys.argv[1:15]
out = {"repoName": name}
# 1) static file
if os.path.isfile(card_json):
    try:
        data = json.load(open(card_json))
        for k in ("description","group","localhostUrl","appUrl","apiUrl","mongo","vercelUrl","dnsUrl"):
            if data.get(k): out[k] = data[k]
    except Exception: pass
# 2) auto-detect / 3) flags (flags win)
flagmap = {"description":desc,"group":group,"localhostUrl":local,"appUrl":app,"apiUrl":api,
           "mongo":mongo,"vercelUrl":vercel,"dnsUrl":dns,"lastStatus":status,"lastStatusLevel":level,"reportedBy":by}
for k,v in flagmap.items():
    if v: out[k] = v
if ahead.strip() != "":
    try: out["commitsAhead"] = int(ahead.strip())
    except ValueError: pass
print(json.dumps(out))
PY
)

RESULT=$(curl -sf -X POST "$GATEWAY_MCP" -H 'content-type: application/json' \
  -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"repos_card_upsert\",\"arguments\":$ARGS}}")
echo "$RESULT" | python3 -c "
import sys,json
d=json.load(sys.stdin); r=json.loads(d['result']['content'][0]['text'])
c=r.get('card',{})
print(f\"✓ App Directory card updated: {c.get('repoName')} [{c.get('lastStatusLevel')}]\")
print(f\"  {c.get('lastStatus','')[:90]}\")
print('  → dashboard /directory')
" 2>/dev/null || { echo "card upsert response: $RESULT" | head -c 200; echo; }
