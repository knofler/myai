#!/usr/bin/env bash
# myai_new_app.sh — `myai new-app <path|idea>`: two provisioning modes, one verb.
#
# WHY ONE VERB, TWO MODES (task-658282af): `myai new-app <path>` already
# shipped (README/CHANGELOG, tested) as the OFFLINE Powerhouse Blueprint
# scaffold (→ init_blueprint.sh). Separately, agentFlow shipped a headless
# idea→app pipeline (commit ac38bc0: `POST /api/headless/new-app`, token-gated
# via `x-gateway-local-token` — the SAME bridge token the myai gateway trusts,
# so no separate AGENTFLOW_TOKEN credential is needed for this local/headless
# path) built specifically so `myai new-app <idea>` could drive it end to end.
# Renaming either verb would break a documented, tested, public command, so
# this dispatches on the SHAPE of the argument instead:
#   • single token, no whitespace  → PATH mode  (delegates to init_blueprint.sh,
#     100% unchanged — --gh-create/--vercel/--mode/etc. all still work)
#   • contains whitespace, or      → IDEA mode  (headless agentFlow pipeline)
#     an explicit --idea "<text>" is passed
#
# Usage:
#   myai new-app <path> [init_blueprint.sh flags...]        # offline blueprint scaffold
#   myai new-app "<plain-English idea>" [idea flags...]      # headless agentFlow pipeline
#   myai new-app --idea "<idea>" [idea flags...]             # explicit idea mode
#
# Idea-mode flags:
#   --name <name>      Explicit project/repo name (default: slug of the idea)
#   --group <group>    Directory-card grouping label (default: Generated)
#   --no-trigger       Create the agentFlow project but don't auto-run the pipeline
#   --timeout <secs>   Max time to poll for pipeline completion (default 600)
#   --json             Machine-readable output (final result object only)
#
# Env:
#   AGENTFLOW_URL         agentFlow base URL (default http://host.docker.internal:3000,
#                         same default as runtime/src/repos/new-app.ts)
#   GATEWAY_LOCAL_TOKEN   local-bridge token — sent to BOTH agentFlow
#                         (x-gateway-local-token) and the myai gateway MCP
#                         (repos_upsert); resolved via lib/gateway.sh if unset
#   GATEWAY_MCP           myai gateway MCP endpoint used for repos_upsert
#                         registration (default http://localhost:3100/mcp)
#
# Response contract (best-effort — agentFlow is an external repo, so this is
# defensive against field-name variance): the headless endpoint may answer
# synchronously with a terminal {"status":"ok"|"error", ...} body, or
# asynchronously with {"runId"|"id", "status":"queued"|"running", ...} plus
# either a "statusUrl" or an implied `GET <base>/api/headless/new-app/<runId>`
# to poll. A 404 means the agentFlow integration is not enabled/deployed.
#
# Exit codes: 0 success · 1 pipeline error · 2 usage error ·
#             3 integration off / agentFlow unreachable · 4 timed out polling
#
# Tests: scripts/tests/test_myai_new_app.sh (stubs both the agentFlow headless
# endpoint and the gateway MCP endpoint — no real services touched).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

usage() {
  cat <<'EOF'
Usage:
  myai new-app <path> [init_blueprint.sh flags...]     # offline blueprint scaffold
  myai new-app "<idea>" [--name X] [--group G] [--no-trigger] [--timeout N] [--json]
  myai new-app --idea "<idea>" [same idea flags]

Dispatches by argument shape: a single-token argument (no whitespace) is
treated as a PATH (offline Powerhouse Blueprint scaffold — init_blueprint.sh);
an argument containing whitespace, or an explicit --idea "<text>", is treated
as a plain-English IDEA and drives agentFlow's headless idea->app pipeline.
EOF
}

if [ $# -eq 0 ]; then
  usage
  exit 1
fi
if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  usage
  exit 0
fi

MODE=""
IDEA=""

if [ "$1" = "--idea" ]; then
  MODE="idea"
  IDEA="${2:-}"
  if [ -z "$IDEA" ]; then
    echo "myai new-app: --idea requires a value" >&2
    exit 2
  fi
  shift 2
elif [[ "$1" == *[[:space:]]* ]]; then
  MODE="idea"
  IDEA="$1"
  shift
else
  MODE="path"
fi

# ── PATH mode: unchanged, delegate wholesale to init_blueprint.sh ─────────
if [ "$MODE" = "path" ]; then
  exec bash "$HERE/init_blueprint.sh" "$@"
fi

# ── IDEA mode: headless agentFlow pipeline ─────────────────────────────────
NAME=""
GROUP="Generated"
TRIGGER=1
TIMEOUT=600
AS_JSON=0

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --group) GROUP="$2"; shift 2 ;;
    --no-trigger) TRIGGER=0; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --json) AS_JSON=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "myai new-app: unknown idea-mode arg: $1" >&2; usage; exit 2 ;;
  esac
