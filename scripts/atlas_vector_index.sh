#!/usr/bin/env bash
set -euo pipefail
# ════════════════════════════════════════════════════════════════════════════
#  atlas_vector_index.sh — provision/verify the Atlas Vector Search index that
#  memory_search / recall_session's $vectorSearch path depends on.
#
#  The gateway self-heals this index on every boot (core/index.ts →
#  ensureAtlasVectorSearchIndex), so this wrapper is for ops between boots:
#  after a cluster rebuild, or to check why the Atlas path returns [].
#
#  Runs inside the gateway container (Docker-only policy — no host node), so
#  MONGODB_URI comes from the container's real env.
#
#  Usage:
#    scripts/atlas_vector_index.sh            # create/repair the index
#    scripts/atlas_vector_index.sh --check    # report only, no writes
#
#  Exit codes: 0 = ok/created/updated · 1 = failed/misconfigured · 2 = not Atlas
# ════════════════════════════════════════════════════════════════════════════
CONTAINER="${GATEWAY_CONTAINER:-myai-gateway}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "[atlas-vector-index] ERROR: container '$CONTAINER' is not running" >&2
  exit 1
fi

if ! docker exec "$CONTAINER" test -f dist/scripts/ensure-vector-index.js; then
  echo "[atlas-vector-index] ERROR: dist/scripts/ensure-vector-index.js missing in '$CONTAINER'" >&2
  echo "[atlas-vector-index] The running image predates this script — rebuild the gateway from the MASTER checkout, or rely on the boot-time ensure." >&2
  exit 1
fi

docker exec "$CONTAINER" node dist/scripts/ensure-vector-index.js "$@"
