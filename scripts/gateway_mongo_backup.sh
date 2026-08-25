#!/usr/bin/env bash
# gateway_mongo_backup.sh — scheduled dump + rotation-to-object-storage for
# the HOSTED GATEWAY's own MongoDB (the real per-tenant Atlas database
# `runtime/src/shared/db.ts` connectDB() registers ~60 models against — tasks,
# schedules, agents/skills registry, audit chain, budgets, vectors, ...), per
# ADR-037.
#
# Distinct from three lookalike tools already in this repo:
#   - scripts/myai_backup.sh          ONE operator's own local brain (unrelated store)
#   - scripts/hosted_brain_backup.sh  hosted-brain bare git repos, ADR-036 (unrelated store)
#   - scripts/mongo_mirror.sh         Atlas -> local READ mirror for offline dev
#                                      resilience; no archive format, no retention,
#                                      no restore-drill — a live cache, not a DR backup
# This script is the actual disaster-recovery backup of the hosted gateway's
# live production data.
#
# Usage:
#   GATEWAY_MONGO_BACKUP_ENABLED=1 ./scripts/gateway_mongo_backup.sh
#   ./scripts/gateway_mongo_backup.sh --quiet
#   ./scripts/gateway_mongo_backup.sh --out <path>              # exact archive path
#   ./scripts/gateway_mongo_backup.sh --src <uri>                # override source
#   ./scripts/gateway_mongo_backup.sh --restore <archive> --to-uri <uri> [--drop] [--dry-run]
#
# Env-gate (ADR-037 §2, MANDATORY): without GATEWAY_MONGO_BACKUP_ENABLED=1 the
# backup path refuses to dump anything and exits 0 with a SKIP status. A
# workspace clone or a laptop must never mongodump the real hosted-gateway
# Atlas cluster just because MONGODB_URI happens to resolve to it — same
# DEPLOY-GUARD discipline as hooks/pre-tool/16-block-workspace-gateway-deploy.sh,
# applied here to backups instead of deploys. `--restore` is exempt from the
# gate (it only ever writes to an explicit --to-uri, never touches the live
# source, and is always an explicit opt-in action).
#
# Archive layout (mirrors ADR-036 §1's manifest-first idiom):
#   gateway-mongo-backup-<host>-<YYYYMMDD-HHMMSS>.tar.gz
#     manifest.json      kind, formatVersion, createdAt, host, db,
#                         collectionCounts{name:count}
#     mongo.archive.gz    the mongodump --archive --gzip payload, scoped to $db
#
# NOTE on consistency: mongodump's --oplog flag (which would make a dump
# internally consistent as of one instant) only works on a FULL, whole-instance
# dump — it is incompatible with a database-scoped URI, which this script uses
# deliberately (mirrors mongo_mirror.sh's db-scoped approach, and keeps the
# archive to exactly the hosted gateway's own database, not every database on
# the cluster). Each collection is therefore dumped consistently with itself
# but not guaranteed atomic *across* collections in the same run — for that
# guarantee, use Atlas Continuous Backup's point-in-time restore (see
# documentation/GATEWAY_MONGO_BACKUP_DR.md), which this script's archive is a
# provider-independent fallback for, not a replacement of. See that doc for the
# Continuous Backup path for restoring to an ARBITRARY timestamp (not just a
# backup boundary), which this script does not attempt to reimplement.
#
# Resolution (mirrors mongo_mirror.sh):
#   $MYAI_HOME                          config home                (default ~/.myai)
#   $GATEWAY_MONGO_BACKUP_DIR            where archives are written (default $MYAI_HOME/gateway-mongo-backups)
#   $GATEWAY_MONGO_BACKUP_RETENTION_DAYS local prune window          (default 14)
#   $GATEWAY_MONGO_BACKUP_REMOTE         optional hook: "$GATEWAY_MONGO_BACKUP_REMOTE" <archive-path>
#                                        run after each successful local backup
#                                        (rsync/aws s3 cp/rclone/etc. — object storage rotation)
#   $GATEWAY_MONGO_BACKUP_NETWORK        docker network for the throwaway tools
#                                        container (default: none — Atlas is
#                                        reached over the internet; set this
#                                        when --src/--to-uri point at a
#                                        container on a custom network, e.g. tests)
#   $MONGO_TOOLS_IMAGE                  mongodump/mongorestore image (default mongo:7)
#
# Source resolution (first hit wins, same chain as mongo_mirror.sh):
#   --src -> $MONGODB_URI -> running myai-gateway container's env -> root .env -> AI/.env
#
# Dependency-free besides docker + tar (jq used opportunistically for the
# manifest, same fallback discipline as hosted_brain_backup.sh).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MONGO_TOOLS_IMAGE="${MONGO_TOOLS_IMAGE:-mongo:7}"
GATEWAY_CONTAINER="${GATEWAY_CONTAINER:-myai-gateway}"

MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
BACKUP_DIR_DEFAULT="${GATEWAY_MONGO_BACKUP_DIR:-$MYAI_HOME/gateway-mongo-backups}"
RETENTION_DAYS="${GATEWAY_MONGO_BACKUP_RETENTION_DAYS:-14}"

# ── env_from_file FILE KEY → value of KEY= in FILE (no export), or '' ─────────
env_from_file() {
  local file="$1" key="$2"
  [ -f "$file" ] || { printf ''; return 0; }
  grep -E "^${key}=" "$file" 2>/dev/null | tail -1 | sed -E "s/^${key}=//" | sed -E 's/^"(.*)"$/\1/'
}

# ── mask_uri URI → hide credentials for safe logging (same as mongo_mirror.sh) ─
mask_uri() { printf '%s' "${1:-}" | sed -E 's#://[^/]*@#://***@#'; }

# ── db_from_uri URI → the database name in the connection string, or '' ───────
db_from_uri() {
  local uri="${1:-}" after
  after="${uri#*://}"
  case "$after" in
    */*) : ;;
    *) printf ''; return 0 ;;
  esac
  after="${after#*/}"
  after="${after%%\?*}"
  printf '%s' "$after"
}

# ── resolve_src → the source (dump-from) MONGODB_URI ──────────────────────────
resolve_src() {
  [ -n "${SRC_URI:-}" ] && { printf '%s' "$SRC_URI"; return 0; }
  [ -n "${MONGODB_URI:-}" ] && { printf '%s' "$MONGODB_URI"; return 0; }
  local from_gw
  from_gw="$(docker exec "$GATEWAY_CONTAINER" sh -c 'printf %s "$MONGODB_URI"' 2>/dev/null || true)"
  [ -n "$from_gw" ] && { printf '%s' "$from_gw"; return 0; }
  local v
  v="$(env_from_file "$REPO_ROOT/.env" MONGODB_URI)"
  [ -n "$v" ] && { printf '%s' "$v"; return 0; }
  env_from_file "$REPO_ROOT/AI/.env" MONGODB_URI
}

# ── write_last_run RESULT ARCHIVE DB N REMOTE → record the run's outcome ──────
# Recomputes the target path from $MYAI_HOME on every call (not a fixed
# top-level constant) so a caller overriding MYAI_HOME per-invocation (tests)
# is honored correctly.
write_last_run() {
  local home="${MYAI_HOME:-$HOME/.myai}"
  mkdir -p "$home" 2>/dev/null || return 0
  {
    printf 'timestamp: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'result: %s\n' "${1:-}"
    printf 'archive: %s\n' "${2:-none}"
    printf 'db: %s\n' "${3:-}"
    printf 'collections: %s\n' "${4:-0}"
    printf 'remote: %s\n' "${5:-local-only}"
  } > "$home/gateway-mongo-backup.last" 2>/dev/null || true
}

# Sourced by the test suite in helper-only mode — stop before the executable body.
[ "${GATEWAY_MONGO_BACKUP_LIB_ONLY:-0}" = 1 ] && return 0 2>/dev/null

usage() { sed -n '2,70p' "$0" | sed 's/^# \{0,1\}//'; }

MODE=backup
QUIET=0 OUT="" ARCHIVE_IN="" TO_URI="" DROP=0 DRY_RUN=0
NETWORK="${GATEWAY_MONGO_BACKUP_NETWORK:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --restore) MODE=restore; shift; ARCHIVE_IN="${1:?--restore needs an archive path}" ;;
    --to-uri) shift; TO_URI="${1:?--to-uri needs a value}" ;;
    --drop) DROP=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --out) shift; OUT="${1:?--out needs a path}" ;;
    --src) shift; SRC_URI="${1:?--src needs a value}" ;;
    --network) shift; NETWORK="${1:?--network needs a value}" ;;
    --quiet|-q) QUIET=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "gateway_mongo_backup: unknown flag $1" >&2; usage >&2; exit 2 ;;
    *) echo "gateway_mongo_backup: unexpected argument $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { [ "$QUIET" = "1" ] || echo "$@"; }

