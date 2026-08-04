#!/usr/bin/env bash
# 23-brain-status.sh — Session-start BRAIN sign: the orange 🧠 line that shows
# the git-versioned agent memory is live. Renders the brain main SHA, atom
# counts (sessions/handoffs/memory), the last commit subject, and flags any
# open session/idea branches or pending stashes (uncommitted brain work).
#
# This is the CLI surface for the brain that was previously only visible on the
# dashboard /brain page. Non-fatal, always exits 0; gateway down → stay silent.
set +e

PORT="${MCP_PORT:-3100}"
URL="http://localhost:${PORT}/mcp"

# ── colors (disabled if NO_COLOR set) ───────────────────────
if [ -n "$NO_COLOR" ]; then B='' R='' G='' C='' Y='' D=''
else B=$'\033[1m'; R=$'\033[0m'; G=$'\033[1;38;5;208m'; C=$'\033[1;36m'; Y=$'\033[1;33m'; D=$'\033[2m'; fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

# Host→gateway calls MUST carry x-gateway-local-token (enforce=true 401s the
# Docker bridge IP otherwise). Same convention as 17-schedule-status.sh.
for _gwlib in "$ROOT/scripts/lib/gateway.sh" "$ROOT/AI/scripts/lib/gateway.sh"; do
    [ -f "$_gwlib" ] && . "$_gwlib" && break
done
GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

body=$(curl -sf -m 4 -X POST "$URL" -H 'content-type: application/json' \
    -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
    -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"brain_status","arguments":{}}}' 2>/dev/null \
    | B="$B" R="$R" G="$G" C="$C" Y="$Y" D="$D" /usr/bin/python3 -c '
import sys, json, os
B=os.environ["B"]; R=os.environ["R"]; G=os.environ["G"]; C=os.environ["C"]; Y=os.environ["Y"]; D=os.environ["D"]
try:
    d = json.loads(json.load(sys.stdin)["result"]["content"][0]["text"])
except Exception:
    sys.exit(0)
if not d.get("initialized"):
    sys.exit(0)
a = d.get("atoms", {}) or {}
sess = a.get("sessions", 0); hand = a.get("handoffs", 0); mem = a.get("memory", 0)
branch = d.get("branch", "?")
ns = d.get("namespaces", 0)
lc = (d.get("lastCommit") or "").strip()
# lastCommit is "<sha> brain(session): <repo>/<slug>"  → split sha + subject
sha = ""; subj = lc
if lc:
    parts = lc.split(None, 1)
    sha = parts[0]
    subj = parts[1] if len(parts) > 1 else ""
    subj = subj.replace("brain(session):", "").replace("brain(handoff):", "").strip()
open_br = d.get("branches", []) or []
stashes = d.get("stashes", []) or []

# line 1: the orange 🧠 sign
line1 = "%s🧠 BRAIN%s %s%s%s%s %s· %d sessions · %d handoffs · %d memory · %d ns%s" % (
    G, R, D, branch, (" "+sha) if sha else "", R, D, sess, hand, mem, ns, R)
# warn markers for uncommitted brain work
warn = ""
if open_br:
    warn += " %s· %d open branch%s%s" % (Y, len(open_br), "es" if len(open_br)!=1 else "", R)
if stashes:
    warn += " %s· %d stash%s%s" % (Y, len(stashes), "es" if len(stashes)!=1 else "", R)
print(line1 + warn)
if subj:
    print("   %slast: %s%s" % (D, subj, R))
' 2>/dev/null)

[ -z "$body" ] && exit 0   # gateway down / brain uninitialized — stay silent

printf '%s\n' "$body"
exit 0