done

AGENTFLOW_URL="${AGENTFLOW_URL:-http://host.docker.internal:3000}"
GATEWAY_MCP="${GATEWAY_MCP:-http://localhost:3100/mcp}"
# shellcheck source=lib/gateway.sh
. "$HERE/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

GW_REACHABLE=0
curl -sf -o /dev/null --max-time 5 "${GATEWAY_MCP%/mcp}/health" 2>/dev/null && GW_REACHABLE=1

set +e
OUT="$(python3 - "$AGENTFLOW_URL" "$GATEWAY_LOCAL_TOKEN" "$IDEA" "$NAME" "$GROUP" "$TRIGGER" "$TIMEOUT" "$AS_JSON" "$GATEWAY_MCP" "$GW_REACHABLE" <<'PYEOF'
import json, re, sys, time, urllib.error, urllib.request

(base, token, idea, name, group, trigger, timeout, as_json, mcp, gw_reachable) = sys.argv[1:11]
base = base.rstrip('/')
trigger = trigger == "1"
timeout = float(timeout)
as_json = as_json == "1"
gw_reachable = gw_reachable == "1"

TERMINAL_OK = {"ok", "complete", "completed", "done", "success", "succeeded"}
TERMINAL_ERR = {"error", "failed", "failure"}

def slugify(text):
    slug = re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')
    parts = [p for p in slug.split('-') if p][:5]
    return '-'.join(parts) or 'new-app'

if not name:
    name = slugify(idea)

