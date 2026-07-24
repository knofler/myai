#!/usr/bin/env bash
set +e

# Find repo root (works from both master repo and managed projects with AI/ subfolder)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$SCRIPT_DIR/../../state/.yolo" ]]; then
  YOLO_FILE="$SCRIPT_DIR/../../state/.yolo"
elif [[ -f "$SCRIPT_DIR/../../AI/state/.yolo" ]]; then
  YOLO_FILE="$SCRIPT_DIR/../../AI/state/.yolo"
else
  # No yolo file — silent exit
  exit 0
fi

mode=$(grep '^mode=' "$YOLO_FILE" 2>/dev/null | cut -d= -f2)
started=$(grep '^started=' "$YOLO_FILE" 2>/dev/null | cut -d= -f2)

if [[ "$mode" == "god" ]]; then
  expires=$(grep '^expires=' "$YOLO_FILE" 2>/dev/null | cut -d= -f2)
  if [[ -n "$expires" && "$expires" != "never" ]]; then
    now_epoch=$(date +%s)
    # macOS date -j fallback to GNU date -d, then 0 if both fail (expires immediately)
    expires_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$expires" +%s 2>/dev/null || date -u -d "$expires" +%s 2>/dev/null || echo 0)
    if [[ "$now_epoch" -ge "$expires_epoch" ]]; then
      rm -f "$YOLO_FILE"
      echo "YOLO GOD MODE: expired (4h hard cap) — removed, back to normal mode"
      exit 0
    fi
    remaining=$(( (expires_epoch - now_epoch) / 60 ))
    echo "YOLO GOD MODE active since $started (${remaining}m remaining, or until commit/plan)"
  else
    echo "YOLO GOD MODE active since $started (until plan complete or next commit)"
  fi
elif [[ "$mode" == "timed" ]]; then
  expires=$(grep '^expires=' "$YOLO_FILE" 2>/dev/null | cut -d= -f2)
  minutes=$(grep '^minutes=' "$YOLO_FILE" 2>/dev/null | cut -d= -f2)
  now_epoch=$(date +%s)
  expires_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$expires" +%s 2>/dev/null || date -u -d "$expires" +%s 2>/dev/null || echo 0)

  if [[ "$now_epoch" -ge "$expires_epoch" ]]; then
    rm -f "$YOLO_FILE"
    echo "YOLO: expired (was ${minutes}m) — removed, back to normal mode"
  else
    remaining=$(( (expires_epoch - now_epoch) / 60 ))
    echo "YOLO TIMED MODE active — ${remaining}m remaining"
  fi
fi

exit 0
