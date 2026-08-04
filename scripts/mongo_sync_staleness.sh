#!/usr/bin/env bash
# mongo_sync_staleness.sh — independent staleness canary for mongo_sync.sh
# (ADR-022 local-first mongo mode). ADR-022's scheduling section says to run
# mongo_sync.sh on a timer, but a timer that silently stops converging (mongo
# down every run, docker not running, disk full, the LaunchAgent/cron entry
# itself got removed) is exactly the "operator has to remember" gap this ADR
# exists to close — nobody would notice until they went looking. This script
# re-checks state/.mongo_sync_last (the timestamp mongo_sync.sh writes on
# every SUCCESSFUL sync) on its OWN independent schedule and raises a
# notification-engine alert the moment convergence has gone stale, same
# alerting mechanism as brain_sync_canary.sh (never duplicated, mirrored).
#
# Usage:
#   ./scripts/mongo_sync_staleness.sh            # run once: check, alert if stale
#   ./scripts/mongo_sync_staleness.sh --status    # print last recorded check, no run
#
# "Stale" = no recorded successful sync at all, OR the last successful sync is
# older than MONGO_SYNC_STALE_MINUTES (default 150 — 2.5x the mirror's own
# hourly default cadence, matching the "more than two intervals" language
# `myai doctor` already uses for the mirror's own staleness check). Alerts
# ONLY when stale (never on a healthy check — noise, per the notification
# service's own design, same rationale as brain_sync_canary.sh).
#
# Env: MONGO_SYNC_LOG (default state/.mongo_sync_last — SAME file mongo_sync.sh
#      writes, never a second source of truth), MONGO_SYNC_STALE_MINUTES
#      (default 150), GATEWAY_MCP (default http://localhost:3100/mcp),
#      GATEWAY_LOCAL_TOKEN (auto-resolved via lib/gateway.sh),
#      MONGO_SYNC_STALENESS_STATE (default ~/.myai/mongo-sync-staleness.state
#      — last-check record for --status).
#
# Library mode (unit tests): MONGO_SYNC_STALENESS_LIB_ONLY=1 sources the pure
# helpers only (parse_iso8601_epoch / is_stale / format_alert) and runs
# nothing — no filesystem, no network.
set +e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SYNC_LOG="${MONGO_SYNC_LOG:-$REPO_ROOT/state/.mongo_sync_last}"
STALE_MINUTES="${MONGO_SYNC_STALE_MINUTES:-150}"
GATEWAY_MCP="${GATEWAY_MCP:-http://localhost:3100/mcp}"
MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
STATE_FILE="${MONGO_SYNC_STALENESS_STATE:-$MYAI_HOME/mongo-sync-staleness.state}"

. "$SCRIPT_DIR/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

