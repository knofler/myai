#!/usr/bin/env bash
# backfill_embeddings.sh — One-shot RAG corpus backfill (Phase B4).
#
# Why: The session corpus that the `recall_session` MCP tool (Phase B3) reads
# is populated by the gateway's indexer — STATE.md blocks, AI_AGENT_HANDOFF.md,
# and every rotated `state/archive/YYYY-MM.md` session. On a fresh machine, a
# clean Mongo volume, or after months of accumulated archives, the corpus can
# be empty or behind. This script walks the gateway over its existing
# `memory_reindex` tool to embed + upsert every block, so semantic recall has
# the full history to search. See plan/AI_AUTOMATION_PLAN.md Phase B4.
#
# It is a thin, documented entry point over the live gateway — the gateway owns
# the Mongo connection and the embedding provider, so reindexing through it
# (rather than a separate Node process) reuses the exact same code path the
# bootstrap + `wrap up` reindex use. Chunking is by `### Session:` header;
# upserts are keyed by content hash, so re-running is a no-op for unchanged
# blocks (skipped, never duplicated).
#
# Usage:
#   ./scripts/backfill_embeddings.sh            # backfill master repo (this repo)
#   ./scripts/backfill_embeddings.sh --all      # also backfill every managed repo
#   ./scripts/backfill_embeddings.sh --dry-run  # report current corpus, change nothing
#   ./scripts/backfill_embeddings.sh --port N   # gateway MCP port (default 3100)
#   ./scripts/backfill_embeddings.sh --help
#
# Idempotent — safe to run repeatedly. Requires the gateway container running
# (`docker compose up -d gateway`) and `jq` on PATH.

set -euo pipefail

PORT=3100
SCOPE="master"
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --all)     SCOPE="all" ;;
        --dry-run) DRY_RUN=1 ;;
        --port)    shift; PORT="${1:-3100}" ;;
        -h|--help)
            grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed '1d'
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            echo "Run with --help for usage." >&2
            exit 2
            ;;
    esac
    shift
done

MCP_URL="http://localhost:${PORT}/mcp"

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is required but not on PATH." >&2
    exit 1
fi

# call_tool <tool-name> <arguments-json> → prints the unwrapped JSON result text
call_tool() {
    tool_name="$1"
    args_json="$2"
    payload=$(printf '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"%s","arguments":%s},"id":1}' "$tool_name" "$args_json")
    resp=$(curl -sf -X POST "$MCP_URL" -H 'content-type: application/json' -d "$payload" 2>/dev/null) || {
        echo "ERROR: gateway not reachable at $MCP_URL — is the container running? (docker compose up -d gateway)" >&2
        exit 1
    }
    # Tool results are JSON-stringified inside .result.content[0].text
    echo "$resp" | jq -r '.result.content[0].text // empty'
}

print_stats() {
    label="$1"
    stats=$(call_tool "memory_stats" '{}')
    total=$(echo "$stats" | jq -r '.total')
    by=$(echo "$stats" | jq -r '.bySource | to_entries | map("\(.key)=\(.value)") | join(", ")')
    echo "  $label corpus: $total vectors ($by)"
}

echo "=== RAG corpus backfill (Phase B4) ==="
echo "  gateway: $MCP_URL    scope: $SCOPE"

print_stats "current"

if [ "$DRY_RUN" -eq 1 ]; then
    echo "  --dry-run: no changes made."
    exit 0
fi

echo "  reindexing ($SCOPE)…"
if [ "$SCOPE" = "all" ]; then
    result=$(call_tool "memory_reindex" '{"scope":"all"}')
else
    result=$(call_tool "memory_reindex" '{}')
fi

stored=$(echo "$result" | jq -r '.totals.stored')
skipped=$(echo "$result" | jq -r '.totals.skipped')
failed=$(echo "$result" | jq -r '.totals.failed')
grand=$(echo "$result" | jq -r '.grandTotal')

echo "  reindex result: stored=$stored  skipped=$skipped  failed=$failed"
echo "$result" | jq -r '.breakdown[] | "    \(.repo)/\(.source): stored=\(.stored) skipped=\(.skipped) failed=\(.failed)"'
print_stats "final"
echo "  grand total: $grand vectors"

if [ "$failed" != "0" ]; then
    echo "WARNING: $failed chunk(s) failed to embed — check gateway logs." >&2
    exit 1
fi

echo "=== backfill complete ==="
