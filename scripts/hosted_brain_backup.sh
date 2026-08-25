#!/usr/bin/env bash
# hosted_brain_backup.sh — fleet-wide backup/restore for the hosted-brain
# server store (ADR-017's per-tenant bare repos), per ADR-036.
#
# Distinct from scripts/myai_backup.sh: that tool snapshots ONE operator's own
# local brain by hand. This script snapshots EVERY tenant's hosted-brain repo
# on the gateway host (unattended, cron-driven) — see ADR-036 §"Context" for
# why the two are separate tools despite the shared archive-format idiom.
#
#   ./scripts/hosted_brain_backup.sh                      # backup: dated archive + prune
#   ./scripts/hosted_brain_backup.sh --quiet               # print only the archive path
#   ./scripts/hosted_brain_backup.sh --out <file>           # exact archive path
#   ./scripts/hosted_brain_backup.sh --restore <archive> --tenant <id> [--to <dir>] [--force]
#   ./scripts/hosted_brain_backup.sh --restore <archive> --tenant <id> --dry-run
#
# Layout backed up (mirrors runtime/src/core/hosted-brain.ts hostedRoot()):
#   $HOSTED_ROOT/<tenantId>.git    bare repo (verbatim cp -a)
#   $HOSTED_ROOT/<tenantId>.json   provisioning metadata (tokenHash only — the
#                                  plaintext access token is NEVER persisted
#                                  anywhere, archive included; ADR-017 §3)
#
# Archive layout (ADR-036 §1):
#   hosted-brain-backup-<host>-<YYYYMMDD-HHMMSS>.tar.gz
#     manifest.json     kind, formatVersion, host, createdAt, tenants[]
#     tenants/<id>.git/ tenants/<id>.json   (one pair per tenant)
#
# Resolution:
#   $MYAI_HOME                 config home                  (default ~/.myai)
#   $HOSTED_ROOT                override hosted-brains root  (default $MYAI_HOME/hosted-brains)
#   $HOSTED_BRAIN_BACKUP_DIR    where archives are written    (default $MYAI_HOME/hosted-brain-backups)
#   $HOSTED_BRAIN_BACKUP_REMOTE optional hook: `"$HOSTED_BRAIN_BACKUP_REMOTE" <archive-path>`
#                                run after each successful local backup (rsync/s3 cp/etc.)
#   $HOSTED_BRAIN_BACKUP_RETENTION_DAYS  local prune window   (default 14)
#
# Dependency-free besides tar/git/find (jq used opportunistically for the
# manifest, same fallback discipline as myai_backup.sh).
set -euo pipefail

usage() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; }

MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
HOSTED_ROOT="${HOSTED_ROOT:-$MYAI_HOME/hosted-brains}"
BACKUP_DIR_DEFAULT="${HOSTED_BRAIN_BACKUP_DIR:-$MYAI_HOME/hosted-brain-backups}"
RETENTION_DAYS="${HOSTED_BRAIN_BACKUP_RETENTION_DAYS:-14}"
LAST_RUN_FILE="$MYAI_HOME/hosted-brain-backup.last"

MODE=backup
QUIET=0 OUT="" ARCHIVE_IN="" TENANT="" TO_DIR="" FORCE=0 DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --restore) MODE=restore; shift; ARCHIVE_IN="${1:?--restore needs an archive path}" ;;
    --tenant) shift; TENANT="${1:?--tenant needs a value}" ;;
    --to) shift; TO_DIR="${1:?--to needs a path}" ;;
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --out) shift; OUT="${1:?--out needs a path}" ;;
    --quiet|-q) QUIET=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "hosted_brain_backup: unknown flag $1" >&2; usage >&2; exit 2 ;;
    *) echo "hosted_brain_backup: unexpected argument $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { [ "$QUIET" = "1" ] || echo "$@"; }

