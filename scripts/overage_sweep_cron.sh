#!/usr/bin/env bash
# overage_sweep_cron.sh — monthly cron entry point that actually POSTs
# `/api/billing/overage/sweep` (dashboard/src/app/api/billing/overage/sweep/
# route.ts, task-b3e501e8, ADR-014 usage-based overage invoicing).
#
# task-b3e501e8 shipped runOverageSweep() + the operator-gated sweep route and
# called it "the monthly cron entry point" — but nothing ever called it. It
# only fired if a human remembered to curl it by hand every month, so the
# Stripe overage push stayed dormant despite being fully coded. This closes
# that gap: install via setup_overage_sweep_schedule.sh (launchd/cron, monthly
# on the 1st) or invoke directly for a manual/dry-run trigger.
#
# The route defaults to the PREVIOUS calendar UTC month server-side and is
# period-keyed idempotent (Stripe meter-event identifiers are
# `overage-<customer>-<dimension>-<periodKey>`, deduped by Stripe) — a re-run
# of this script for the same month never double-bills. This script does not
# need its own dedup layer; it only needs to fire monthly and log the result.
#
# Usage:
#   ./scripts/overage_sweep_cron.sh                  # POST the sweep for the previous month
#   ./scripts/overage_sweep_cron.sh --month 2026-06  # POST the sweep for a specific month
#   ./scripts/overage_sweep_cron.sh --dry-run         # resolve + print the planned call, no network
#   ./scripts/overage_sweep_cron.sh --status           # print the last recorded run, no network
#
# Env: DASHBOARD_URL (default http://localhost:3210), GATEWAY_LOCAL_TOKEN
#      (auto-resolved via lib/gateway.sh), OVERAGE_SWEEP_LOG (default
#      state/.overage_sweep_last).
#
# 503 (STRIPE_OVERAGE_ENABLED unset / overage billing not configured) is a
# NO-OP, not a failure — the route is env-gated end-to-end by design, and a
# tenant/environment with the switch off should sweep silently forever
# without paging anyone. Only a non-2xx/non-503 response or a network failure
# is treated as an error (non-zero exit).
#
# Library mode (unit tests): OVERAGE_SWEEP_CRON_LIB_ONLY=1 sources the pure
# helpers only (classify_http_status / build_sweep_body) and runs nothing —
# no filesystem, no network.
set +e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:3210}"
SWEEP_LOG="${OVERAGE_SWEEP_LOG:-$REPO_ROOT/state/.overage_sweep_last}"

. "$SCRIPT_DIR/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

log() { echo "[overage-sweep-cron $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# build_sweep_body <month_or_empty> — JSON body for the POST. Empty month =
# let the route default to the previous UTC calendar month server-side (the
# route, never this script, is the source of truth for "what month is due").
build_sweep_body() {
  local month="${1:-}"
  if [ -n "$month" ]; then
    printf '{"month":"%s"}' "$month"
  else
    printf '{}'
  fi
}

# classify_http_status <code> → ok | noop-disabled | auth-fail | bad-request |
# error. Pure — no I/O, so this is unit-testable without a server.
classify_http_status() {
  case "${1:-000}" in
    2??) echo "ok" ;;
    503) echo "noop-disabled" ;;
    403) echo "auth-fail" ;;
    400) echo "bad-request" ;;
    *)   echo "error" ;;
  esac
}

# ── unit-test hook ──────────────────────────────────────────────────────────
if [ "${OVERAGE_SWEEP_CRON_LIB_ONLY:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

MONTH=""
ACTION="run"
while [ $# -gt 0 ]; do
  case "$1" in
    --month)   shift; MONTH="${1:?--month needs a value (YYYY-MM)}" ;;
    --dry-run) ACTION="dry-run" ;;
    --status)  ACTION="status" ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

if [ "$ACTION" = "status" ]; then
  if [ -f "$SWEEP_LOG" ]; then cat "$SWEEP_LOG"; exit 0; fi
  echo "overage-sweep-cron: no prior run recorded ($SWEEP_LOG missing)."
  exit 0
fi

BODY="$(build_sweep_body "$MONTH")"
URL="$DASHBOARD_URL/api/billing/overage/sweep"

if [ "$ACTION" = "dry-run" ]; then
  log "DRY RUN — would POST $URL"
  log "  body: $BODY"
  log "  header: x-gateway-local-token: <redacted, $(printf '%s' "$GATEWAY_LOCAL_TOKEN" | wc -c | tr -d ' ') chars>"
  exit 0
fi

RESP_FILE="$(mktemp -t overage-sweep-resp.XXXXXX)"
trap 'rm -f "$RESP_FILE"' EXIT

HTTP_CODE="$(curl -sS -m 30 -o "$RESP_FILE" -w '%{http_code}' -X POST "$URL" \
  -H 'content-type: application/json' \
  -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
  -d "$BODY" 2>/dev/null)"
CURL_RC=$?
RESP="$(cat "$RESP_FILE" 2>/dev/null)"

if [ $CURL_RC -ne 0 ]; then
  log "ERROR: request failed (curl rc=$CURL_RC) — $URL unreachable"
  mkdir -p "$(dirname "$SWEEP_LOG")"
  printf 'status=network-error rc=%s at=%s\n' "$CURL_RC" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SWEEP_LOG"
  exit 1
fi

CLASS="$(classify_http_status "$HTTP_CODE")"
mkdir -p "$(dirname "$SWEEP_LOG")"

case "$CLASS" in
  ok)
    printf 'status=ok http=%s month=%s at=%s resp=%s\n' \
      "$HTTP_CODE" "${MONTH:-previous}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RESP" > "$SWEEP_LOG"
    log "ok — http=$HTTP_CODE $RESP"
    exit 0
    ;;
  noop-disabled)
    printf 'status=noop-disabled http=%s at=%s\n' "$HTTP_CODE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SWEEP_LOG"
    log "no-op — overage billing not configured (http=503), nothing to do"
    exit 0
    ;;
  auth-fail)
    printf 'status=auth-fail http=%s at=%s\n' "$HTTP_CODE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SWEEP_LOG"
    log "ERROR: operator credential rejected (http=403) — check GATEWAY_LOCAL_TOKEN"
    exit 1
    ;;
  *)
    printf 'status=error http=%s at=%s resp=%s\n' "$HTTP_CODE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RESP" > "$SWEEP_LOG"
    log "ERROR: sweep failed — http=$HTTP_CODE $RESP"
    exit 1
    ;;
esac
