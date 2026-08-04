#!/usr/bin/env bash
# docker_vm_disk_snapshot.sh — bridge Docker VM disk usage into a JSON
# artifact the gateway/dashboard can read (documentation/RUNBOOK.md #1).
#
# WHY: RUNBOOK.md #1 documents "Docker VM disk 100% full -> local mongo
# WT_PANIC crash-loop" (real incident: 19 Jul 2026, 3,141 restarts before it
# was caught) as a manual-only verify/fix/confirm recipe an operator runs BY
# HAND after mongo has already crash-looped. Unlike the 2GB RAM-ceiling guard
# (hooks/session/13-ram-guard.sh), there was no proactive check. This script
# is that check's producer half: it runs the runbook's own read-only Verify
# step (`docker run --rm alpine df -P /` — the disk INSIDE the Docker VM,
# not the host's `df -h /`, which is a separate filesystem) and writes
# state/docker-vm-disk-status.json. The gateway's
# runtime/src/monitoring/docker-vm-disk-alerter.ts reads it off the repo
# mount and pushes Telegram/dashboard-bell when usage crosses a threshold —
# same bridge pattern as pool_capacity_snapshot.sh / mongo_mirror_status_snapshot.sh
# (the gateway runs in Docker and cannot exec `docker run` against the host
# Docker VM itself, so the host-side snapshot is the only way in).
#
# Usage:
#   ./scripts/docker_vm_disk_snapshot.sh
#   DOCKER_VM_DISK_STATUS_OUT=/tmp/s.json ./scripts/docker_vm_disk_snapshot.sh
#
# Safe to run repeatedly (idempotent — atomically rewrites the artifact).
# Never fails a caller: Docker unavailable -> available:false, not an error,
# exit 0 (same contract as mongo_mirror_status_snapshot.sh).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OUT="${DOCKER_VM_DISK_STATUS_OUT:-$REPO_ROOT/state/docker-vm-disk-status.json}"

mkdir -p "$(dirname "$OUT")"

generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

available=false
pct_used=null
used_kb=null
total_kb=null
avail_kb=null

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  # Verify step straight from RUNBOOK.md #1: disk INSIDE the Docker VM, not
  # the host's `df -h /` (a separate filesystem on Docker Desktop).
  DF_LINE="$(docker run --rm alpine df -P / 2>/dev/null | tail -1)"
  if [ -n "$DF_LINE" ]; then
    # POSIX `df -P` columns: Filesystem 1024-blocks Used Available Capacity Mounted-on
    total_kb="$(echo "$DF_LINE" | awk '{print $2}')"
    used_kb="$(echo "$DF_LINE" | awk '{print $3}')"
    avail_kb="$(echo "$DF_LINE" | awk '{print $4}')"
    pct_raw="$(echo "$DF_LINE" | awk '{print $5}' | tr -d '%')"
    case "$total_kb" in ''|*[!0-9]*) total_kb=null ;; esac
    case "$used_kb" in ''|*[!0-9]*) used_kb=null ;; esac
    case "$avail_kb" in ''|*[!0-9]*) avail_kb=null ;; esac
    case "$pct_raw" in
      ''|*[!0-9]*) pct_used=null ;;
      *) pct_used="$pct_raw"; available=true ;;
    esac
  fi
fi

tmp="$(mktemp "${OUT}.XXXXXX")"
cat > "$tmp" <<EOF
{
  "generatedAt": "$generated_at",
  "source": "docker_vm_disk_snapshot.sh (docker run --rm alpine df -P /)",
  "available": $available,
  "pctUsed": $pct_used,
  "usedKb": $used_kb,
  "totalKb": $total_kb,
  "availableKb": $avail_kb
}
EOF
mv "$tmp" "$OUT"

echo "docker_vm_disk: available=$available pctUsed=$pct_used → $OUT"