# ── restore mode ────────────────────────────────────────────────────────────
if [ "$MODE" = "restore" ]; then
  [ -f "$ARCHIVE_IN" ] || { echo "✗ archive not found: $ARCHIVE_IN" >&2; exit 1; }
  [ -n "$TENANT" ] || { echo "✗ --restore requires --tenant <id>" >&2; exit 2; }

  STAGE="$(mktemp -d -t hosted-brain-restore.XXXXXX)"
  trap 'rm -rf "$STAGE"' EXIT
  tar -xzf "$ARCHIVE_IN" -C "$STAGE" 2>/dev/null || { echo "✗ not a hosted-brain-backup archive: $ARCHIVE_IN" >&2; exit 2; }
  [ -f "$STAGE/manifest.json" ] || { echo "✗ archive missing manifest.json — not a hosted-brain-backup archive" >&2; exit 2; }

  SRC_GIT="$STAGE/tenants/$TENANT.git"
  SRC_JSON="$STAGE/tenants/$TENANT.json"
  [ -d "$SRC_GIT" ] || { echo "✗ tenant '$TENANT' not present in archive $ARCHIVE_IN" >&2; exit 1; }

  DEST_GIT="${TO_DIR:-$HOSTED_ROOT/$TENANT.git}"
  DEST_JSON="${TO_DIR:+$TO_DIR/$TENANT.json}"
  DEST_JSON="${DEST_JSON:-$HOSTED_ROOT/$TENANT.json}"

  if [ "$DRY_RUN" = "1" ]; then
    say "— dry run — would restore tenant '$TENANT' —"
    say "  from: $SRC_GIT"
    say "  to:   $DEST_GIT"
    exit 0
  fi

  if [ -d "$DEST_GIT" ] && [ -n "$(ls -A "$DEST_GIT" 2>/dev/null)" ]; then
    if [ "$FORCE" != "1" ]; then
      echo "✗ refusing to overwrite non-empty $DEST_GIT (pass --force to move it aside)" >&2
      exit 1
    fi
    TS="$(date +%Y%m%d-%H%M%S)"
    mv "$DEST_GIT" "$DEST_GIT.bak-$TS"
    say "  existing repo moved aside: $DEST_GIT.bak-$TS"
  fi

  mkdir -p "$(dirname "$DEST_GIT")"
  cp -a "$SRC_GIT" "$DEST_GIT"
  [ -f "$SRC_JSON" ] && cp -a "$SRC_JSON" "$DEST_JSON"

  restored_head="$(git -C "$DEST_GIT" rev-parse HEAD 2>/dev/null || echo '')"
  recorded_head=""
  if command -v jq >/dev/null 2>&1; then
    recorded_head="$(jq -r --arg t "$TENANT" '.tenants[] | select(.tenantId==$t) | .head // ""' "$STAGE/manifest.json" 2>/dev/null || echo '')"
  fi
  if [ -n "$recorded_head" ] && [ -n "$restored_head" ] && [ "$recorded_head" != "$restored_head" ]; then
    echo "✗ restore verification failed: manifest HEAD $recorded_head != restored HEAD $restored_head" >&2
    exit 1
  fi

  say "✓ Restored tenant '$TENANT' to $DEST_GIT"
  [ -n "$restored_head" ] && say "  HEAD: ${restored_head:0:8}"
  say "  Note: this restores the HOSTED remote only — the tenant's own local brain is untouched."
  say "  Their next push (brainSyncPush) re-populates this repo if their local HEAD is ahead."
  exit 0
fi

# ── backup mode ──────────────────────────────────────────────────────────────
BACKUP_DIR="$BACKUP_DIR_DEFAULT"

# ADR-036 §2.1 — the archive dir must not resolve inside the tree it backs up.
case "$BACKUP_DIR" in
  "$HOSTED_ROOT"|"$HOSTED_ROOT"/*)
    echo "✗ HOSTED_BRAIN_BACKUP_DIR ($BACKUP_DIR) is inside HOSTED_ROOT ($HOSTED_ROOT) — refusing (ADR-036 §2)" >&2
    exit 2
    ;;
esac

HOST="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | sed 's/^-*//;s/-*$//')"
[ -n "$HOST" ] || HOST="host"
TS="$(date +%Y%m%d-%H%M%S)"

if [ -n "$OUT" ]; then
  ARCHIVE="$OUT"
  mkdir -p "$(dirname "$ARCHIVE")"
else
  mkdir -p "$BACKUP_DIR"
  ARCHIVE="$BACKUP_DIR/hosted-brain-backup-$HOST-$TS.tar.gz"
fi

STAGE="$(mktemp -d -t hosted-brain-backup.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/tenants"