NET_FLAGS=()
[ -n "$NETWORK" ] && NET_FLAGS=(--network "$NETWORK")

# ── restore mode (always explicit, never env-gated — see header) ───────────
if [ "$MODE" = "restore" ]; then
  [ -f "$ARCHIVE_IN" ] || { echo "✗ archive not found: $ARCHIVE_IN" >&2; exit 1; }
  [ -n "$TO_URI" ] || { echo "✗ --restore requires --to-uri <uri>" >&2; exit 2; }

  STAGE="$(mktemp -d -t gateway-mongo-restore.XXXXXX)"
  trap 'rm -rf "$STAGE"' EXIT
  tar -xzf "$ARCHIVE_IN" -C "$STAGE" 2>/dev/null || { echo "✗ not a gateway-mongo-backup archive: $ARCHIVE_IN" >&2; exit 2; }
  [ -f "$STAGE/manifest.json" ] && [ -f "$STAGE/mongo.archive.gz" ] || { echo "✗ archive missing manifest.json/mongo.archive.gz: $ARCHIVE_IN" >&2; exit 2; }

  DROP_FLAG=""
  [ "$DROP" = 1 ] && DROP_FLAG="--drop"

  if [ "$DRY_RUN" = "1" ]; then
    say "— dry run — would restore —"
    say "  from:  $ARCHIVE_IN"
    say "  to:    $(mask_uri "$TO_URI")"
    say "  drop:  $([ "$DROP" = 1 ] && echo yes || echo no)"
    exit 0
  fi

  command -v docker >/dev/null 2>&1 || { echo "✗ docker not found on PATH" >&2; exit 127; }

  say "restoring $ARCHIVE_IN → $(mask_uri "$TO_URI")…"
  if ! docker run --rm "${NET_FLAGS[@]}" \
      -v "$STAGE:/dump" -e TO="$TO_URI" \
      "$MONGO_TOOLS_IMAGE" sh -c "mongorestore --uri=\"\$TO\" --archive=/dump/mongo.archive.gz --gzip $DROP_FLAG --quiet"; then
    echo "✗ restore FAILED — target may be partially restored" >&2
    exit 1
  fi

  say "✓ Restored $ARCHIVE_IN into $(mask_uri "$TO_URI")"
  exit 0
fi

# ── backup mode ──────────────────────────────────────────────────────────────
if [ "${GATEWAY_MONGO_BACKUP_ENABLED:-0}" != "1" ]; then
  say "— GATEWAY_MONGO_BACKUP_ENABLED is not set to 1 — refusing to dump the hosted-gateway database (ADR-037 §2) —"
  say "  set GATEWAY_MONGO_BACKUP_ENABLED=1 on the gateway host to actually run this backup"
  write_last_run "SKIP" "" "" 0 "not-enabled"
  exit 0
fi

command -v docker >/dev/null 2>&1 || { echo "✗ docker not found on PATH" >&2; write_last_run "FAIL" "" "" 0 "no-docker"; exit 127; }

SRC_URI_RESOLVED="$(resolve_src)"
if [ -z "$SRC_URI_RESOLVED" ]; then
  echo "✗ could not resolve a source MONGODB_URI (pass --src, or set MONGODB_URI, or start the gateway)" >&2
  write_last_run "FAIL" "" "" 0 "no-source-uri"
  exit 1
fi
DB="$(db_from_uri "$SRC_URI_RESOLVED")"
[ -z "$DB" ] && DB="${MONGODB_NAME:-myai}"

HOST="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | sed 's/^-*//;s/-*$//')"
[ -n "$HOST" ] || HOST="host"
TS="$(date +%Y%m%d-%H%M%S)"

BACKUP_DIR="$BACKUP_DIR_DEFAULT"
if [ -n "$OUT" ]; then
  ARCHIVE="$OUT"
  mkdir -p "$(dirname "$ARCHIVE")"
else
  mkdir -p "$BACKUP_DIR"
  ARCHIVE="$BACKUP_DIR/gateway-mongo-backup-$HOST-$TS.tar.gz"
fi

STAGE="$(mktemp -d -t gateway-mongo-backup.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

say "== gateway_mongo_backup =="
say "  db:      $DB"
say "  source:  $(mask_uri "$SRC_URI_RESOLVED")"
say "  archive: $ARCHIVE"