log() { echo "[mongo-sync-staleness $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# parse_iso8601_epoch <YYYY-MM-DDTHH:MM:SSZ> → epoch seconds, or empty on
# parse failure. BSD date (-j -f, macOS) first, GNU date (-d) fallback.
parse_iso8601_epoch() {
  local iso="${1:-}"
  [ -n "$iso" ] || return 1
  date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%s 2>/dev/null || date -u -d "$iso" +%s 2>/dev/null
}

# is_stale <last_epoch_or_empty> <now_epoch> <threshold_minutes> — 0 (stale,
# alert) if there is no recorded successful sync at all, or the age exceeds
# the threshold; 1 (fresh, no alert) otherwise. Pure arithmetic, no I/O.
is_stale() {
  local last="${1:-}" now="${2:-0}" threshold_min="${3:-150}"
  [ -n "$last" ] || return 0
  local age=$(( now - last ))
  [ "$age" -gt $(( threshold_min * 60 )) ]
}

# format_alert <last_at_or_empty> <primary_or_empty> <age_seconds_or_empty> <threshold_min> <host>
format_alert() {
  local last_at="$1" primary="$2" age_s="$3" threshold_min="$4" host="$5" when age_desc
  if [ -z "$last_at" ]; then
    when="no successful sync has ever been recorded"
  else
    if [ -n "$age_s" ] && [ "$age_s" -ge 0 ] 2>/dev/null; then
      age_desc="$(( age_s / 3600 ))h $(( (age_s % 3600) / 60 ))m"
    else
      age_desc="unknown"
    fi
    when="last successful sync was at $last_at (primary=${primary:-unknown}), ${age_desc} ago"
  fi
  printf 'mongo_sync.sh convergence is STALE on %s: %s (threshold: %sm).\n\nThis means Atlas/local Mongo may be diverging silently — ADR-022 local-first mode depends on this timer running. Investigate: ./scripts/mongo_sync.sh status, ./scripts/mongo_sync.sh schedule status, docker ps.' \
    "$host" "$when" "$threshold_min"
}

# send_alert <message> — same mechanism as brain_sync_canary.sh: POST
# notifications_send via the gateway MCP endpoint, falling back to
# notify-telegram.sh directly if the gateway itself is unreachable.
send_alert() {
  local message="$1" body resp rc
  body="$(MSG="$message" /usr/bin/python3 -c '
import json, os
msg = os.environ["MSG"]
print(json.dumps({
  "jsonrpc": "2.0", "method": "tools/call", "id": 1,
  "params": {"name": "notifications_send", "arguments": {
    "message": msg, "level": "critical", "title": "Mongo Sync Staleness Alert",
    "source": "mongo-sync-staleness",
  }},
}))
')"
  resp="$(curl -sf -m 10 -X POST "$GATEWAY_MCP" -H 'content-type: application/json' \
    -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" -d "$body" 2>/dev/null)"
  rc=$?
  if [ $rc -eq 0 ] && [ -n "$resp" ]; then
    log "alert sent via gateway notifications_send."
    return 0
  fi
  log "WARN: gateway notifications_send unreachable (rc=$rc) — falling back to notify-telegram.sh directly."
  "${MONGO_SYNC_STALENESS_TELEGRAM_SCRIPT:-$SCRIPT_DIR/notify-telegram.sh}" error "Mongo Sync Staleness Alert: $message" >/dev/null 2>&1
  return $?
}

# ── unit-test hook ──────────────────────────────────────────────────────────
if [ "${MONGO_SYNC_STALENESS_LIB_ONLY:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

if [ "${1:-}" = "--status" ]; then
  if [ -f "$STATE_FILE" ]; then cat "$STATE_FILE"; exit 0; fi
  echo "mongo-sync-staleness: no prior check recorded ($STATE_FILE missing)."
  exit 0
fi

HOST="$(hostname -s 2>/dev/null || echo unknown)"
LAST_AT="" LAST_PRIMARY="" LAST_EPOCH=""
if [ -f "$SYNC_LOG" ]; then
  LAST_AT="$(grep -o 'at=[^ ]*' "$SYNC_LOG" 2>/dev/null | head -1 | cut -d= -f2)"
  LAST_PRIMARY="$(grep -o 'primary=[^ ]*' "$SYNC_LOG" 2>/dev/null | head -1 | cut -d= -f2)"
  LAST_EPOCH="$(parse_iso8601_epoch "$LAST_AT")"
fi
NOW="$(date -u +%s)"
AGE=""
[ -n "$LAST_EPOCH" ] && AGE=$(( NOW - LAST_EPOCH ))

mkdir -p "$(dirname "$STATE_FILE")"

if is_stale "$LAST_EPOCH" "$NOW" "$STALE_MINUTES"; then
  {
    echo "status=stale"
    echo "host=$HOST"
    echo "last_at=${LAST_AT:-never}"
    echo "age_seconds=${AGE:-unknown}"
    echo "threshold_minutes=$STALE_MINUTES"
    echo "checked_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$STATE_FILE"
  log "STALE — last_at=${LAST_AT:-never} threshold=${STALE_MINUTES}m"
  send_alert "$(format_alert "$LAST_AT" "$LAST_PRIMARY" "$AGE" "$STALE_MINUTES" "$HOST")"
  exit 1
fi

{
  echo "status=ok"
  echo "host=$HOST"
  echo "last_at=$LAST_AT"
  echo "age_seconds=$AGE"
  echo "threshold_minutes=$STALE_MINUTES"
  echo "checked_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$STATE_FILE"
log "ok — last_at=$LAST_AT age=${AGE}s (threshold=${STALE_MINUTES}m)"
exit 0