tenant_count=0
tenant_entries=""
if [ -d "$HOSTED_ROOT" ]; then
  while IFS= read -r git_dir; do
    [ -n "$git_dir" ] || continue
    base="$(basename "$git_dir")"
    tid="${base%.git}"
    cp -a "$git_dir" "$STAGE/tenants/$base"
    [ -f "$HOSTED_ROOT/$tid.json" ] && cp -a "$HOSTED_ROOT/$tid.json" "$STAGE/tenants/$tid.json"
    head_sha="$(git -C "$git_dir" rev-parse HEAD 2>/dev/null || echo '')"
    size_bytes="$(du -sk "$git_dir" 2>/dev/null | cut -f1 | tr -d ' ')"
    size_bytes=$(( ${size_bytes:-0} * 1024 ))
    tenant_count=$((tenant_count + 1))
    if command -v jq >/dev/null 2>&1; then
      entry="$(jq -n --arg t "$tid" --arg h "$head_sha" --argjson b "$size_bytes" '{tenantId:$t, head:$h, bytes:$b}')"
      tenant_entries="${tenant_entries}${tenant_entries:+,}$entry"
    fi
  done < <(find "$HOSTED_ROOT" -maxdepth 1 -type d -name '*.git' 2>/dev/null | sort)
fi

created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if command -v jq >/dev/null 2>&1; then
  jq -n --arg host "$HOST" --arg created "$created_at" --argjson n "$tenant_count" \
    --argjson tenants "[${tenant_entries}]" \
    '{kind:"hosted-brain-backup", formatVersion:1, createdAt:$created, host:$host, tenantCount:$n, tenants:$tenants}' \
    > "$STAGE/manifest.json"
else
  printf '{"kind":"hosted-brain-backup","formatVersion":1,"createdAt":"%s","host":"%s","tenantCount":%s,"tenants":[]}\n' \
    "$created_at" "$HOST" "$tenant_count" > "$STAGE/manifest.json"
fi

tar -czf "$ARCHIVE" -C "$STAGE" manifest.json tenants

size="$(du -h "$ARCHIVE" 2>/dev/null | cut -f1 | tr -d ' ')"

# ── retention: prune local archives older than N days ──────────────────────
pruned=0
if [ -d "$BACKUP_DIR" ] && [ "$RETENTION_DAYS" -gt 0 ] 2>/dev/null; then
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    rm -f "$old"
    pruned=$((pruned + 1))
  done < <(find "$BACKUP_DIR" -maxdepth 1 -name 'hosted-brain-backup-*.tar.gz' -mtime "+$RETENTION_DAYS" 2>/dev/null)
fi

# ── off-host replication hook (ADR-036 §2.2) ────────────────────────────────
remote_status="local-only"
if [ -n "${HOSTED_BRAIN_BACKUP_REMOTE:-}" ]; then
  if "$HOSTED_BRAIN_BACKUP_REMOTE" "$ARCHIVE"; then
    remote_status="replicated"
  else
    remote_status="replication-FAILED"
  fi
fi

{
  echo "timestamp: $created_at"
  echo "archive: $ARCHIVE"
  echo "tenants: $tenant_count"
  echo "pruned: $pruned"
  echo "remote: $remote_status"
} > "$LAST_RUN_FILE"

if [ "$QUIET" = "1" ]; then
  printf '%s\n' "$ARCHIVE"
else
  echo "✓ Hosted-brain backup written: $ARCHIVE (${size:-?}) — $tenant_count tenant(s)"
  [ "$pruned" -gt 0 ] && echo "  pruned $pruned archive(s) older than ${RETENTION_DAYS}d"
  if [ -z "${HOSTED_BRAIN_BACKUP_REMOTE:-}" ]; then
    echo "⚠ HOSTED_BRAIN_BACKUP_REMOTE not set — backups are LOCAL-ONLY, single point of failure (ADR-036 §2)"
  elif [ "$remote_status" = "replication-FAILED" ]; then
    echo "✗ HOSTED_BRAIN_BACKUP_REMOTE hook failed — backup is local-only for this run" >&2
  else
    echo "  replicated off-host via \$HOSTED_BRAIN_BACKUP_REMOTE"
  fi
  echo "  Restore one tenant with: $0 --restore $ARCHIVE --tenant <tenantId>"
fi
