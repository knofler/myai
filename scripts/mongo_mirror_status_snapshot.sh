#!/usr/bin/env bash
# mongo_mirror_status_snapshot.sh — bridge the mongo-mirror schedule state
# into a JSON artifact the gateway/dashboard can read (task-906c973f).
#
# WHY: the gateway runs in Docker and mounts the repo (RO at AI_ROOT); it
# cannot see $MYAI_HOME (default ~/.myai) on the host, which is where
# scripts/mongo_mirror.sh's write_last_run() records mongo-mirror.last and
# where the launchd plist / crontab line lives. Same bridge pattern as
# runner_health.sh / pool_capacity_snapshot.sh: this host-side script derives
# "is the schedule installed, and how did its last run go" — the same
# derivation `myai doctor`'s mongo-mirror-schedule check uses
# (mirrorScheduleStatus() in bin/myai.cjs) — and writes
# state/mongo-mirror-status.json INTO the repo. The gateway's
# runtime/src/monitoring/mongo-mirror-alerter.ts reads it off the mount and
# pushes Telegram/dashboard-bell when the last run failed or the schedule
# looks stale, instead of that only being visible via an on-demand doctor run.
#
# Usage:
#   ./scripts/mongo_mirror_status_snapshot.sh
#   MONGO_MIRROR_STATUS_OUT=/tmp/s.json ./scripts/mongo_mirror_status_snapshot.sh
#   MYAI_MIRROR_PLIST=/tmp/fake.plist ./scripts/mongo_mirror_status_snapshot.sh   # tests
#
# Safe to run repeatedly (idempotent — atomically rewrites the artifact).
# Never fails a caller: no schedule / no run yet → installed:false / last:null,
# not an error, exit 0.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OUT="${MONGO_MIRROR_STATUS_OUT:-$REPO_ROOT/state/mongo-mirror-status.json}"
MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
LAST_FILE="$MYAI_HOME/mongo-mirror.last"

mkdir -p "$(dirname "$OUT")"

installed=false
interval_sec=null

uname_s="$(uname -s 2>/dev/null || echo unknown)"
if [ -n "${MYAI_MIRROR_PLIST:-}" ] || [ "$uname_s" = "Darwin" ]; then
  plist="${MYAI_MIRROR_PLIST:-$HOME/Library/LaunchAgents/com.myai.mongo-mirror.plist}"
  if [ -f "$plist" ]; then
    installed=true
    interval="$(grep -A1 'StartInterval' "$plist" 2>/dev/null | grep -o '[0-9]\+' | head -1 || true)"
    [ -n "${interval:-}" ] && interval_sec="$interval"
  fi
else
  if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -q 'mongo_mirror\.sh'; then
    installed=true
  fi
fi

last_json=null
if [ -f "$LAST_FILE" ]; then
  epoch="$(sed -n 's/^epoch=//p' "$LAST_FILE" | head -1)"
  rc="$(sed -n 's/^rc=//p' "$LAST_FILE" | head -1)"
  direction="$(sed -n 's/^direction=//p' "$LAST_FILE" | head -1)"
  db="$(sed -n 's/^db=//p' "$LAST_FILE" | head -1)"
  case "$epoch" in
    ''|*[!0-9]*) ;; # unreadable — treated as no run
    *)
      case "$rc" in ''|*[!0-9]*) rc=1 ;; esac
      last_json="{\"epoch\": $epoch, \"rc\": $rc, \"direction\": \"${direction:-}\", \"db\": \"${db:-}\"}"
      ;;
  esac
fi

generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

tmp="$(mktemp "${OUT}.XXXXXX")"
cat > "$tmp" <<EOF
{
  "generatedAt": "$generated_at",
  "source": "mongo_mirror_status_snapshot.sh ($MYAI_HOME)",
  "installed": $installed,
  "intervalSec": $interval_sec,
  "last": $last_json
}
EOF
mv "$tmp" "$OUT"

echo "mongo_mirror_status: installed=$installed intervalSec=$interval_sec last=$last_json → $OUT"
