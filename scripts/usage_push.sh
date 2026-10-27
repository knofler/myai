#!/usr/bin/env bash
# usage_push.sh — push THIS Mac's per-account usage (deduped hourly token
# buckets + real statusLine/agy readings) to the shared ledger (gateway tool
# account_usage_record). Multi-Mac phase 2, plan/MULTI_MAC_SWARM_BRIEF.md.
#
# Called on every CLI-runner launchd tick (scripts/cli_task_runner.sh, before
# any gate — so a Mac whose runner is role-gated still reports its usage) and
# safe to run by hand. Throttled: at most once per USAGE_PUSH_EVERY seconds
# (default 540) unless --force. Never fails its caller (gateway down → rc 0,
# one stderr line; the next tick retries — buckets are recomputed, not counted).
#
# Usage: usage_push.sh [--force] [--hours N] [--dry-run]
# Tests: scripts/tests/test_usage_ledger.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# MYAI_HOME is the per-user STATE dir. A framework checkout there (the old
# portable-compose meaning of the name, still set in some shells/.env files)
# put state files at the AI repo root on both Macs (2026-10-18) — ignore it.
_mh="${MYAI_HOME:-}"
if [ -n "$_mh" ] && [ -f "$_mh/scripts/lib/brain.sh" ] && [ -d "$_mh/runtime" ]; then _mh=""; fi
STATE_DIR="${_mh:-$HOME/.myai}/usage-push"
EVERY="${USAGE_PUSH_EVERY:-540}"
force=0; pass=()
while [ $# -gt 0 ]; do
  case "$1" in
    --force) force=1 ;;
    --dry-run) force=1; pass+=("--dry-run") ;;
    --hours) pass+=("--hours" "${2:?--hours N}"); shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
  shift
done
mkdir -p "$STATE_DIR" 2>/dev/null || true
now="$(date +%s)"; last="$(cat "$STATE_DIR/last" 2>/dev/null || echo 0)"
case "$last" in ''|*[!0-9]*) last=0 ;; esac
if [ "$force" = 0 ] && [ $((now - last)) -lt "$EVERY" ]; then exit 0; fi
if [ -z "${GATEWAY_LOCAL_TOKEN:-}" ] && [ -f "$HERE/lib/gateway.sh" ]; then
  # shellcheck source=scripts/lib/gateway.sh
  . "$HERE/lib/gateway.sh" 2>/dev/null || true
fi
export GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
# Which accounts to read: the named profiles (swarm_roles.sh
# role_profile_names — MYAI_PROFILES from the operator defaults file, else the
# ~/.claude-* dirs on disk). An exported USAGE_PROFILES still wins.
if [ -z "${USAGE_PROFILES:-}" ] && [ -f "$HERE/lib/swarm_roles.sh" ]; then
  # shellcheck disable=SC1091  # resolved at run time from $HERE
  _up="$( { . "$HERE/lib/operator_defaults.sh" && . "$HERE/lib/swarm_roles.sh" \
    && operator_defaults_load "$HERE/.." && role_profile_names; } 2>/dev/null \
    | while IFS= read -r _n; do printf '%s:%s ' "$_n" "$HOME/.claude-$_n"; done)" || _up=""
  [ -n "$_up" ] && export USAGE_PROFILES="${_up% }"
fi
if python3 "$HERE/lib/usage_push.py" ${pass[@]+"${pass[@]}"}; then
  printf '%s\n' "$now" > "$STATE_DIR/last" 2>/dev/null || true
fi
exit 0
