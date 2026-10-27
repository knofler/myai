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
#
# VERSION PIN (operator raised 2026-09-19): an unpinned `npx -y mcp-remote`
# resolves whatever is latest on npm at the moment each machine/session spawns
# this bridge — unreviewed third-party code landing straight on the agent's
# own memory path, and a source of cross-machine drift (one box silently runs
# a newer mcp-remote than another). MCP_REMOTE_VERSION pins every spawn to the
# same reviewed release; bump it deliberately, not by npm publishing upstream.
set -eu

MCP_REMOTE_VERSION="0.14.2"

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
# failure seen on one Mac on 2026-08-27 (931 root-owned files dating
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

# The caller's project (v1 G2 B6), forwarded as x-myai-repo so the gateway boots
# THIS repo's context instead of guessing: the brain namespace `myai init` wrote
# to .myai-local, else the checkout's canonical repo id (repo_id.sh — e.g. the
# master checkout's folder maps to its real id), else its folder name. Omitted
# when unknown or unclean.
_myai_root="${CLAUDE_PROJECT_DIR:-$PWD}"
_myai_repo=""
if [ -f "$_myai_root/.myai-local" ]; then
  _myai_repo="$(sed -n 's/.*"namespace"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_myai_root/.myai-local" 2>/dev/null | head -1)"
fi
if [ -z "$_myai_repo" ]; then
  # `|| …` on both lookups: under `set -eu` a failed assignment exits the
  # bridge silently, so a non-git folder got no MCP at all (2026-10-23).
  _myai_top="$(git -C "$_myai_root" rev-parse --show-toplevel 2>/dev/null)" || _myai_top=""
  if [ -n "$_myai_top" ]; then
    if [ -f "$_dir/repo_id.sh" ]; then
      # shellcheck source=./repo_id.sh disable=SC1091
      _myai_repo="$( . "$_dir/repo_id.sh" 2>/dev/null && canonical_repo_id "$_myai_top" 2>/dev/null )" || _myai_repo=""
    fi
    [ -n "$_myai_repo" ] || _myai_repo="$(basename "$_myai_top")"
  fi
fi
case "$_myai_repo" in ''|.|..|*[!A-Za-z0-9._-]*) _myai_repo="" ;; esac

# No gateway → the local server over the same brain (v1 G2 B2): one ≤1 s
# probe of the gateway's /health at spawn. Up → mcp-remote as before. Down
# (no Docker, or `myai down`) → scripts/lib/mcp_local_stdio.mjs, which serves
# the brain-only tools and says so in its initialize instructions; what it
# writes is what the gateway reads after `myai up`. The choice holds for the
# session: restart the agent after `myai up` for the full tool set.
# MYAI_MCP_TRANSPORT=remote|local forces one side (default auto).
_myai_gateway_up() {
  _myai_health="${MYAI_GATEWAY_MCP_URL%/mcp}/health"
  if command -v curl >/dev/null 2>&1; then
    [ "$(curl -s -m 1 -o /dev/null -w '%{http_code}' "$_myai_health" 2>/dev/null)" = 200 ]
  else
    node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' "$_myai_health" 2>/dev/null
  fi
}
case "${MYAI_MCP_TRANSPORT:-auto}" in
  local) _myai_local=1 ;;
  remote) _myai_local=0 ;;
  *) if _myai_gateway_up; then _myai_local=0; else _myai_local=1; fi ;;
esac
if [ "$_myai_local" = 1 ]; then
  echo "myai: no gateway at ${MYAI_GATEWAY_MCP_URL} — offline mode, serving your local brain (brain + recall only). Run \`myai up\` and restart the agent for the full tool set." >&2
  MYAI_REPO_HINT="$_myai_repo" exec node "$_dir/mcp_local_stdio.mjs"
fi

set -- --header "x-gateway-local-token:${GATEWAY_LOCAL_TOKEN}"
if [ -n "$_myai_repo" ]; then set -- "$@" --header "x-myai-repo:${_myai_repo}"; fi

exec npx -y "mcp-remote@${MCP_REMOTE_VERSION}" "$MYAI_GATEWAY_MCP_URL" "$@"
