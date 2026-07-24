#!/usr/bin/env bash
# myai_recall.sh — token-free semantic recall over the repo-local index
# (`myai recall "<query>"`). Deterministic: builds the SQLite index on first
# use, then queries scripts/brain_route.py (sparse BM25 + local embeddings
# over code symbols + brain atoms). NO LLM, NO network, NO tokens — this is
# context retrieval the way the user asked for: search the brain like git,
# before ever opening Claude.
#
#   myai recall <query...>            top matches (locators: path/symbol + score)
#   myai recall --k N <query...>      cap results (default 5)
#   myai recall --json <query...>     raw JSON from the router (for scripts)
#   myai recall --rebuild <query...>  force-rebuild the index first
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DB="$ROOT/state/.repo_index.sqlite3"
K=5 JSON=0 REBUILD=0
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --k) K="$2"; shift 2 ;;
    --json) JSON=1; shift ;;
    --rebuild) REBUILD=1; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --) shift; while [ $# -gt 0 ]; do ARGS+=("$1"); shift; done ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
QUERY="${ARGS[*]:-}"
[ -n "$QUERY" ] || { echo "usage: myai recall [--k N] [--json] [--rebuild] <query>" >&2; exit 2; }
PY="$(command -v python3 || true)"
[ -n "$PY" ] || { echo "myai recall: python3 not found" >&2; exit 3; }

# Ensure the index exists (token-free build on first use). Build chatter goes to
# stderr so --json stays a clean stdout stream.
if [ "$REBUILD" = "1" ] || [ ! -f "$DB" ]; then
  BUILD_ARGS=(--db "$DB" --repo-root "$ROOT")
  [ "$REBUILD" = "1" ] && BUILD_ARGS+=(--force)
  [ "$JSON" = "1" ] && BUILD_ARGS+=(--quiet)
  bash "$HERE/build_repo_index.sh" "${BUILD_ARGS[@]}" >&2 || {
    echo "myai recall: index build failed" >&2; exit 1; }
fi

if [ "$JSON" = "1" ]; then
  exec "$PY" "$HERE/brain_route.py" --query "$QUERY" --k "$K" --db "$DB" --json
else
  exec "$PY" "$HERE/brain_route.py" --query "$QUERY" --k "$K" --db "$DB"
fi
