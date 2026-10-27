#!/usr/bin/env bash
# push_schedule.sh — ingest a repo's committed schedule artifact into the local
# gateway (the "master runner" on THIS Mac). The cross-device bridge:
#   • Mobile/cloud `schedule plan` can't reach localhost:3100 — it just commits
#     AI/plan/schedule.json and merges to main.
#   • A CLI `agent mode -a` on any Mac runs this to register that schedule with
#     the gateway: plan_set (→ dashboard /plan) + schedule_task for each task.
# Idempotent on two levels:
#   • whole-file fast-path — records the artifact's git blob hash in
#     AI/state/.schedule-ingested and skips entirely if unchanged.
#   • per-task dedup — when the file HAS changed, schedule_ingest.py skips any
#     task whose title already exists in the gateway for this repo (ANY status,
#     done included) so appending a few tasks never re-queues the already-done
#     ones. (Whole-file-hash-only re-queued 19 done tasks in one managed repo on
#     2026-10-02; `schedule plan` is wrap-up step 0, so that fired every wrap-up.)
#
# Artifact format — AI/plan/schedule.json (master: plan/schedule.json):
#   { "repo":"name", "startDate":"YYYY-MM-DD",
#     "days":[{"day":1,"focus":"...","status":"enabled"}, ...],
#     "tasks":[{"title":"...","priority":"P1","agent":"...","category":"...","day":1}, ...] }
#
# Usage: ./AI/scripts/push_schedule.sh            # this repo
#        ./AI/scripts/push_schedule.sh --force    # re-ingest even if unchanged
# Env: GATEWAY_MCP (default http://localhost:3100/mcp)
set -euo pipefail
GATEWAY_MCP=${GATEWAY_MCP:-http://localhost:3100/mcp}
# /health/deep (the Mongo-pinging deep check) is served by the HTTP server on
# GATEWAY_HTTP_PORT (default 3200), NOT the MCP port (3100 serves only the shallow
# /health). Probing 3100/health/deep returns 404 -> mongodb=unknown -> this script
# REFUSES to ingest a perfectly good schedule. Same bug was fixed in
# schedule_task.sh (2026-07-xx) but this script was missed; found 2026-08-27 when
# `schedule plan` could not register its plan on a healthy gateway.
# Override with GATEWAY_HTTP_PORT / GATEWAY_HEALTH_BASE.
GATEWAY_HTTP_PORT=${GATEWAY_HTTP_PORT:-3200}
GATEWAY_HEALTH_BASE=${GATEWAY_HEALTH_BASE:-$(printf '%s' "${GATEWAY_MCP%/mcp}" | sed -E "s#:[0-9]+\$#:${GATEWAY_HTTP_PORT}#")}
. "$(dirname "$0")/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
FORCE=false; [ "${1:-}" = "--force" ] && FORCE=true

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
# Resolve by where the ARTIFACT is, not by which directory happens to exist.
# The MASTER checkout carries a leftover `AI/` subdir (myai init was once run
# against it — see the signpost in AI/state/AI_AGENT_HANDOFF.md), so the old
# bare `[ -d "$ROOT/AI" ]` test resolved to $ROOT/AI on master, looked for
# AI/plan/schedule.json, found nothing and exited 0 — `schedule plan` reported
# success while ingesting NOTHING. Managed repos are unaffected: their artifact
# genuinely lives under AI/.
AI_DIR=""
for _cand in "$ROOT/AI" "$ROOT"; do
    if [ -f "$_cand/plan/schedule.json" ]; then AI_DIR="$_cand"; break; fi
done
# No artifact in either layout — keep the legacy preference so the message below
# names the path a managed repo would use.
if [ -z "$AI_DIR" ]; then
    AI_DIR="$ROOT/AI"; [ -d "$AI_DIR" ] || AI_DIR="$ROOT"
fi
ART="$AI_DIR/plan/schedule.json"
SENTINEL="$AI_DIR/state/.schedule-ingested"
[ -f "$ART" ] || { echo "no schedule artifact at $ART — nothing to ingest"; exit 0; }

# Skip if already ingested (same content) unless --force.
HASH="$(git -C "$ROOT" hash-object "$ART" 2>/dev/null || shasum "$ART" | cut -d' ' -f1)"
if [ "$FORCE" != true ] && [ -f "$SENTINEL" ] && grep -q "$HASH" "$SENTINEL" 2>/dev/null; then
    echo "schedule.json unchanged (already ingested) — skip"; exit 0
fi

# Deliberately probes /health/deep, not the shallow /health — the shallow
# endpoint always answers HTTP 200 even when MongoDB is unreachable (other
# scripts rely on that as a pure process-liveness probe), so a bare
# `curl -sf` against it never trips even when ingested tasks would silently
# vanish into a broken store (2026-07-06 localhost:27017-misdirection
# incident). /health/deep actually pings Mongo and returns non-2xx when down.
_deep_rc=0
_deep="$(curl -s -m 8 -w '\n%{http_code}' "${GATEWAY_HEALTH_BASE}/health/deep" 2>/dev/null)" || _deep_rc=$?
_deep_status="${_deep##*$'\n'}"
_deep_body="${_deep%$'\n'*}"
if [ $_deep_rc -ne 0 ] || [ -z "$_deep_status" ]; then
    echo "✗ gateway not reachable at $GATEWAY_MCP — cannot push schedule (run on the gateway Mac)"; exit 0
fi
if [ "$_deep_status" -lt 200 ] || [ "$_deep_status" -ge 300 ]; then
    _mongo_state="$(echo "$_deep_body" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("checks", {}).get("mongodb", {}).get("status", "unknown"))
except Exception:
    print("unknown")
' 2>/dev/null)"
    echo "✗ gateway is unhealthy (HTTP $_deep_status, mongodb=$_mongo_state) — refusing to ingest a schedule that would silently vanish." >&2
    echo "  Check MONGODB_URI in the gateway's .env — it must point at the compose service host (e.g. 'mongo'), not 'localhost'." >&2
    exit 1
fi

# Consent gate — skip repos on the no-autonomous-schedule list unless consented
# (user directive 2026-06-16). Override: SCHEDULE_CONSENT=1 ./push_schedule.sh
IGNORE_FILE="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/config/schedule_ignore.txt"
ART_REPO="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("repo",""))' "$ART" 2>/dev/null)"
if [ "${SCHEDULE_CONSENT:-0}" != "1" ] && [ -f "$IGNORE_FILE" ] && [ -n "$ART_REPO" ] \
   && grep -qxF "$ART_REPO" <(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$IGNORE_FILE"); then
  echo "↷ '$ART_REPO' is on the no-autonomous-schedule list — NOT ingesting plan/tasks."
  echo "  This app needs your explicit consent. To ingest anyway: SCHEDULE_CONSENT=1 $0"
  exit 0
fi

# plan_set + per-task schedule_task fan-out, deduped against the gateway, lives
# in schedule_ingest.py (unit-tested in scripts/tests/test_schedule_ingest.sh).
# It exits non-zero if any task failed to schedule — under `set -e` that aborts
# before the sentinel below is written, so a partial ingest is never recorded as
# complete.
SCHED_SCRIPT="$(dirname "$0")/schedule_task.sh"
INGEST="$(dirname "$0")/schedule_ingest.py"
/usr/bin/python3 "$INGEST" \
    --artifact "$ART" \
    --gateway "$GATEWAY_MCP" \
    --sched "$SCHED_SCRIPT" \
    --token "$GATEWAY_LOCAL_TOKEN"

mkdir -p "$(dirname "$SENTINEL")"
echo "$HASH  $(date -u +%FT%TZ)" > "$SENTINEL"
echo "✓ schedule ingested into gateway for $(basename "$ROOT") → dashboard /plan + /schedule"
