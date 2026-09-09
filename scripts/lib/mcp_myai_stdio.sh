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

# ── DEDICATED npm CACHE (do not "simplify" this away) ────────────────────────
# A single historical `sudo npm` leaves root-owned files in ~/.npm/_cacache that
# npm can no longer unlink, and EVERY later `npx` on that machine dies with
# `EACCES ... Your cache folder contains root-owned files`. That kills THIS
# wrapper at spawn, which means the myai server never connects and all ~180
# gateway tools (every brain_*) silently vanish from the session — the exact
# failure seen on runner-host 2026-08-27 (931 root-owned files dating
# from Jan-Mar 2026; the machine only hit it now because it hadn't booted the
# framework since the stdio wrapper landed on 11 Aug).
#
# Pointing npx at a cache dir we own makes the bridge immune to the state of the
# shared user cache. The permanent host fix is still `sudo chown -R 501:20
# ~/.npm`, but that needs a password and must never be what stands between an
# agent session and its own memory.
NPM_CONFIG_CACHE="${MYAI_NPM_CACHE:-$HOME/.npm-myai}"
export NPM_CONFIG_CACHE
mkdir -p "$NPM_CONFIG_CACHE" 2>/dev/null || true

exec npx -y mcp-remote "$MYAI_GATEWAY_MCP_URL" \
  --header "x-gateway-local-token:${GATEWAY_LOCAL_TOKEN}"
