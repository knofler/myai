#!/usr/bin/env bash
# 24-myai-mcp-health.sh — LOUD session-start check: never let the myai MCP
# server go dark silently again (task-35c9e181, P0).
#
# PAST INCIDENT this guards against: .mcp.json's myai entry was `"type": "http"`
# with header `x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}`. Claude Code
# substitutes that ${VAR} from ITS OWN launch environment, not this repo's
# .env — so on any shell that hadn't manually exported the token, the header
# went out blank, the gateway 401'd, myai never connected, and all 134 tools
# (every brain_*) silently vanished. Nothing surfaced this — the session just
# quietly fell back to file reads/grep, burning the ~79.6x cold-boot saving
# brain_delta exists for, for an entire session, unnoticed.
#
# Fixed by switching .mcp.json's myai entry to a command-type wrapper
# (scripts/lib/mcp_myai_stdio.sh) that resolves the token itself, off disk,
# independent of Claude Code's inherited env. THIS hook is the regression
# guard: it replicates that same handshake at session start and shouts if it
# would fail, so a revert or a broken token can never go unnoticed again.
set +e

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
MCPFILE="$ROOT/.mcp.json"
[ -f "$MCPFILE" ] || exit 0   # no .mcp.json here — nothing to verify

HAS_MYAI=$(/usr/bin/python3 -c "
import json, sys
try:
    d = json.load(open('$MCPFILE'))
except Exception:
    sys.exit(1)
print('yes' if 'myai' in (d.get('mcpServers') or {}) else 'no')
" 2>/dev/null)
[ "$HAS_MYAI" = "yes" ] || exit 0   # myai isn't declared here — nothing to verify

FAIL_REASON=""

# The wrapper this fix installs lives next to gateway.sh in either layout.
WRAPPER=""
for w in "$ROOT/scripts/lib/mcp_myai_stdio.sh" "$ROOT/AI/scripts/lib/mcp_myai_stdio.sh"; do
  [ -f "$w" ] && WRAPPER="$w" && break
done
if [ -z "$WRAPPER" ]; then
  FAIL_REASON="myai is declared in .mcp.json but mcp_myai_stdio.sh is missing (expected scripts/lib/ or AI/scripts/lib/) — the entry may have reverted to the old broken direct-http+env-substitution pattern."
elif [ ! -x "$WRAPPER" ]; then
  FAIL_REASON="myai wrapper found at $WRAPPER but is not executable — run: chmod +x $WRAPPER"
fi

# Replicate the wrapper's own handshake: resolve the token the same way it
# does, then probe the gateway directly (fast fail — 5s timeout).
if [ -z "$FAIL_REASON" ]; then
  for _gwlib in "$ROOT/scripts/lib/gateway.sh" "$ROOT/AI/scripts/lib/gateway.sh"; do
    [ -f "$_gwlib" ] && . "$_gwlib" && break
  done
  PORT="${MCP_PORT:-3100}"
  URL="http://localhost:${PORT}/mcp"
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST "$URL" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"mcp-health-check","version":"1"}}}' \
    2>/dev/null)
  case "$STATUS" in
    200) : ;;   # handshake succeeds — tools will register
    401|403)
      FAIL_REASON="gateway rejected the myai MCP handshake (HTTP $STATUS unauthorized) — GATEWAY_LOCAL_TOKEN did not resolve to a value the gateway accepts. Check .env / AI/.env and scripts/lib/gateway.sh."
      ;;
    000|"")
      FAIL_REASON="gateway at $URL is unreachable — myai MCP tools will be unavailable this session (docker compose ps: is myai-gateway up?)."
      ;;
    *)
      FAIL_REASON="gateway returned unexpected HTTP $STATUS for the myai MCP handshake — tools may not load. See documentation/RUNBOOK.md §7."
      ;;
  esac
fi

[ -z "$FAIL_REASON" ] && exit 0

if [ -n "$NO_COLOR" ]; then RED=''; RESET=''; BOLD=''
else RED=$'\033[1;31m'; RESET=$'\033[0m'; BOLD=$'\033[1m'; fi

{
  echo "${RED}${BOLD}!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!${RESET}"
  echo "${RED}${BOLD}  MYAI MCP HEALTH CHECK FAILED — tools (incl. all brain_*) may be dark${RESET}"
  echo "${RED}${BOLD}!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!${RESET}"
  echo "  $FAIL_REASON"
  echo "  This session may silently fall back to file reads/grep instead of"
  echo "  brain_delta/brain_search — the exact regression task-35c9e181 fixed."
  echo "  Fix: documentation/RUNBOOK.md §7."
  echo "${RED}${BOLD}!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!${RESET}"
} >&2

exit 0
