#!/usr/bin/env bash
# YOLO Mode Manager — dangerously skip permission prompts
# Usage:
#   ./scripts/yolo.sh start 10       # 10 minutes
#   ./scripts/yolo.sh start god      # until plan/commit
#   ./scripts/yolo.sh status         # check current state
#   ./scripts/yolo.sh stop           # deactivate

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
YOLO_FILE="$REPO_ROOT/state/.yolo"

cmd="${1:-status}"
arg="${2:-}"

case "$cmd" in
  start)
    if [[ -z "$arg" ]]; then
      echo "Usage: yolo.sh start <minutes|god>"
      exit 1
    fi

    if [[ "$arg" == "god" ]]; then
      # 4-hour hard cap as dead-man's switch
      max_epoch=$(( $(date +%s) + 14400 ))
      max_iso=$(date -u -r "$max_epoch" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "@$max_epoch" +"%Y-%m-%dT%H:%M:%SZ")
      cat > "$YOLO_FILE" <<EOF
mode=god
started=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
expires=$max_iso
trigger=commit_or_plan_complete
EOF
      echo "YOLO GOD MODE — no questions until plan complete or next commit (4h hard cap)"
    else
      # arg is minutes
      if ! [[ "$arg" =~ ^[0-9]+$ ]]; then
        echo "Error: minutes must be a number. Got: $arg"
        exit 1
      fi
      expires_epoch=$(( $(date +%s) + (arg * 60) ))
      expires_iso=$(date -u -r "$expires_epoch" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "@$expires_epoch" +"%Y-%m-%dT%H:%M:%SZ")
      cat > "$YOLO_FILE" <<EOF
mode=timed
started=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
expires=$expires_iso
minutes=$arg
EOF
      echo "YOLO TIMED MODE — no questions for $arg minutes (expires: $expires_iso)"
    fi
    ;;

  status)
    if [[ ! -f "$YOLO_FILE" ]]; then
      echo "YOLO: inactive"
      exit 0
    fi

    mode=$(grep '^mode=' "$YOLO_FILE" | cut -d= -f2)
    started=$(grep '^started=' "$YOLO_FILE" | cut -d= -f2)

    if [[ "$mode" == "god" ]]; then
      echo "YOLO GOD MODE — active since $started (until plan complete or next commit)"
    elif [[ "$mode" == "timed" ]]; then
      expires=$(grep '^expires=' "$YOLO_FILE" | cut -d= -f2)
      minutes=$(grep '^minutes=' "$YOLO_FILE" | cut -d= -f2)
      now_epoch=$(date +%s)
      expires_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$expires" +%s 2>/dev/null || date -u -d "$expires" +%s)

      if [[ "$now_epoch" -ge "$expires_epoch" ]]; then
        echo "YOLO: expired (was $minutes min, ended $expires)"
        rm -f "$YOLO_FILE"
      else
        remaining=$(( (expires_epoch - now_epoch) / 60 ))
        echo "YOLO TIMED MODE — active, ${remaining}m remaining (expires: $expires)"
      fi
    fi
    ;;

  stop)
    if [[ -f "$YOLO_FILE" ]]; then
      rm -f "$YOLO_FILE"
      echo "YOLO: deactivated"
    else
      echo "YOLO: was not active"
    fi
    ;;

  *)
    echo "Usage: yolo.sh {start|status|stop} [minutes|god]"
    exit 1
    ;;
esac
