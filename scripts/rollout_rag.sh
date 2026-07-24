#!/usr/bin/env bash
# rollout_rag.sh — Phase B7: Rollout RAG embedding across managed repos.
#
# Iterates through managed_repos.txt and drives the master gateway's
# `memory_reindex` MCP tool to embed each repo's state/archive files into
# the central vector store. Managed repos don't run their own gateway —
# they rely on the master gateway at localhost:3100 for all RAG operations.
#
# Usage:
#   ./scripts/rollout_rag.sh              # reindex all managed repos
#   ./scripts/rollout_rag.sh --dry-run    # report corpus stats, change nothing
#   ./scripts/rollout_rag.sh --port N     # gateway MCP port (default 3100)
#   ./scripts/rollout_rag.sh --help
#
# Idempotent — safe to run repeatedly. Content-hash dedup means re-runs
# skip already-embedded blocks. Requires the gateway container running
# (`docker compose up -d gateway`) and `jq` on PATH.
#
# See plan/AI_AUTOMATION_PLAN.md Phase B7.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TRACKING_FILE="$REPO_DIR/config/managed_repos.txt"

PORT=3100
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
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

if [ ! -f "$TRACKING_FILE" ]; then
    echo "ERROR: $TRACKING_FILE not found." >&2
    exit 1
fi

# call_tool <tool-name> <arguments-json> → prints the unwrapped JSON result text
call_tool() {
    local tool_name="$1"
    local args_json="$2"
    local payload
    payload=$(printf '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"%s","arguments":%s},"id":1}' "$tool_name" "$args_json")
    local resp
    resp=$(curl -sf -X POST "$MCP_URL" -H 'content-type: application/json' -d "$payload" 2>/dev/null) || {
        echo "ERROR: gateway not reachable at $MCP_URL — is the container running? (docker compose up -d gateway)" >&2
        exit 1
    }
    echo "$resp" | jq -r '.result.content[0].text // empty'
}

print_stats() {
    local label="$1"
    local stats
    stats=$(call_tool "memory_stats" '{}')
    local total
    total=$(echo "$stats" | jq -r '.total')
    local by
    by=$(echo "$stats" | jq -r '.bySource | to_entries | map("\(.key)=\(.value)") | join(", ")')
    echo "  $label corpus: $total vectors ($by)"
}

# Count managed repos (non-blank, non-comment lines)
REPO_COUNT=0
while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -z "$line" ] && continue
    REPO_COUNT=$((REPO_COUNT + 1))
done < "$TRACKING_FILE"

echo "=== RAG rollout across managed repos (Phase B7) ==="
echo "  gateway: $MCP_URL"
echo "  managed repos: $REPO_COUNT (from $TRACKING_FILE)"
echo ""

print_stats "pre-rollout"

if [ "$DRY_RUN" -eq 1 ]; then
    echo ""
    echo "  --dry-run: listing repos that would be indexed..."
    echo ""
    while IFS= read -r repo_path || [ -n "$repo_path" ]; do
        [[ -z "$repo_path" || "$repo_path" == \#* ]] && continue
        repo_path="${repo_path%%#*}"
        repo_path="${repo_path%"${repo_path##*[![:space:]]}"}"
        repo_path="${repo_path/#\~/$HOME}"
        repo_name=$(basename "$repo_path")
        if [ -d "$repo_path" ]; then
            has_state="no"
            has_archive="no"
            [ -f "$repo_path/AI/state/STATE.md" ] || [ -f "$repo_path/state/STATE.md" ] && has_state="yes"
            [ -d "$repo_path/AI/state/archive" ] || [ -d "$repo_path/state/archive" ] && has_archive="yes"
            echo "    $repo_name  state=$has_state  archive=$has_archive"
        else
            echo "    $repo_name  (directory not found — skipped)"
        fi
    done < "$TRACKING_FILE"
    echo ""
    echo "  --dry-run: no changes made."
    exit 0
fi

echo ""
echo "  reindexing all repos (master + managed)..."
echo ""

# Use scope=all to reindex master + every managed repo in one call.
# The gateway's indexAllRepos() already iterates managed_repos.txt.
result=$(call_tool "memory_reindex" '{"scope":"all"}')

# Extract totals
stored=$(echo "$result" | jq -r '.totals.stored')
skipped=$(echo "$result" | jq -r '.totals.skipped')
failed=$(echo "$result" | jq -r '.totals.failed')
grand=$(echo "$result" | jq -r '.grandTotal')

echo "  --- Per-repo breakdown ---"
echo ""
printf "  %-30s %8s %8s %8s\n" "REPO/SOURCE" "STORED" "SKIPPED" "FAILED"
printf "  %-30s %8s %8s %8s\n" "──────────────────────────────" "────────" "────────" "────────"
echo "$result" | jq -r '.breakdown[] | "  \(.repo)/\(.source)|\(.stored)|\(.skipped)|\(.failed)"' | \
    while IFS='|' read -r name s sk f; do
        printf "  %-30s %8s %8s %8s\n" "$name" "$s" "$sk" "$f"
    done

echo ""
echo "  --- Summary ---"
echo "  stored:  $stored (new vectors embedded)"
echo "  skipped: $skipped (already in corpus — deduped)"
echo "  failed:  $failed"

print_stats "post-rollout"
echo "  grand total: $grand vectors"

if [ "$failed" != "0" ] && [ "$failed" != "null" ]; then
    echo ""
    echo "WARNING: $failed chunk(s) failed to embed — check gateway logs." >&2
    exit 1
fi

echo ""
echo "=== RAG rollout complete ==="
