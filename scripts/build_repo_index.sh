#!/usr/bin/env bash
# build_repo_index.sh — build/refresh the repo-local BRAIN B-1 SQLite index
# (state/.repo_index.sqlite3) by running the four deterministic indexers in
# dependency order. stdlib-only Python, NO network, NO LLM — this is what
# powers the token-free `myai recall`. Idempotent (indexers upsert); safe to
# re-run. Present-and-not-forced is a fast no-op.
#
#   build_repo_index.sh [--db PATH] [--repo-root DIR] [--quiet] [--force]
#
# Exit 0 on success (or fast no-op); non-zero if an indexer fails.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DB="" QUIET="" FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB="$2"; shift 2 ;;
    --repo-root) ROOT="$2"; shift 2 ;;
    --quiet) QUIET="--quiet"; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "build_repo_index: unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DB" ] || DB="$ROOT/state/.repo_index.sqlite3"
PY="$(command -v python3 || true)"
[ -n "$PY" ] || { echo "build_repo_index: python3 not found" >&2; exit 3; }

log() { [ -n "$QUIET" ] || echo "$@"; }

if [ -f "$DB" ] && [ "$FORCE" != "1" ]; then
  log "build_repo_index: index present ($DB) — use --force to rebuild"
  exit 0
fi

run() {
  local script="$1"
  log "  → $script"
  "$PY" "$HERE/$script" --db "$DB" --repo-root "$ROOT" $QUIET || {
    echo "build_repo_index: $script failed" >&2; return 1; }
}

log "build_repo_index: building $DB"
mkdir -p "$(dirname "$DB")" 2>/dev/null || true
run scan_repo_index.py   || exit 1   # code: symbols/refs/chunks/tests
run index_brain_atoms.py || exit 1   # memory: mirror brain atoms
run build_sparse_index.py|| exit 1   # BM25 inverted index over both
run embed_atoms.py       || exit 1   # local fallback embeddings
log "build_repo_index: done"
