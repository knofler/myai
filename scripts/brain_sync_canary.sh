#!/usr/bin/env bash
# =============================================================================
# brain_sync_canary.sh — hourly canary for brain_sync_verify.sh.
#
# THE GAP: AI_RULES treats brain_sync_verify as the PRIMARY continuity record
# and requires a failure to "surface it RED, never silent" — but the verify
# only ran inside the `wrap up` flow. A broken brain link mid-session (gateway
# restart, remote desync, a machine whose brain lost its origin) could go
# unnoticed for a full session, sometimes many hours. This script re-runs the
# SAME verify (scripts/brain_sync_verify.sh — never duplicated) on an
# independent schedule (installed by setup_brain_sync_canary_schedule.sh) and
# raises a notification-engine alert (notifications_send MCP tool) the moment
# it fails, instead of waiting for the next wrap-up to notice.
#
# Usage:
#   ./scripts/brain_sync_canary.sh            # run once: verify, alert on failure
#   ./scripts/brain_sync_canary.sh --status    # print last recorded result, no run
#
# Alerts ONLY on failure (never on success — a healthy hourly ping would be
# noise, per the notification service's own design: health alerts are for
# degraded state, not routine activity). Best-effort fallback to Telegram
# directly (notify-telegram.sh) if the gateway itself is unreachable, so a
# gateway outage can't also swallow the alert about it.
#
# Env: GATEWAY_MCP (default http://localhost:3100/mcp), GATEWAY_LOCAL_TOKEN
#      (auto-resolved via lib/gateway.sh), BRAIN_CANARY_LOG (default
#      ~/.ai-cli-runner/brain-canary.log — append-only run log), BRAIN_CANARY_STATE
#      (default ~/.ai-cli-runner/brain-canary.state — last-run status for --status).
# =============================================================================
set +e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERIFY_SCRIPT="${BRAIN_CANARY_VERIFY_SCRIPT:-$SCRIPT_DIR/brain_sync_verify.sh}"
GATEWAY_MCP="${GATEWAY_MCP:-http://localhost:3100/mcp}"
LOG_DIR="$HOME/.ai-cli-runner"
LOG_FILE="${BRAIN_CANARY_LOG:-$LOG_DIR/brain-canary.log}"
STATE_FILE="${BRAIN_CANARY_STATE:-$LOG_DIR/brain-canary.state}"

. "$SCRIPT_DIR/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

log() { echo "[brain-canary $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# format_alert <rc> <output> <host> — builds the notification message text.
# Pure/testable: no network, no filesystem.
format_alert() {
  local rc="$1" output="$2" host="$3"
  printf 'brain_sync_verify FAILED on %s (exit %s).\n%s\n\nThis breaks cross-machine continuity — the next session on another machine may boot from stale git instead of the brain. Investigate: git -C "$MYAI_BRAIN_DIR" remote -v, then re-run scripts/brain_sync_verify.sh by hand.' \
    "$host" "$rc" "$output"
}

# should_alert <rc> — 0 (alert) iff rc is non-zero. Kept as a function so tests
# can assert the decision boundary without invoking the real verify script.
should_alert() { [ "${1:-0}" -ne 0 ]; }

# send_alert <message> — POST notifications_send via the gateway MCP endpoint;
# falls back to notify-telegram.sh directly if the gateway call fails, so a
# gateway outage can't also suppress the alert about the canary failing.
send_alert() {
  local message="$1" body resp rc
  body="$(MSG="$message" /usr/bin/python3 -c '
import json, os
msg = os.environ["MSG"]
print(json.dumps({
  "jsonrpc": "2.0", "method": "tools/call", "id": 1,
  "params": {"name": "notifications_send", "arguments": {
    "message": msg, "level": "critical", "title": "Brain Sync Canary FAILED",
    "source": "brain-sync-canary",
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
  "${BRAIN_CANARY_TELEGRAM_SCRIPT:-$SCRIPT_DIR/notify-telegram.sh}" error "Brain Sync Canary FAILED: $message" >/dev/null 2>&1
  return $?
}

# ── unit-test hook ──────────────────────────────────────────────────────────
# Source with BRAIN_CANARY_LIB_ONLY=1 to get format_alert/should_alert defined
# without running the verify script or making any network call.
if [ "${BRAIN_CANARY_LIB_ONLY:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

if [ "${1:-}" = "--status" ]; then
  if [ -f "$STATE_FILE" ]; then cat "$STATE_FILE"; exit 0; fi
  echo "brain-canary: no prior run recorded ($STATE_FILE missing)."
  exit 0
fi

mkdir -p "$LOG_DIR"
HOST="$(hostname -s 2>/dev/null || echo unknown)"
OUTPUT="$("$VERIFY_SCRIPT" 2>&1)"
RC=$?

{
  echo "status=$([ $RC -eq 0 ] && echo ok || echo fail)"
  echo "rc=$RC"
  echo "host=$HOST"
  echo "at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "output<<EOF"
  echo "$OUTPUT"
  echo "EOF"
} > "$STATE_FILE"

log "verify rc=$RC — $(echo "$OUTPUT" | tail -1)"
echo "[brain-canary $(date -u +%Y-%m-%dT%H:%M:%SZ)] verify rc=$RC" >> "$LOG_FILE"

if should_alert "$RC"; then
  send_alert "$(format_alert "$RC" "$OUTPUT" "$HOST")"
  exit 1
fi

exit 0
