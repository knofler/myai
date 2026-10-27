#!/usr/bin/env bash
# offsite_backup.sh — encrypted offsite push of the brain store + gateway/CLI
# config to S3-compatible object storage (ADR-038). Durability beyond a single
# machine: a stolen laptop or dead disk must not be able to take the brain
# with it.
#
# Distinct from scripts/myai_backup.sh (single-machine snapshot to a local
# .tar.gz — this script REUSES it to build the snapshot) and from the gateway
# Mongo DR tooling (ADR-037: task/plan data). This is the OFFSITE leg: the
# snapshot is AES-256 encrypted client-side, pushed to a BYO bucket, and
# pruned remotely by per-host retention count.
#
#   ./scripts/offsite_backup.sh                        # snapshot → encrypt → upload → prune
#   ./scripts/offsite_backup.sh --quiet                 # print only the uploaded object name
#   ./scripts/offsite_backup.sh --fetch latest --out f   # download+decrypt newest → plain myai-backup archive
#   ./scripts/offsite_backup.sh --fetch <object> --out f # download+decrypt a specific object
#
# INERT until configured: with OFFSITE_S3_BUCKET unset (env and
# $MYAI_HOME/offsite-backup.conf both), every mode exits 0 having touched
# nothing — safe to schedule fleet-wide before any bucket exists.
#
# NEVER uploads plaintext: a configured bucket with no passphrase source
# (OFFSITE_BACKUP_PASSPHRASE_FILE / OFFSITE_BACKUP_PASSPHRASE) is a hard
# exit 2, not a silent unencrypted upload.
#
# Object name:  myai-offsite-<host>-<YYYYMMDD-HHMMSS>.tar.gz.enc
# Cipher:       openssl enc -aes-256-cbc -md sha256 -pbkdf2 -iter 200000 -salt
# Recovery:     --fetch latest --out b.tar.gz  →  myai restore b.tar.gz
# Status file:  $MYAI_HOME/offsite-backup.last (mirrors the .last convention)
#
# Config keys + client contract: see scripts/lib/offsite.sh header.
set -euo pipefail

usage() { sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; }

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/offsite.sh
. "$HERE/lib/offsite.sh" || { echo "✗ scripts/lib/offsite.sh missing — broken checkout" >&2; exit 2; }

MODE=backup
QUIET=0 FETCH_KEY="" OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fetch) MODE=fetch; shift; FETCH_KEY="${1:?--fetch needs 'latest' or an object name}" ;;
    --out) shift; OUT="${1:?--out needs a path}" ;;
    --quiet|-q) QUIET=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "offsite_backup: unknown flag $1" >&2; usage >&2; exit 2 ;;
    *) echo "offsite_backup: unexpected argument $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { [ "$QUIET" = "1" ] || echo "$@"; }

offsite_load_conf
LAST_RUN_FILE="$MYAI_HOME/offsite-backup.last"

if ! offsite_configured; then
  say "— offsite backup not configured (OFFSITE_S3_BUCKET unset) — inert, nothing to do —"
  say "  Configure a BYO bucket via env or $MYAI_HOME/offsite-backup.conf (see scripts/lib/offsite.sh)"
  exit 0
fi

command -v openssl >/dev/null 2>&1 || { echo "✗ openssl not found — required for client-side encryption" >&2; exit 2; }

if ! offsite_resolve_passphrase; then
  echo "✗ OFFSITE_S3_BUCKET is set but no passphrase source is configured" >&2
  echo "  (set OFFSITE_BACKUP_PASSPHRASE_FILE or OFFSITE_BACKUP_PASSPHRASE)" >&2
  echo "  Refusing to upload the brain unencrypted — offsite objects MUST be ciphertext (ADR-038)." >&2
  exit 2
fi

write_status() {
  # $1=result $2=object $3=detail
  mkdir -p "$(dirname "$LAST_RUN_FILE")"
  {
    echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "bucket: $OFFSITE_S3_BUCKET"
    echo "object: ${2:-none}"
    echo "result: $1"
    echo "detail: $3"
  } > "$LAST_RUN_FILE"
}

STAGE="$(mktemp -d -t myai-offsite.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

