#!/usr/bin/env bash
# offsite_restore_drill.sh — scheduled proof that the offsite objects pushed by
# scripts/offsite_backup.sh are actually restorable (ADR-038): downloads the
# newest object from the bucket, decrypts it with the configured passphrase,
# extracts into a throwaway scratch dir, and verifies the payload — then
# discards the scratch copy. Never touches the live brain, $MYAI_HOME, or the
# bucket contents. "Backups you've never restored aren't backups."
#
#   ./scripts/offsite_restore_drill.sh                # drill the newest offsite object
#   ./scripts/offsite_restore_drill.sh --key <name>    # drill a specific object (tests, ad-hoc)
#   ./scripts/offsite_restore_drill.sh --quiet         # print only the final PASS/FAIL line
#
# Verification per object:
#   1. download succeeds            (bucket reachable, object present)
#   2. openssl decrypt succeeds     (passphrase correct, ciphertext intact)
#   3. tar extraction succeeds      (payload intact)
#   4. manifest.json kind=myai-backup
#   5. brain repo (when present):   git fsck --full clean + resolvable HEAD
#                                   + HEAD matches the manifest's recorded head
#
# Exit 0 PASS  = newest object downloaded, decrypted, and verified clean.
# Exit 0 SKIP  = feature inert (no bucket configured) or bucket has no offsite
#                objects yet — recorded, but never fails a cron run.
# Exit 1 FAIL  = a real problem: unreachable/undecryptable/corrupt object, bad
#                manifest, or a brain repo that fails fsck. Loud on purpose.
# Exit 2       = configuration error (bucket set but no passphrase source).
#
# Status file: $MYAI_HOME/offsite-restore-drill.last (the .last convention).
# Config keys + client contract: see scripts/lib/offsite.sh header.
set -uo pipefail

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; }

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/offsite.sh
. "$HERE/lib/offsite.sh" || { echo "✗ scripts/lib/offsite.sh missing — broken checkout" >&2; exit 2; }

QUIET=0 KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key) shift; KEY="${1:?--key needs an object name}" ;;
    --quiet|-q) QUIET=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "offsite_restore_drill: unknown flag $1" >&2; usage >&2; exit 2 ;;
    *) echo "offsite_restore_drill: unexpected argument $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { [ "$QUIET" = "1" ] || echo "$@"; }

offsite_load_conf
LAST_RUN_FILE="${OFFSITE_RESTORE_DRILL_LAST:-$MYAI_HOME/offsite-restore-drill.last}"

if ! offsite_configured; then
  say "— offsite backup not configured (OFFSITE_S3_BUCKET unset) — inert, nothing to drill —"
  exit 0
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

if ! offsite_resolve_passphrase; then
  echo "✗ OFFSITE_S3_BUCKET is set but no passphrase source is configured — cannot decrypt anything" >&2
  write_status "FAIL" "" "no passphrase source configured (OFFSITE_BACKUP_PASSPHRASE_FILE/OFFSITE_BACKUP_PASSPHRASE)"
  exit 2
fi

if [ -z "$KEY" ]; then
  KEY="$(offsite_latest_key)"
fi
if [ -z "$KEY" ]; then
  say "— no offsite objects under s3://$OFFSITE_S3_BUCKET/$OFFSITE_S3_PREFIX/ — nothing to drill yet —"
  write_status "SKIP" "" "no offsite objects present yet"
  exit 0
fi

SCRATCH="$(mktemp -d -t offsite-restore-drill.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail_drill() {
  echo "✗ OFFSITE RESTORE DRILL FAILED: $1" >&2
  write_status "FAIL" "$KEY" "$1"
  exit 1
}

say "— drilling $(offsite_s3_url "$KEY") —"

# 1) download
offsite_s3 get "$(offsite_s3_url "$KEY")" "$SCRATCH/object.enc" \
  || fail_drill "download failed: $(offsite_s3_url "$KEY")"

# 2) decrypt — this is the check the local drills can't do: proves the
#    passphrase on file actually opens what's in the bucket
if ! openssl enc -d -aes-256-cbc -md sha256 -pbkdf2 -iter 200000 \
    -in "$SCRATCH/object.enc" -out "$SCRATCH/plain.tar.gz" -pass env:OFFSITE_PP 2>/dev/null; then
  fail_drill "decryption failed — wrong passphrase or corrupt ciphertext: $KEY"
fi

# 3) extract
mkdir -p "$SCRATCH/tree"
tar -xzf "$SCRATCH/plain.tar.gz" -C "$SCRATCH/tree" 2>/dev/null \
  || fail_drill "decrypted payload is not a readable tar.gz: $KEY"

# 4) manifest
MANIFEST="$SCRATCH/tree/manifest.json"
[ -f "$MANIFEST" ] || fail_drill "archive missing manifest.json — not a myai-backup archive"
grep -q '"kind" *: *"myai-backup"\|"kind":"myai-backup"' "$MANIFEST" \
  || fail_drill "manifest kind is not myai-backup"

# 5) brain verification (jq used opportunistically for the manifest cross-check,
#    same fallback discipline as the other drills)
brain_note="no brain in archive"
manifest_brain_present=""
recorded_head=""
if command -v jq >/dev/null 2>&1; then
  manifest_brain_present="$(jq -r '.brain.present // empty' "$MANIFEST" 2>/dev/null || echo '')"
  recorded_head="$(jq -r '.brain.head // empty' "$MANIFEST" 2>/dev/null || echo '')"
fi

if [ -d "$SCRATCH/tree/brain/.git" ]; then
  if ! fsck_out="$(git -C "$SCRATCH/tree/brain" fsck --full 2>&1)"; then
    fail_drill "restored brain repo fails git fsck: $(echo "$fsck_out" | head -1)"
  fi
  restored_head="$(git -C "$SCRATCH/tree/brain" rev-parse HEAD 2>/dev/null || echo '')"
  [ -n "$restored_head" ] || fail_drill "restored brain repo has no resolvable HEAD"
  if [ -n "$recorded_head" ] && [ "$recorded_head" != "$restored_head" ]; then
    fail_drill "manifest brain HEAD $recorded_head != restored HEAD $restored_head"
  fi
  brain_note="brain HEAD ${restored_head:0:8}, fsck clean"
elif [ "$manifest_brain_present" = "true" ]; then
  fail_drill "manifest declares a brain but archive has no brain/.git"
fi

config_count="$(find "$SCRATCH/tree/config" -type f 2>/dev/null | wc -l | tr -d ' ')"

say "✓ OFFSITE RESTORE DRILL PASSED: $KEY decrypted + verified ($brain_note, $config_count config file(s))"
write_status "PASS" "$KEY" "$brain_note; $config_count config file(s)"
exit 0
