#!/usr/bin/env bash
# gateway_mongo_restore_drill.sh — automated "restore a backup and prove it
# actually works" drill for scripts/gateway_mongo_backup.sh archives, per
# ADR-037 §4. Mirrors scripts/hosted_brain_restore_drill.sh's role for
# ADR-036, applied to the hosted gateway's real Mongo data instead of the
# hosted-brain bare git repos.
#
# Restores the chosen archive's mongodump payload into a THROWAWAY, disposable
# mongod container on its own throwaway docker network — never the shared
# myai-mongo/gateway stack (DEPLOY GUARD) and never a real destination URI.
# Verifies the restore by comparing each collection's document count against
# the manifest's pre-dump `collectionCounts` snapshot, then tears everything
# down. A backup nobody has ever restored isn't a backup — this is the
# scheduled proof that it is one.
#
#   ./scripts/gateway_mongo_restore_drill.sh                 # drill the newest archive in $GATEWAY_MONGO_BACKUP_DIR
#   ./scripts/gateway_mongo_restore_drill.sh --archive <f>    # drill a specific archive (tests, ad-hoc)
#   ./scripts/gateway_mongo_restore_drill.sh --quiet          # print only the final PASS/FAIL line
#
# Resolution (mirrors gateway_mongo_backup.sh):
#   $MYAI_HOME                          config home                (default ~/.myai)
#   $GATEWAY_MONGO_BACKUP_DIR            where archives live         (default $MYAI_HOME/gateway-mongo-backups)
#   $GATEWAY_MONGO_RESTORE_DRILL_LAST    status file                 (default $MYAI_HOME/gateway-mongo-restore-drill.last)
#   $MONGO_TOOLS_IMAGE                  mongodump/mongorestore + mongod image (default mongo:7)
#
# Exit 0 = archive found, restore succeeded, and every collection's document
#          count matches the manifest's pre-dump snapshot (or the archive
#          legitimately covers zero collections — not a failure either).
# Exit 0 with a SKIP result = no archive exists yet to drill (fresh host,
#          backup cron hasn't run) — recorded in `.last` but not a failure.
# Exit 1 = drill found a real problem: unreadable/corrupt archive, missing
#          manifest/payload, the ephemeral mongod never came up, mongorestore
#          failed, or any collection's restored count diverges from the
#          manifest. Loud and non-zero on purpose (ADR-037 §3's "visible gap,
#          never silent" posture, same as ADR-036 §2.2).
set -uo pipefail

MONGO_TOOLS_IMAGE="${MONGO_TOOLS_IMAGE:-mongo:7}"
MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
BACKUP_DIR="${GATEWAY_MONGO_BACKUP_DIR:-$MYAI_HOME/gateway-mongo-backups}"
LAST_RUN_FILE="${GATEWAY_MONGO_RESTORE_DRILL_LAST:-$MYAI_HOME/gateway-mongo-restore-drill.last}"

QUIET=0
ARCHIVE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --archive) shift; ARCHIVE="${1:?--archive needs a path}" ;;
    --quiet|-q) QUIET=1 ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "gateway_mongo_restore_drill: unknown flag $1" >&2; exit 2 ;;
    *) echo "gateway_mongo_restore_drill: unexpected argument $1" >&2; exit 2 ;;
  esac
  shift
done

say() { [ "$QUIET" = "1" ] || echo "$@"; }

write_status() {
  mkdir -p "$(dirname "$LAST_RUN_FILE")" 2>/dev/null || true
  {
    echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "archive: ${2:-none}"
    echo "result: $1"
    echo "detail: $3"
  } > "$LAST_RUN_FILE" 2>/dev/null || true
}

if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$(find "$BACKUP_DIR" -maxdepth 1 -name 'gateway-mongo-backup-*.tar.gz' 2>/dev/null | sort | tail -1)"
fi

if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  say "— no backup archive found under $BACKUP_DIR — nothing to drill yet —"
  write_status "SKIP" "" "no archive present under $BACKUP_DIR"
  exit 0
fi

SCRATCH="$(mktemp -d -t gateway-mongo-restore-drill.XXXXXX)"
DRILL_ID="gw-mongo-drill-$$-$RANDOM"
NET="net-$DRILL_ID"
NODE="node-$DRILL_ID"

