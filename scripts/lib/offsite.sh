# lib/offsite.sh — shared helpers for the offsite (S3-compatible) backup leg
# (ADR-038). Sourced by scripts/offsite_backup.sh and
# scripts/offsite_restore_drill.sh — not executable on its own.
#
# Configuration resolution (env wins over the conf file; everything optional —
# the whole feature is INERT until OFFSITE_S3_BUCKET is set somewhere):
#
#   $MYAI_HOME/offsite-backup.conf     plain KEY=value lines (OFFSITE_* keys only)
#   OFFSITE_S3_BUCKET                  bucket name (unset => feature inert)
#   OFFSITE_S3_PREFIX                  object key prefix        (default myai-offsite)
#   OFFSITE_S3_ENDPOINT                S3-compatible endpoint URL (R2/B2/MinIO; unset => AWS)
#   OFFSITE_S3_CLIENT                  override client command (see contract below;
#                                      default: the aws CLI)
#   OFFSITE_BACKUP_PASSPHRASE_FILE     file whose first line is the AES passphrase
#   OFFSITE_BACKUP_PASSPHRASE          inline passphrase (file wins when both set)
#   OFFSITE_REMOTE_KEEP                newest per-host objects kept remotely (default 30, 0=keep all)
#
# Client command contract (lets tests run hermetically and lets operators plug
# rclone/mc/anything without this repo caring):
#   <client> put <local-file> <s3://bucket/key>
#   <client> get <s3://bucket/key> <local-file>
#   <client> ls  <s3://bucket/prefix/>      # one object name (basename) per line
#   <client> rm  <s3://bucket/key>
#
# shellcheck shell=bash

offsite_load_conf() {
  MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
  local conf="${OFFSITE_BACKUP_CONF:-$MYAI_HOME/offsite-backup.conf}"
  if [ -f "$conf" ]; then
    local k v cur
    # shellcheck disable=SC2034  # v is consumed via the eval below
    while IFS='=' read -r k v; do
      case "$k" in ''|\#*) continue ;; esac
      case "$k" in *[!A-Z0-9_]*) continue ;; OFFSITE_*) ;; *) continue ;; esac
      eval "cur=\${$k:-}"
      # env always wins over the conf file
      [ -n "$cur" ] && continue
      eval "export $k=\"\$v\""
    done < "$conf"
  fi
  OFFSITE_S3_PREFIX="${OFFSITE_S3_PREFIX:-myai-offsite}"
  OFFSITE_REMOTE_KEEP="${OFFSITE_REMOTE_KEEP:-30}"
}

offsite_configured() { [ -n "${OFFSITE_S3_BUCKET:-}" ]; }

# Resolves the encryption passphrase into exported $OFFSITE_PP (consumed via
# `openssl -pass env:OFFSITE_PP` so it never appears on an argv). Returns
# non-zero when no passphrase source is configured.
offsite_resolve_passphrase() {
  if [ -n "${OFFSITE_BACKUP_PASSPHRASE_FILE:-}" ] && [ -f "$OFFSITE_BACKUP_PASSPHRASE_FILE" ]; then
    OFFSITE_PP="$(head -1 "$OFFSITE_BACKUP_PASSPHRASE_FILE")"
  else
    OFFSITE_PP="${OFFSITE_BACKUP_PASSPHRASE:-}"
  fi
  export OFFSITE_PP
  [ -n "$OFFSITE_PP" ]
}

# offsite_s3 <put|get|ls|rm> <args…> — dispatch to the custom client when set,
# else the aws CLI (with --endpoint-url for S3-compatible providers).
offsite_s3() {
  local op="$1"; shift
  if [ -n "${OFFSITE_S3_CLIENT:-}" ]; then
    "$OFFSITE_S3_CLIENT" "$op" "$@"
    return $?
  fi
  command -v aws >/dev/null 2>&1 || {
    echo "✗ aws CLI not found and OFFSITE_S3_CLIENT not set — cannot reach $OFFSITE_S3_BUCKET" >&2
    return 2
  }
  local ep=()
  [ -n "${OFFSITE_S3_ENDPOINT:-}" ] && ep=(--endpoint-url "$OFFSITE_S3_ENDPOINT")
  case "$op" in
    put) aws "${ep[@]}" s3 cp "$1" "$2" --only-show-errors ;;
    get) aws "${ep[@]}" s3 cp "$1" "$2" --only-show-errors ;;
    ls)  aws "${ep[@]}" s3 ls "$1" ;;
    rm)  aws "${ep[@]}" s3 rm "$1" --only-show-errors ;;
    *)   echo "offsite_s3: unknown op $op" >&2; return 2 ;;
  esac
}

offsite_s3_url() { printf 's3://%s/%s/%s' "$OFFSITE_S3_BUCKET" "$OFFSITE_S3_PREFIX" "$1"; }

# All offsite object names under the prefix, one per line. Normalizes both
# aws `s3 ls` rows (date time size name) and bare-name client output via $NF.
offsite_ls_keys() {
  offsite_s3 ls "s3://$OFFSITE_S3_BUCKET/$OFFSITE_S3_PREFIX/" 2>/dev/null \
    | awk '{print $NF}' \
    | grep -E '^myai-offsite-.*\.tar\.gz\.enc$' || true
}

# Sort object names by the embedded -<YYYYMMDD>-<HHMMSS> timestamp (host names
# may themselves contain hyphens, so plain lexicographic sort is unsafe).
offsite_sort_by_ts() {
  sed -E 's/^(.*-([0-9]{8}-[0-9]{6})\.tar\.gz\.enc)$/\2 \1/' | sort | awk '{print $2}'
}

offsite_latest_key() { offsite_ls_keys | offsite_sort_by_ts | tail -1; }
