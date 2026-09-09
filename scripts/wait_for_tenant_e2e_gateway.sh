#!/usr/bin/env bash
# wait_for_tenant_e2e_gateway.sh — readiness gate for the ephemeral tenant
# isolation E2E stack (docker-compose.ci-tenant-e2e.yml), run as its own CI
# step BETWEEN `docker compose up -d --wait` and `vitest run
# tests/e2e/tenant-isolation-e2e.test.ts`.
#
# Why this exists (task-b277258d): `docker compose up -d --wait` only proves
# the gateway's IN-CONTAINER healthcheck passed at that moment (it curls
# localhost:3200 from inside the container). It does not re-verify that the
# HOST-published ports (127.0.0.1:3222/3223, what the vitest suite actually
# dials) are still reachable a few seconds later when the next step starts —
# a container that goes unhealthy/exits right after its first successful
# healthcheck, or a brief port-publish race, slips through that gate. When
# that happens the vitest suite's `fetch` calls throw ECONNREFUSED inside
# `beforeAll`, and prior to this fix vitest reported that as "11 skipped" —
# a red X indistinguishable from a real cross-tenant isolation breach, with
# ZERO of the ADR-010 §7.3 DoD assertions having actually run.
#
# This script re-checks from the OUTSIDE, right before the suite runs, and on
# failure prints an unambiguous "gateway never came up" message plus the
# gateway's startup log — so an infra failure is never mistaken for an
# isolation regression. tests/e2e/tenant-isolation-e2e.test.ts carries a
# second, independent readiness wait of its own (belt-and-suspenders: this
# script is the fast CI-level signal, the in-test wait is what turns a
# lingering unreachable-gateway condition into a loud collection-time ERROR
# instead of a misleading per-test SKIP, in case this step is ever bypassed
# e.g. via workflow_dispatch reruns of just the test step).
set -euo pipefail

COMPOSE_FILE="${1:-docker-compose.ci-tenant-e2e.yml}"
HTTP_PORT="${TENANT_E2E_HTTP_PORT:-3222}"
MCP_PORT="${TENANT_E2E_MCP_PORT:-3223}"
TIMEOUT_SECS="${WAIT_TIMEOUT_SECS:-90}"
INTERVAL_SECS=2

tcp_open() {
  local port="$1"
  (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null
  local rc=$?
  exec 3>&- 2>/dev/null || true
  return "$rc"
}

elapsed=0
while [ "$elapsed" -lt "$TIMEOUT_SECS" ]; do
  http_ok=0; mcp_ok=0
  tcp_open "$HTTP_PORT" && http_ok=1
  tcp_open "$MCP_PORT" && mcp_ok=1
  if [ "$http_ok" -eq 1 ] && [ "$mcp_ok" -eq 1 ]; then
    echo "gateway ready: 127.0.0.1:${HTTP_PORT} and 127.0.0.1:${MCP_PORT} both accepting connections after ${elapsed}s"
    exit 0
  fi
  sleep "$INTERVAL_SECS"
  elapsed=$((elapsed + INTERVAL_SECS))
done

http_state="unreachable"; [ "$http_ok" -eq 1 ] && http_state="reachable"
mcp_state="unreachable"; [ "$mcp_ok" -eq 1 ] && mcp_state="reachable"

echo "::error::gateway never came up — 127.0.0.1:${HTTP_PORT} (${http_state}) / 127.0.0.1:${MCP_PORT} (${mcp_state}) after ${TIMEOUT_SECS}s. This is an infra failure, not a tenant-isolation regression."
echo "----- gateway startup log (docker compose -f ${COMPOSE_FILE} logs --tail=300) -----"
docker compose -f "$COMPOSE_FILE" logs --tail=300 || true
echo "----- end gateway log -----"
exit 1