# ── fetch mode: download + decrypt back to a plain myai-backup archive ──────
if [ "$MODE" = "fetch" ]; then
  [ -n "$OUT" ] || { echo "✗ --fetch requires --out <file>" >&2; exit 2; }
  KEY="$FETCH_KEY"
  if [ "$KEY" = "latest" ]; then
    KEY="$(offsite_latest_key)"
    [ -n "$KEY" ] || { echo "✗ no offsite objects found under s3://$OFFSITE_S3_BUCKET/$OFFSITE_S3_PREFIX/" >&2; exit 1; }
  fi
  if ! offsite_s3 get "$(offsite_s3_url "$KEY")" "$STAGE/fetched.enc"; then
    echo "✗ download failed: $(offsite_s3_url "$KEY")" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$OUT")"
  # openssl's exit code alone does not prove the key was right. A wrong key is
  # not detected because AES-CBC has no integrity check: it "decrypts" with exit 0 whenever the
  # garbage happens to end in valid PKCS#7 padding (~1 in 256 — measured 8/2000;
  # the CI flake of 2026-10-27). Decrypt into the stage, accept it only when it
  # is a real myai-backup archive (gzip tar carrying manifest.json), and only
  # then move it to --out — a failed fetch never leaves a file behind.
  if ! openssl enc -d -aes-256-cbc -md sha256 -pbkdf2 -iter 200000 \
      -in "$STAGE/fetched.enc" -out "$STAGE/fetched.tar.gz" -pass env:OFFSITE_PP 2>/dev/null \
     || ! tar -tzf "$STAGE/fetched.tar.gz" >"$STAGE/fetched.list" 2>/dev/null \
     || ! grep -qE '^(\./)?manifest\.json$' "$STAGE/fetched.list"; then
    rm -f "$STAGE/fetched.tar.gz"
    echo "✗ decryption failed for $KEY — wrong passphrase or corrupt object" >&2
    exit 1
  fi
  mv -f "$STAGE/fetched.tar.gz" "$OUT"
  if [ "$QUIET" = "1" ]; then
    printf '%s\n' "$OUT"
  else
    echo "✓ Fetched + decrypted $KEY → $OUT"
    echo "  Restore with: myai restore $OUT"
  fi
  exit 0
fi

# ── backup mode ──────────────────────────────────────────────────────────────
HOST="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | sed 's/^-*//;s/-*$//')"
[ -n "$HOST" ] || HOST="host"
TS="$(date +%Y%m%d-%H%M%S)"
OBJECT="myai-offsite-$HOST-$TS.tar.gz.enc"

# 1) snapshot — reuse the single-machine tool so the archive format (and its
#    `myai restore` round-trip) stays a single source of truth
if ! bash "$HERE/myai_backup.sh" --out "$STAGE/plain.tar.gz" --quiet >/dev/null; then
  write_status "FAIL" "" "local snapshot failed (myai_backup.sh)"
  echo "✗ local snapshot failed — nothing uploaded" >&2
  exit 1
fi

# 2) encrypt client-side — the bucket only ever sees ciphertext
openssl enc -aes-256-cbc -md sha256 -pbkdf2 -iter 200000 -salt \
  -in "$STAGE/plain.tar.gz" -out "$STAGE/$OBJECT" -pass env:OFFSITE_PP

# 3) upload
if ! offsite_s3 put "$STAGE/$OBJECT" "$(offsite_s3_url "$OBJECT")"; then
  write_status "FAIL" "$OBJECT" "upload failed to s3://$OFFSITE_S3_BUCKET/$OFFSITE_S3_PREFIX/"
  echo "✗ upload failed — backup is NOT offsite for this run" >&2
  exit 1
fi

size="$(du -h "$STAGE/$OBJECT" 2>/dev/null | cut -f1 | tr -d ' ')"

# 4) remote retention — keep the newest $OFFSITE_REMOTE_KEEP objects FOR THIS
#    HOST (other hosts pushing to the same bucket are never pruned from here)
pruned=0
if [ "$OFFSITE_REMOTE_KEEP" -gt 0 ] 2>/dev/null; then
  host_keys="$(offsite_ls_keys | grep -F "myai-offsite-$HOST-" | offsite_sort_by_ts || true)"
  total="$(printf '%s\n' "$host_keys" | grep -c . || true)"
  if [ "$total" -gt "$OFFSITE_REMOTE_KEEP" ]; then
    while IFS= read -r old; do
      [ -n "$old" ] || continue
      if offsite_s3 rm "$(offsite_s3_url "$old")"; then
        pruned=$((pruned + 1))
      else
        say "⚠ failed to prune remote object $old (left in place)"
      fi
    done < <(printf '%s\n' "$host_keys" | head -n "$((total - OFFSITE_REMOTE_KEEP))")
  fi
fi

write_status "PASS" "$OBJECT" "uploaded (${size:-?}), pruned $pruned"

if [ "$QUIET" = "1" ]; then
  printf '%s\n' "$OBJECT"
else
  echo "✓ Offsite backup uploaded: $(offsite_s3_url "$OBJECT") (${size:-?})"
  [ "$pruned" -gt 0 ] && echo "  pruned $pruned older remote object(s) (keep=$OFFSITE_REMOTE_KEEP per host)"
  echo "  Verify restorability with: $HERE/offsite_restore_drill.sh"
  echo "  Recover with: $0 --fetch latest --out backup.tar.gz && myai restore backup.tar.gz"
fi
