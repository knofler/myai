#!/usr/bin/env bash
set +e
# Hook: Usage Guard — Initialize session metrics
# Event: SessionStart
# Creates state/.session-metrics with start time, zero counters, config values
# Tracks session capacity to trigger proactive wrap-up before hitting API limits

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Find state dir (master repo: state/, managed project: AI/state/)
STATE_DIR=""
if [[ -d "$ROOT/state" ]]; then
  STATE_DIR="$ROOT/state"
elif [[ -d "$ROOT/AI/state" ]]; then
  STATE_DIR="$ROOT/AI/state"
else
  exit 0
fi

METRICS_FILE="$STATE_DIR/.session-metrics"

# Find config (master repo: config/, managed project: AI/config/)
CONFIG_FILE=""
if [[ -f "$ROOT/config/session-limits.json" ]]; then
  CONFIG_FILE="$ROOT/config/session-limits.json"
elif [[ -f "$ROOT/AI/config/session-limits.json" ]]; then
  CONFIG_FILE="$ROOT/AI/config/session-limits.json"
fi

# Read configured limits (defaults if no config or no jq)
DURATION=240
MAX_ACTIONS=300
if [[ -n "$CONFIG_FILE" ]] && command -v jq &>/dev/null; then
  DURATION=$(jq -r '.session_duration_minutes // 240' "$CONFIG_FILE")
  MAX_ACTIONS=$(jq -r '.max_weighted_actions // 300' "$CONFIG_FILE")
fi

NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
NOW_EPOCH=$(date +%s)
EXPIRES_EPOCH=$(( NOW_EPOCH + (DURATION * 60) ))

# macOS date -r vs Linux date -d
EXPIRES_ISO=$(date -u -r "$EXPIRES_EPOCH" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "@$EXPIRES_EPOCH" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")

cat > "$METRICS_FILE" <<EOF
started=$NOW_ISO
started_epoch=$NOW_EPOCH
expires=$EXPIRES_ISO
expires_epoch=$EXPIRES_EPOCH
duration_minutes=$DURATION
max_weighted_actions=$MAX_ACTIONS
action_count=0
weighted_actions=0.0
warnings_sent=
EOF

echo "Usage Guard: active — ${DURATION}m session budget, ${MAX_ACTIONS} action budget"

exit 0
