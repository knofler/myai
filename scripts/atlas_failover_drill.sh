#!/usr/bin/env bash
# atlas_failover_drill.sh — automated failover drill for the Atlas resilience
# task, on the pattern of ADR-036 §5/§6 (hosted_brain_restore_drill.sh) and
# ADR-037 (gateway_mongo_restore_drill.sh): a scheduled, unattended proof that
# a documented recovery mechanism actually works, not just a hypothesis.
#
# The mechanism under test is runtime/src/shared/db-failover.ts's read-side
# local-first failover (MYAI_DB_FAILOVER=local, MONGO_MIRROR.md): deliberately
# point the gateway's connectDB() at an unreachable primary, assert it
# degrades to READ-ONLY serving from the local mirror instead of erroring,
# assert writes are rejected while degraded, then simulate the primary
# returning and assert it recovers (direct connect, writes allowed again).
#
# Runs entirely against THROWAWAY containers this script owns — a fresh
# mongod on a throwaway docker network, torn down on exit. NEVER touches the
# shared myai-gateway/myai-mongo stack (DEPLOY GUARD, CLAUDE.md) and never
# points at a real Atlas cluster — the "primary" this drill fails away from
# is a synthetic unreachable address (RFC 5737 TEST-NET-1), not the real one.
#
#   ./scripts/atlas_failover_drill.sh              # run the drill
#   ./scripts/atlas_failover_drill.sh --quiet       # print only the final PASS/FAIL line
#
# Resolution:
#   $MYAI_HOME                    config home                (default ~/.myai)
#   $ATLAS_FAILOVER_DRILL_LAST    status file                (default $MYAI_HOME/atlas-failover-drill.last)
#   $MONGO_TOOLS_IMAGE            throwaway mongod image      (default mongo:7)
#
# Exit 0 = both phases (outage degrade, recovery) passed their assertions.
# Exit 1 = docker/mongod setup failed, OR the drill ran and a phase failed —
#          loud and non-zero on purpose (ADR-036 §2.2's "visible gap, never
#          silent" posture): an untested failover is a hypothesis.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$HERE/../runtime"

MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
LAST_RUN_FILE="${ATLAS_FAILOVER_DRILL_LAST:-$MYAI_HOME/atlas-failover-drill.last}"
MONGO_TOOLS_IMAGE="${MONGO_TOOLS_IMAGE:-mongo:7}"

QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet|-q) QUIET=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "atlas_failover_drill: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

say() { [ "$QUIET" = "1" ] || echo "$@"; }

write_status() {
  mkdir -p "$(dirname "$LAST_RUN_FILE")" 2>/dev/null || true
  {
    echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "result: $1"
    echo "detail: $2"
  } > "$LAST_RUN_FILE" 2>/dev/null || true
}

fail_drill() {
  echo "✗ ATLAS FAILOVER DRILL FAILED: $1" >&2
  write_status "FAIL" "$1"
  exit 1
}

command -v docker >/dev/null 2>&1 || fail_drill "docker not found on PATH — cannot drill without it"
[ -d "$RUNTIME_DIR/node_modules/tsx" ] || fail_drill "runtime/node_modules/tsx missing — run 'npm ci' in runtime/ first"

DRILL_ID="atlas-drill-$$-$RANDOM"
NET="net-$DRILL_ID"
MIRROR="mirror-$DRILL_ID"

cleanup() {
  docker rm -f "$MIRROR" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say "— standing up a throwaway mongod (the drill's local mirror) —"
docker network create "$NET" >/dev/null 2>&1 || fail_drill "could not create throwaway docker network $NET"
if ! docker run -d --rm --name "$MIRROR" --network "$NET" -p 127.0.0.1::27017 "$MONGO_TOOLS_IMAGE" mongod --quiet --bind_ip_all >/dev/null 2>&1; then
  fail_drill "could not start throwaway mongod container ($MONGO_TOOLS_IMAGE)"
fi

ready=0
for _ in $(seq 1 30); do
  if docker exec "$MIRROR" mongosh --quiet --eval 'db.runCommand({ping:1})' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || fail_drill "throwaway mongod never became ready within 30s"

HOST_PORT="$(docker port "$MIRROR" 27017/tcp 2>/dev/null | head -1 | sed 's/.*://')"
[ -n "$HOST_PORT" ] || fail_drill "could not determine the throwaway mongod's published host port"
MIRROR_URI="mongodb://127.0.0.1:$HOST_PORT/atlas_failover_drill"

# RFC 5737 TEST-NET-1 — reserved for documentation, guaranteed to never route
# to a real service. Short timeouts so the outage phase fails fast rather
# than hanging on mongoose's default 30s server-selection window.
UNREACHABLE_PRIMARY_URI="mongodb://192.0.2.1:27017/atlas_failover_drill?serverSelectionTimeoutMS=2000&connectTimeoutMS=2000&directConnection=true"

say "— running the drill (outage degrade -> recovery) —"
cd "$RUNTIME_DIR" || fail_drill "runtime/ directory not found"

DRILL_OUTPUT="$(
  MONGODB_URI="$UNREACHABLE_PRIMARY_URI" \
  MONGODB_NAME="atlas_failover_drill" \
  MYAI_DB_FAILOVER="local" \
  MYAI_DB_FAILOVER_URI="$MIRROR_URI" \
  DRILL_RECOVERY_URI="$MIRROR_URI" \
  npx tsx src/scripts/atlas-failover-drill.ts 2>&1
)"
DRILL_EXIT=$?

say "$DRILL_OUTPUT"

if [ "$DRILL_EXIT" -ne 0 ]; then
  fail_drill "drill script exited $DRILL_EXIT — $(echo "$DRILL_OUTPUT" | tail -1)"
fi

say "✓ ATLAS FAILOVER DRILL PASSED — degrades to read-only local mirror on primary outage, recovers on primary return"
write_status "PASS" "outage degrade + recovery both verified against a throwaway mongod"
exit 0