cleanup() {
  docker rm -f "$NODE" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

fail_drill() {
  echo "✗ RESTORE DRILL FAILED: $1" >&2
  write_status "FAIL" "$ARCHIVE" "$1"
  exit 1
}

# ── extract (first integrity check — a corrupt tar.gz fails right here, and
# cheaply, before we pay for spinning up docker at all) ─────────────────────
if ! tar -xzf "$ARCHIVE" -C "$SCRATCH" 2>/dev/null; then
  fail_drill "archive is unreadable/corrupt (tar extraction failed): $ARCHIVE"
fi
[ -f "$SCRATCH/manifest.json" ] || fail_drill "archive missing manifest.json: $ARCHIVE"
[ -f "$SCRATCH/mongo.archive.gz" ] || fail_drill "archive missing mongo.archive.gz payload: $ARCHIVE"

command -v docker >/dev/null 2>&1 || fail_drill "docker not found on PATH — cannot restore-drill without it"

DB=""
if command -v jq >/dev/null 2>&1; then
  DB="$(jq -r '.db // ""' "$SCRATCH/manifest.json" 2>/dev/null || echo '')"
fi
[ -n "$DB" ] || DB="${MONGODB_NAME:-myai}"

say "— drilling $ARCHIVE (db '$DB') —"

# ── stand up a throwaway, isolated mongod (never the shared myai-mongo) ────
docker network create "$NET" >/dev/null 2>&1 || fail_drill "could not create throwaway docker network $NET"
if ! docker run -d --rm --name "$NODE" --network "$NET" "$MONGO_TOOLS_IMAGE" mongod --quiet --bind_ip_all >/dev/null 2>&1; then
  fail_drill "could not start throwaway mongod container ($MONGO_TOOLS_IMAGE)"
fi

ready=0
for _ in $(seq 1 30); do
  if docker exec "$NODE" mongosh --quiet --eval 'db.runCommand({ping:1})' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || fail_drill "throwaway mongod never became ready within 30s"

# ── restore ──────────────────────────────────────────────────────────────
if ! docker run --rm --network "$NET" -v "$SCRATCH:/dump" -e TO="mongodb://$NODE:27017/$DB" "$MONGO_TOOLS_IMAGE" \
    sh -c 'mongorestore --uri="$TO" --archive=/dump/mongo.archive.gz --gzip --drop --quiet'; then
  fail_drill "mongorestore failed against the throwaway container"
fi

# ── verify: restored per-collection counts vs. manifest snapshot ───────────
restored_json="$(docker exec "$NODE" mongosh "mongodb://localhost:27017/$DB" --quiet --eval '
  const out = {};
  db.getCollectionNames().forEach(function(c) { out[c] = db.getCollection(c).countDocuments({}); });
  print(JSON.stringify(out));
' 2>/dev/null | tail -1)"
[ -n "$restored_json" ] || fail_drill "could not enumerate restored collections/counts"

if ! command -v jq >/dev/null 2>&1; then
  say "✓ RESTORE DRILL PASSED (unverified counts — jq not installed): mongorestore succeeded from $ARCHIVE"
  write_status "PASS" "$ARCHIVE" "mongorestore succeeded, counts unverified (no jq)"
  exit 0
fi

manifest_counts="$(jq -c '.collectionCounts // {}' "$SCRATCH/manifest.json" 2>/dev/null || echo '{}')"

fail_reasons=()
pass_count=0
total=0
for name in $(printf '%s' "$manifest_counts" | jq -r 'keys[]' 2>/dev/null); do
  total=$((total + 1))
  expected="$(printf '%s' "$manifest_counts" | jq -r --arg n "$name" '.[$n]')"
  actual="$(printf '%s' "$restored_json" | jq -r --arg n "$name" '.[$n] // "MISSING"')"
  if [ "$actual" = "MISSING" ]; then
    fail_reasons+=("$name: present in manifest ($expected docs) but missing after restore")
  elif [ "$actual" != "$expected" ]; then
    fail_reasons+=("$name: expected $expected docs, restored $actual")
  else
    pass_count=$((pass_count + 1))
    say "  ok   — $name ($actual docs)"
  fi
done

if [ "$total" -eq 0 ]; then
  say "✓ archive covers zero collections — nothing to verify, drill passes"
  write_status "PASS" "$ARCHIVE" "0 collections — empty archive"
  exit 0
fi

if [ "${#fail_reasons[@]}" -gt 0 ]; then
  for r in "${fail_reasons[@]}"; do echo "  FAIL — $r" >&2; done
  fail_drill "${#fail_reasons[@]}/$total collection(s) failed verification: ${fail_reasons[0]}"
fi

say "✓ RESTORE DRILL PASSED: $pass_count/$total collection(s) restored + count-verified from $ARCHIVE"
write_status "PASS" "$ARCHIVE" "$pass_count/$total collection(s) verified clean"
exit 0