def http(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "content-type": "application/json",
        "x-gateway-local-token": token,
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read().decode()
            ctype = r.headers.get("content-type", "")
            return r.status, raw, ctype
    except urllib.error.HTTPError as e:
        raw = e.read().decode() if e.fp else ""
        return e.code, raw, e.headers.get("content-type", "") if e.headers else ""
    except Exception as e:
        return None, str(e), ""

def parse(raw):
    try:
        return json.loads(raw)
    except Exception:
        return {}

result = {"ok": False, "name": name, "mode": "idea", "message": "", "error": None}

status, raw, ctype = http("POST", f"{base}/api/headless/new-app", {
    "idea": idea, "name": name, "trigger": trigger,
})

if status is None:
    result["error"] = f"agentFlow unreachable at {base}: {raw}"
    result["message"] = result["error"]
    print(json.dumps(result))
    sys.exit(3)

if status == 404:
    result["error"] = f"agentFlow headless integration not enabled at {base} (404 from /api/headless/new-app)"
    result["message"] = result["error"]
    print(json.dumps(result))
    sys.exit(3)

if status >= 400:
    result["error"] = f"agentFlow headless new-app failed (HTTP {status}): {raw[:200]}"
    result["message"] = result["error"]
    print(json.dumps(result))
    sys.exit(1)

body = parse(raw)
run_id = body.get("runId") or body.get("id") or body.get("pipelineId")
status_url = body.get("statusUrl") or (f"{base}/api/headless/new-app/{run_id}" if run_id else None)
cur_status = str(body.get("status") or ("ok" if body.get("ok") else "")).lower()

# ── Poll until terminal or timeout, if the pipeline is still in flight ─────
deadline = time.time() + timeout
last_status = cur_status
while cur_status not in TERMINAL_OK and cur_status not in TERMINAL_ERR:
    if not status_url or time.time() >= deadline:
        break
    time.sleep(2)
    pstatus, praw, _ = http("GET", status_url)
    if pstatus is None or pstatus == 404:
        break
    pbody = parse(praw)
    if pbody:
        body = pbody
    cur_status = str(body.get("status") or "").lower()
    if cur_status != last_status:
        if not as_json:
            print(f"  ... {cur_status or 'running'}", file=sys.stderr)
        last_status = cur_status

repo_name = body.get("name") or name
repo_path = body.get("path") or body.get("repoPath")
repo_url = body.get("repoUrl") or body.get("gitRemote") or body.get("projectUrl")
repo_stack = body.get("stack") or body.get("techStack") or []
if isinstance(repo_stack, str):
    repo_stack = [repo_stack]

if cur_status in TERMINAL_ERR:
    result["error"] = body.get("error") or body.get("message") or "agentFlow pipeline reported an error"
    result["message"] = result["error"]
    print(json.dumps(result))
    sys.exit(1)

if cur_status not in TERMINAL_OK:
    # Not terminal: either fire-and-forget (no runId to poll, trigger accepted)
    # or a real timeout waiting on a runId. Only the latter is an error.
    if run_id and time.time() >= deadline:
        result["error"] = f"timed out after {int(timeout)}s waiting for agentFlow pipeline (runId={run_id}); it may still be running — check {base}"
        result["message"] = result["error"]
        result["runId"] = run_id
        print(json.dumps(result))
        sys.exit(4)
    result["ok"] = True
    result["runId"] = run_id
    result["message"] = f"agentFlow new-app queued ({cur_status or 'accepted'}) — runId={run_id or 'n/a'}"
    print(json.dumps(result))
    sys.exit(0)

# ── Terminal success: register the produced repo (ADR-021) ────────────────
result["ok"] = True
result["name"] = repo_name
result["path"] = repo_path
result["repoUrl"] = repo_url
result["message"] = body.get("message") or "agentFlow new-app pipeline complete"
result["registered"] = False

if gw_reachable and repo_path:
    reg_args = {"name": repo_name, "path": repo_path, "source": "headless-new-app", "group": group}
    if repo_url:
        reg_args["gitRemote"] = repo_url
    if repo_stack:
        reg_args["stack"] = repo_stack
    mcp_body = json.dumps({"jsonrpc": "2.0", "method": "tools/call", "id": 1,
                            "params": {"name": "repos_upsert", "arguments": reg_args}}).encode()
    mcp_req = urllib.request.Request(mcp, data=mcp_body, method="POST", headers={
        "content-type": "application/json", "x-gateway-local-token": token,
    })
    try:
        with urllib.request.urlopen(mcp_req, timeout=15) as r:
            mcp_resp = json.loads(r.read().decode())
        if "error" not in mcp_resp:
            result["registered"] = True
        else:
            result["registerError"] = str(mcp_resp["error"])
    except Exception as e:
        result["registerError"] = str(e)
elif not gw_reachable:
    result["registerError"] = "myai gateway not reachable — repo not registered (run `myai up` then re-run)"
elif not repo_path:
    result["registerError"] = "agentFlow did not report a local path for the produced repo — skipped registration"

print(json.dumps(result))
sys.exit(0)
PYEOF
)"
RC=$?
set -e

if [ "$AS_JSON" = 1 ]; then
  printf '%s\n' "$OUT"
  exit "$RC"
fi

NAME_OUT="$(printf '%s' "$OUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("name") or "")' 2>/dev/null || true)"
MSG_OUT="$(printf '%s' "$OUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("message") or "")' 2>/dev/null || true)"
PATH_OUT="$(printf '%s' "$OUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("path") or "")' 2>/dev/null || true)"
ERR_OUT="$(printf '%s' "$OUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("error") or "")' 2>/dev/null || true)"
REG_OUT="$(printf '%s' "$OUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("1" if d.get("registered") else "0")' 2>/dev/null || echo 0)"
REG_ERR_OUT="$(printf '%s' "$OUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("registerError") or "")' 2>/dev/null || true)"

echo "myAI — New App (headless via agentFlow)"
echo "════════════════════════════════════════"
echo "  Idea:   $IDEA"
[ -n "$NAME_OUT" ] && echo "  Name:   $NAME_OUT"
[ -n "$PATH_OUT" ] && echo "  Path:   $PATH_OUT"
echo "  Status: ${MSG_OUT:-unknown}"
if [ "$REG_OUT" = "1" ]; then
  echo "  Registered in fleet roster (repos_upsert)"
elif [ -n "$REG_ERR_OUT" ]; then
  echo "  Registration: $REG_ERR_OUT"
fi
if [ -n "$ERR_OUT" ]; then
  echo "  Error:  $ERR_OUT" >&2
fi

exit "$RC"
