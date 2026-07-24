#!/usr/bin/env bash
# gateway.sh — resolve the GATEWAY_LOCAL_TOKEN escape hatch for host→gateway calls.
#
# WHY THIS EXISTS (root cause, 2026-06-18): since ADR-010 M1 made `tenancy.enforce`
# default ON (PR #238), the gateway 401s any request that is neither loopback nor
# carrying a matching `x-gateway-local-token`. Host shell scripts hit the *published*
# Docker port (localhost:3100), which the gateway sees as the bridge gateway IP
# (e.g. 172.17.0.1) — NOT 127.0.0.1 — so the loopback trust path fails. The scripts
# never sent the token, so EVERY host→gateway call (schedule_task, reprioritize,
# the CLI runner's default pickup, push_schedule, repo_card, fleet_resume) silently
# 401'd. `curl -sf` swallowed it, so it looked like "the queue is empty / nothing
# scheduled" when really the autonomous pipeline was dead. This lib fixes it: source
# it, then send the header.
#
#   bash:    -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN"
#   python:  pass GW_TOKEN="$GATEWAY_LOCAL_TOKEN" into the env, then
#            headers["x-gateway-local-token"] = os.environ["GW_TOKEN"]
#
# The token must MATCH the gateway's GATEWAY_LOCAL_TOKEN (docker-compose.yml /.env).
# Resolution order: existing env → repo .env (GATEWAY_LOCAL_TOKEN=) → compose default.
# For a hosted deployment, set a strong GATEWAY_LOCAL_TOKEN in .env on BOTH the
# gateway and wherever these scripts run.

_gw_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
if [ -z "${GATEWAY_LOCAL_TOKEN:-}" ]; then
  # lib lives at <root>/scripts/lib/ (master) or <root>/AI/scripts/lib/ (managed);
  # ../../.env is the repo/AI .env in both layouts.
  _gw_envf="$_gw_lib_dir/../../.env"
  if [ -f "$_gw_envf" ]; then
    _gw_t="$(grep -E '^GATEWAY_LOCAL_TOKEN=' "$_gw_envf" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'\''' | xargs 2>/dev/null)"
    [ -n "$_gw_t" ] && GATEWAY_LOCAL_TOKEN="$_gw_t"
  fi
fi
GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
export GATEWAY_LOCAL_TOKEN
