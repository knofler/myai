#!/usr/bin/env bash
# Orchestrates the gateway hot-path k6 load test end to end:
#   1. build + start the ephemeral stack (docker-compose.ci-loadtest.yml)
#   2. seed N throwaway tenants for fan-out (runtime/loadtest/seed-tenants.sh)
#   3. run k6 against tasks_claim + context_boot with p95/p99 budget thresholds
#   4. tear the ephemeral stack down (always, even on failure)
#
# Exit code is k6's: 0 = all thresholds passed, non-zero = a budget was
# breached (or k6/setup itself failed). Safe to run locally or in CI — this
# never touches the shared myai-gateway stack (CLAUDE.md DEPLOY GUARD); see
# docker-compose.ci-loadtest.yml's header for the isolation guarantees.
#
# Usage:
#   ./scripts/run_k6_loadtest.sh [tenant_count] [vus] [duration]
# Env overrides (forwarded to the k6 script — see gateway-hotpaths.js):
#   LOADTEST_P95_TASKS_CLAIM_MS, LOADTEST_P99_TASKS_CLAIM_MS,
#   LOADTEST_P95_CONTEXT_BOOT_MS, LOADTEST_P99_CONTEXT_BOOT_MS, LOADTEST_ERROR_RATE_BUDGET
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE_FILE="docker-compose.ci-loadtest.yml"
TENANT_COUNT="${1:-5}"
VUS="${2:-20}"
DURATION="${3:-30s}"
HTTP_PORT="${LOADTEST_HTTP_PORT:-3202}"
TENANTS_FILE="runtime/loadtest/tenants.generated.json"

cleanup() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    echo "--- dumping gateway logs (failure) ---" >&2
    docker compose -f "$COMPOSE_FILE" logs --tail=300 gateway-loadtest >&2 || true
  fi
  echo "--- tearing down ephemeral load-test stack ---" >&2
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >&2 || true
  rm -f "$TENANTS_FILE"
}
trap cleanup EXIT

echo "--- building + starting ephemeral gateway + mongo (myai-ci-loadtest) ---" >&2
docker compose -f "$COMPOSE_FILE" build gateway-loadtest
docker compose -f "$COMPOSE_FILE" up -d --wait --wait-timeout 240 mongo-loadtest gateway-loadtest

echo "--- seeding ${TENANT_COUNT} load-test tenant(s) ---" >&2
bash runtime/loadtest/seed-tenants.sh "http://127.0.0.1:${HTTP_PORT}" "$TENANT_COUNT" "$TENANTS_FILE"

echo "--- running k6 (VUS=${VUS} DURATION=${DURATION}) ---" >&2
set +e
docker compose -f "$COMPOSE_FILE" run --rm \
  -e BASE_URL=http://gateway-loadtest:3100 \
  -e TENANTS_FILE=/scripts/tenants.generated.json \
  -e LOADTEST_VUS="$VUS" \
  -e LOADTEST_DURATION="$DURATION" \
  -e LOADTEST_P95_TASKS_CLAIM_MS \
  -e LOADTEST_P99_TASKS_CLAIM_MS \
  -e LOADTEST_P95_CONTEXT_BOOT_MS \
  -e LOADTEST_P99_CONTEXT_BOOT_MS \
  -e LOADTEST_ERROR_RATE_BUDGET \
  k6 run k6/gateway-hotpaths.js
K6_EXIT=$?
set -e

if [ "$K6_EXIT" -eq 0 ]; then
  echo "--- k6 load test PASSED (all budgets met) ---" >&2
else
  echo "--- k6 load test FAILED (budget breach — see thresholds above) ---" >&2
fi

exit "$K6_EXIT"