# Per-collection doc counts BEFORE the dump — the manifest's ground truth
# for the restore-drill to cross-check against after restore (ADR-037 §4).
COUNTS_JSON="{}"
if command -v jq >/dev/null 2>&1; then
  counts_raw="$(docker run --rm "${NET_FLAGS[@]}" "$MONGO_TOOLS_IMAGE" \
    mongosh "$SRC_URI_RESOLVED" --quiet --eval '
      const out = {};
      db.getCollectionNames().forEach(function(c) { out[c] = db.getCollection(c).countDocuments({}); });
      print(JSON.stringify(out));
    ' 2>/dev/null | tail -1)"
  if [ -n "$counts_raw" ] && printf '%s' "$counts_raw" | jq -e . >/dev/null 2>&1; then
    COUNTS_JSON="$counts_raw"
  else
    say "  ⚠ could not enumerate collection counts pre-dump (non-fatal — manifest will have empty collectionCounts)"
  fi
fi

if ! docker run --rm "${NET_FLAGS[@]}" \
    -v "$STAGE:/dump" -e SRC="$SRC_URI_RESOLVED" \
    "$MONGO_TOOLS_IMAGE" sh -c 'mongodump --uri="$SRC" --archive=/dump/mongo.archive.gz --gzip --quiet'; then
  echo "✗ mongodump FAILED — no archive written" >&2
  write_last_run "FAIL" "" "$DB" 0 "mongodump-failed"
  exit 1
fi

created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
n_collections="$(printf '%s' "$COUNTS_JSON" | (command -v jq >/dev/null 2>&1 && jq 'length' 2>/dev/null || echo 0))"
[ -z "$n_collections" ] && n_collections=0

if command -v jq >/dev/null 2>&1; then
  jq -n --arg host "$HOST" --arg created "$created_at" --arg db "$DB" --argjson counts "$COUNTS_JSON" \
    '{kind:"gateway-mongo-backup", formatVersion:1, createdAt:$created, host:$host, db:$db, collectionCounts:$counts}' \
    > "$STAGE/manifest.json"
else
  printf '{"kind":"gateway-mongo-backup","formatVersion":1,"createdAt":"%s","host":"%s","db":"%s","collectionCounts":{}}\n' \
    "$created_at" "$HOST" "$DB" > "$STAGE/manifest.json"
fi

tar -czf "$ARCHIVE" -C "$STAGE" manifest.json mongo.archive.gz
size="$(du -h "$ARCHIVE" 2>/dev/null | cut -f1 | tr -d ' ')"

# ── retention: prune local archives older than N days ──────────────────────
pruned=0
if [ -d "$BACKUP_DIR" ] && [ "$RETENTION_DAYS" -gt 0 ] 2>/dev/null; then
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    rm -f "$old"
    pruned=$((pruned + 1))
  done < <(find "$BACKUP_DIR" -maxdepth 1 -name 'gateway-mongo-backup-*.tar.gz' -mtime "+$RETENTION_DAYS" 2>/dev/null)
fi

# ── rotation to object storage (operator hook) ──────────────────────────────
remote_status="local-only"
if [ -n "${GATEWAY_MONGO_BACKUP_REMOTE:-}" ]; then
  if "$GATEWAY_MONGO_BACKUP_REMOTE" "$ARCHIVE"; then
    remote_status="replicated"
  else
    remote_status="replication-FAILED"
  fi
fi

write_last_run "PASS" "$ARCHIVE" "$DB" "$n_collections" "$remote_status"

if [ "$QUIET" = "1" ]; then
  printf '%s\n' "$ARCHIVE"
else
  echo "✓ Gateway Mongo backup written: $ARCHIVE (${size:-?}) — db '$DB', $n_collections collection(s) counted"
  [ "$pruned" -gt 0 ] && echo "  pruned $pruned archive(s) older than ${RETENTION_DAYS}d"
  if [ -z "${GATEWAY_MONGO_BACKUP_REMOTE:-}" ]; then
    echo "⚠ GATEWAY_MONGO_BACKUP_REMOTE not set — backups are LOCAL-ONLY, single point of failure (ADR-037 §3)"
  elif [ "$remote_status" = "replication-FAILED" ]; then
    echo "✗ GATEWAY_MONGO_BACKUP_REMOTE hook failed — backup is local-only for this run" >&2
  else
    echo "  rotated to object storage via \$GATEWAY_MONGO_BACKUP_REMOTE"
  fi
  echo "  Restore with: $0 --restore $ARCHIVE --to-uri <uri> [--drop]"
  echo "  See documentation/GATEWAY_MONGO_BACKUP_DR.md for the full point-in-time restore procedure."
fi
