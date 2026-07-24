#!/usr/bin/env bash
# 14-rag-recall-status.sh — Surface RAG_RECALL mode at session start (Phase B5).
#
# When RAG_RECALL=1, the `agent mode` "older session" lookup rule resolves via
# the gateway's `recall_session` MCP tool (semantic recall over the embedded
# session corpus) instead of grepping state/archive. This hook makes the flag
# discoverable and, critically, verifies the gateway actually exposes
# recall_session before the agent relies on it — if the gateway is down or
# stale, it tells the agent to fall back to grep so a missing tool never
# silently degrades into "no history found".
#
# Silent when RAG_RECALL is unset/0 (the default) — grep-archive stays the
# documented path until the flag is flipped on.
set +e

[ "${RAG_RECALL:-0}" = "1" ] || exit 0

PORT="${MCP_PORT:-3100}"
URL="http://localhost:${PORT}/mcp"

tools=$(curl -sf -m 3 -X POST "$URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' 2>/dev/null)

if echo "$tools" | grep -q '"recall_session"'; then
  echo "RAG RECALL: ON — older-session lookups use the recall_session MCP tool (gateway $URL). Grep state/archive is the fallback."
else
  echo "RAG RECALL: requested (RAG_RECALL=1) but the gateway at $URL has no recall_session tool reachable — falling back to grep state/archive. Start/rebuild the gateway (docker compose up -d --build gateway) to enable."
fi

exit 0
