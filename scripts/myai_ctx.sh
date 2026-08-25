#!/usr/bin/env bash
# myai_ctx.sh — `myai ctx <query>` (BRAIN_V2 W3.1): the deterministic,
# zero-LLM context lookup primitive that replaces bulk Read/Grep.
#
# Same shipped engine as `myai recall` — the repo-local BRAIN B-1 SQLite index
# (scripts/build_repo_index.sh: symbols/refs/chunks/tests + mirrored brain
# atoms) queried through the B-3 router (scripts/brain_route.py, sparse BM25 +
# local embeddings). `recall` prints a narrative view for a human exploring
# the index; `ctx` is the LEAN, pipeable form — bare `file:line` pointers plus
# `atom:<ref>` refs, one per line, nothing else (scripts/ctx_format.py) — so
# an agent can grep/loop over the output and issue one targeted Read, instead
# of reading files or grepping the tree to find where to look.
#
# NO LLM, NO network, NO tokens, and fully OFFLINE: everything below reads
# only the repo-local SQLite index + the LOCAL git-versioned brain dir on
# disk — never the gateway. Works identically with the gateway stopped.
#
#   myai ctx <query...>              up to 5 pointers, one per line
#   myai ctx --k N <query...>        cap results (default 5)
#   myai ctx --json <query...>       raw router JSON (for scripts)
#   myai ctx --rebuild <query...>    force-rebuild the index first
#   myai ctx --db PATH <query...>    query a specific index db (tests/scripting)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DB="$ROOT/state/.repo_index.sqlite3"
K=5 JSON=0 REBUILD=0
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --k) K="$2"; shift 2 ;;
    --db) DB="$2"; shift 2 ;;
    --json) JSON=1; shift ;;
    --rebuild) REBUILD=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --) shift; while [ $# -gt 0 ]; do ARGS+=("$1"); shift; done ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
QUERY="${ARGS[*]:-}"
[ -n "$QUERY" ] || { echo "usage: myai ctx [--k N] [--json] [--rebuild] [--db PATH] <query>" >&2; exit 2; }
PY="$(command -v python3 || true)"
[ -n "$PY" ] || { echo "myai ctx: python3 not found" >&2; exit 3; }

# Ensure the index exists (token-free build on first use — a no-op once
# present, see build_repo_index.sh). Build chatter goes to stderr so stdout
# stays a clean pointer/JSON stream either way.
if [ "$REBUILD" = "1" ] || [ ! -f "$DB" ]; then
  BUILD_ARGS=(--db "$DB" --repo-root "$ROOT" --quiet)
  [ "$REBUILD" = "1" ] && BUILD_ARGS+=(--force)
  bash "$HERE/build_repo_index.sh" "${BUILD_ARGS[@]}" >&2 || {
    echo "myai ctx: index build failed" >&2; exit 1; }
fi

RAW="$("$PY" "$HERE/brain_route.py" --query "$QUERY" --k "$K" --db "$DB" --json)" || {
  echo "myai ctx: lookup failed" >&2; exit 1; }

if [ "$JSON" = "1" ]; then
  printf '%s\n' "$RAW"
else
  printf '%s' "$RAW" | "$PY" "$HERE/ctx_format.py"
fi
