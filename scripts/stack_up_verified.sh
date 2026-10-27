#!/usr/bin/env bash
# stack_up_verified.sh — (re)start gateway + dashboard and PROVE the UI is up.
#
# WHY THIS FILE EXISTS. On 2026-10-27 the 08:00 boot rebuilt both images and
# ran `docker compose up -d gateway dashboard`. The dashboard depends_on the
# gateway with `condition: service_healthy`; right after the build the gateway
# missed its health window, compose aborted with
#   "dependency failed to start: container myai-gateway is unhealthy"
# and left myai-dashboard in Created. The gateway went healthy seconds later,
# nothing retried, and the operator had no UI until a manual `up` at ~11:40.
#
# So "up exited" is not the property. The property is: the dashboard container
# is RUNNING and :3210 ANSWERS — or this exits 1 and says which part failed.
#
#   1. [--build] docker compose build gateway dashboard
#   2. docker compose up -d gateway dashboard
#      on failure: wait for the gateway to report healthy, then up the
#      dashboard again (the dependency abort above is recoverable)
#   3. prove: dashboard State.Running = true AND the health URL answers
#
# USAGE
#   scripts/stack_up_verified.sh            # up + prove
#   scripts/stack_up_verified.sh --build    # build first, then up + prove
#   scripts/stack_up_verified.sh --root <d> # compose project dir (default: repo root)
#
# Compose output goes to stderr (callers send it to their log); the LAST line
# on stdout is the verdict: `stack_up_verified: PASS — …` or `… FAIL — …`.
# Exit codes: 0 = dashboard running and answering · 1 = not proven (reason
# printed) · 2 = usage error.
#
# Tunables (env): STACK_UP_GATEWAY_WAIT (s, default 180) · STACK_UP_DASH_WAIT
# (s, default 60) · STACK_UP_POLL (s between checks, default 5) ·
# STACK_UP_DASH_URL (default http://127.0.0.1:3210/api/health) ·
# STACK_UP_GATEWAY_CONTAINER / STACK_UP_DASH_CONTAINER (default myai-gateway /
# myai-dashboard, as in docker-compose.yml).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DO_BUILD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --build) DO_BUILD=1 ;;
    --root)  [ $# -ge 2 ] || { echo "stack_up_verified: --root needs a directory" >&2; exit 2; }
             ROOT="$2"; shift ;;
    *) echo "stack_up_verified: unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done

GW_WAIT="${STACK_UP_GATEWAY_WAIT:-180}"
DASH_WAIT="${STACK_UP_DASH_WAIT:-60}"
POLL="${STACK_UP_POLL:-5}"
STEP="$POLL"; [ "$STEP" -ge 1 ] 2>/dev/null || STEP=1   # POLL=0 (tests) still advances the clock
DASH_URL="${STACK_UP_DASH_URL:-http://127.0.0.1:3210/api/health}"
GW_C="${STACK_UP_GATEWAY_CONTAINER:-myai-gateway}"
DASH_C="${STACK_UP_DASH_CONTAINER:-myai-dashboard}"

verdict() { printf 'stack_up_verified: %s — %s\n' "$1" "$2"; }
compose() { ( cd "$ROOT" && docker compose "$@" ) >&2; }

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  verdict FAIL "docker daemon unreachable"; exit 1
fi

if [ "$DO_BUILD" = 1 ] && ! compose build gateway dashboard; then
  verdict FAIL "docker compose build failed"; exit 1
fi

NOTE="containers up"
if ! compose up -d gateway dashboard; then
  # Most likely the dependency abort: the gateway was slow to go healthy and
  # compose gave up on the dashboard. Wait it out, then start the dashboard.
  echo "stack_up_verified: up failed — waiting up to ${GW_WAIT}s for $GW_C to report healthy" >&2
  GW_STATUS=""; waited=0
  while :; do
    GW_STATUS="$(docker inspect -f '{{.State.Health.Status}}' "$GW_C" 2>/dev/null)"
    [ "$GW_STATUS" = healthy ] && break
    [ "$waited" -ge "$GW_WAIT" ] && break
    sleep "$POLL"; waited=$((waited + STEP))
  done
  if [ "$GW_STATUS" != healthy ]; then
    verdict FAIL "gateway not healthy after ${GW_WAIT}s (status=${GW_STATUS:-missing}); dashboard not started"
    exit 1
  fi
  if ! compose up -d dashboard; then
    verdict FAIL "gateway healthy but 'docker compose up -d dashboard' failed"; exit 1
  fi
  NOTE="up retried after the gateway went healthy (${waited}s)"
fi

RUNNING=""; ANSWERS=0; waited=0
while :; do
  RUNNING="$(docker inspect -f '{{.State.Running}}' "$DASH_C" 2>/dev/null)"
  if [ "$RUNNING" = true ] && curl -fsS -m 5 -o /dev/null "$DASH_URL" 2>/dev/null; then
    ANSWERS=1; break
  fi
  [ "$waited" -ge "$DASH_WAIT" ] && break
  sleep "$POLL"; waited=$((waited + STEP))
done

if [ "$ANSWERS" = 1 ]; then
  verdict PASS "$NOTE; $DASH_C running, $DASH_URL answering"; exit 0
fi
if [ "$RUNNING" != true ]; then
  STATE="$(docker inspect -f '{{.State.Status}}' "$DASH_C" 2>/dev/null)"
  verdict FAIL "$DASH_C not running after ${DASH_WAIT}s (state=${STATE:-missing})"
else
  verdict FAIL "$DASH_C running but $DASH_URL not answering after ${DASH_WAIT}s"
fi
exit 1
