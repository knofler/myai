#!/usr/bin/env bash
# mcp_myai_stdio.sh — stdio bridge for the myai MCP server (task-35c9e181).
#
# ROOT CAUSE this fixes: .mcp.json's old `"type": "http"` entry sent the header
# `x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}`. Claude Code substitutes that
# `${VAR}` from ITS OWN launch environment — it never reads this repo's .env. If
# the launching shell hadn't exported GATEWAY_LOCAL_TOKEN (the common case — see
# RUNBOOK.md §7's old per-machine ~/.zshrc workaround), the header went out BLANK,
# the gateway 401'd the handshake, the myai server never connected, and all 134
# tools (incl. every brain_*) silently vanished from the session.
#
# FIX: make Claude Code spawn THIS script as a stdio server instead of dialing
# the URL directly. This script resolves GATEWAY_LOCAL_TOKEN itself by sourcing
# gateway.sh, which reads it straight off disk (repo/AI .env) — completely
# independent of whatever environment Claude Code happened to inherit. The
# resolved value is passed to mcp-remote as a literal --header argument, so no
# ${VAR} substitution ever has to happen inside Claude Code's process.
#
# mcp-remote (https://www.npmjs.com/package/mcp-remote) bridges stdio<->HTTP,
# the same npx-on-demand pattern this repo already uses for context7/shadcn-ui/
# playwright/docker in .mcp.json — no new install step, no Docker dependency.
set -eu

_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"

# gateway.sh lives right next to this script in both layouts (master:
# scripts/lib/, managed: AI/scripts/lib/) — no path-guessing needed.
if [ -f "$_dir/gateway.sh" ]; then
  # shellcheck source=./gateway.sh
  . "$_dir/gateway.sh"
else
  echo "mcp_myai_stdio.sh: gateway.sh not found next to this script ($_dir) — cannot resolve GATEWAY_LOCAL_TOKEN" >&2
  exit 1
fi

MYAI_GATEWAY_MCP_URL="${MYAI_GATEWAY_MCP_URL:-http://localhost:${MCP_PORT:-3100}/mcp}"

exec npx -y mcp-remote "$MYAI_GATEWAY_MCP_URL" \
  --header "x-gateway-local-token:${GATEWAY_LOCAL_TOKEN}"
