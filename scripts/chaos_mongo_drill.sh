#!/usr/bin/env bash
# chaos_mongo_drill.sh — chaos drill for gateway↔Mongo resilience, on the
# pattern of atlas_failover_drill.sh / gateway_mongo_restore_drill.sh (ADR-036
# §5 / ADR-037: a scheduled, unattended proof that a documented recovery
# property actually holds, not just a hypothesis).
#
# The property under test is the reliability half of the autonomous claim:
# SIGKILL MongoDB while a runner task is in-flight (claimed, 'working'), then
# restart it, and assert — through the REAL task-store code paths behind the
# runner's `mcp tasks_claim`/`tasks_update` calls — that:
#   • the same gateway connection reconnects on its own (no restart),
#   • the in-flight task is neither lost nor double-executed
#     (claim preserved, second claim finds nothing, completion lands once),
#   • operations during the outage surface ERRORS, never a silent success or
#     a silent "queue empty" (the false-healthy-queue failure mode),
#   • the queue is consistent afterwards (one task, counts sum, clean retry
#     ledger — a DB outage is not a task failure).
# The behavioral assertions live in runtime/src/scripts/chaos-mongo-drill.ts;
# this wrapper owns the container lifecycle and the PASS/FAIL record.
#
# Runs entirely against a THROWAWAY mongod container this script owns — torn
# down on exit. NEVER touches the shared myai-gateway/myai-mongo stack
# (DEPLOY GUARD, CLAUDE.md). The container is started WITHOUT --rm and on an
# explicit host port so the drill can `docker kill` + `docker start` the same
# container (same data, same URI) — that's the crash it recovers from.
#
#   ./scripts/chaos_mongo_drill.sh              # run the drill
#   ./scripts/chaos_mongo_drill.sh --quiet       # print only the final PASS/FAIL line
#
# Resolution:
#   $MYAI_HOME                   config home                 (default ~/.myai)
#   $CHAOS_MONGO_DRILL_LAST      status file                 (default $MYAI_HOME/chaos-mongo-drill.last)
#   $MONGO_TOOLS_IMAGE           throwaway mongod image       (default mongo:7)
#   $CHAOS_DOCKER_BIN            docker binary                (default docker; tests stub it)
#   $CHAOS_MONGO_PORT            explicit host port           (default: random 20000-29999, retried)
#
# Exit 0 = every phase (in-flight claim, outage, recovery, consistency)
#          passed its assertions.
# Exit 1 = docker/mongod setup failed, OR the drill ran and a phase failed —
#          loud and non-zero on purpose (ADR-036 §2.2's "visible gap, never
#          silent" posture): an untested recovery path is a hypothesis.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$HERE/../runtime"

MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
LAST_RUN_FILE="${CHAOS_MONGO_DRILL_LAST:-$MYAI_HOME/chaos-mongo-drill.last}"
MONGO_TOOLS_IMAGE="${MONGO_TOOLS_IMAGE:-mongo:7}"
DOCKER_BIN="${CHAOS_DOCKER_BIN:-docker}"

QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet|-q) QUIET=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "chaos_mongo_drill: unknown argument $1" >&2; exit 2 ;;
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
  echo "✗ CHAOS MONGO DRILL FAILED: $1" >&2
  write_status "FAIL" "$1"
  exit 1
}

command -v "$DOCKER_BIN" >/dev/null 2>&1 || fail_drill "docker ($DOCKER_BIN) not found on PATH — cannot drill without it"
[ -d "$RUNTIME_DIR/node_modules/tsx" ] || fail_drill "runtime/node_modules/tsx missing — run 'npm ci' in runtime/ first"

DRILL_ID="chaos-drill-$$-$RANDOM"
MONGO="mongo-$DRILL_ID"

cleanup() {
  "$DOCKER_BIN" rm -f "$MONGO" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Explicit host port, NOT `-p 127.0.0.1::27017`: a randomly-published port is
# re-picked on `docker start`, which would silently break the drill's fixed
# URI right at the moment it's asserting recovery. Retried in case of a
# collision with something already listening.
say "— standing up a throwaway mongod (the crash target) —"
STARTED=0
if [ -n "${CHAOS_MONGO_PORT:-}" ]; then
  PORT="$CHAOS_MONGO_PORT"
  "$DOCKER_BIN" run -d --name "$MONGO" -p "127.0.0.1:$PORT:27017" "$MONGO_TOOLS_IMAGE" mongod --quiet --bind_ip_all >/dev/null 2>&1 && STARTED=1
else
  for _ in 1 2 3 4 5; do
    PORT=$(( (RANDOM % 10000) + 20000 ))
    if "$DOCKER_BIN" run -d --name "$MONGO" -p "127.0.0.1:$PORT:27017" "$MONGO_TOOLS_IMAGE" mongod --quiet --bind_ip_all >/dev/null 2>&1; then
      STARTED=1
      break
    fi
    "$DOCKER_BIN" rm -f "$MONGO" >/dev/null 2>&1 || true
  done
fi
[ "$STARTED" = 1 ] || fail_drill "could not start throwaway mongod container ($MONGO_TOOLS_IMAGE)"

ready=0
for _ in $(seq 1 30); do
  if "$DOCKER_BIN" exec "$MONGO" mongosh --quiet --eval 'db.runCommand({ping:1})' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || fail_drill "throwaway mongod never became ready within 30s"

MONGO_URI="mongodb://127.0.0.1:$PORT/chaos_mongo_drill"

say "— running the drill (in-flight claim -> SIGKILL -> outage -> recovery -> consistency) —"
cd "$RUNTIME_DIR" || fail_drill "runtime/ directory not found"

DRILL_OUTPUT="$(
  MONGODB_URI="$MONGO_URI" \
  MONGODB_NAME="chaos_mongo_drill" \
  CHAOS_MONGO_CONTAINER="$MONGO" \
  CHAOS_DOCKER_BIN="$DOCKER_BIN" \
  npx tsx src/scripts/chaos-mongo-drill.ts 2>&1
)"
DRILL_EXIT=$?

say "$DRILL_OUTPUT"

if [ "$DRILL_EXIT" -ne 0 ]; then
  fail_drill "drill script exited $DRILL_EXIT — $(echo "$DRILL_OUTPUT" | tail -1)"
fi

# Always printed (even --quiet): this IS the final PASS/FAIL line.
echo "✓ CHAOS MONGO DRILL PASSED — mid-task Mongo crash: reconnected, task neither lost nor double-executed, queue consistent"
write_status "PASS" "mid-task mongod SIGKILL + restart: reconnect, no lost/duplicated task, consistent queue — all verified against a throwaway mongod"
exit 0
