#!/bin/bash
set +e
# Hook: State Auto-Save Reminder
# Event: Stop
# Reminds to verify STATE.md is current when Claude finishes responding

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
STATE_FILE="$ROOT/state/STATE.md"

if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

# Check when STATE.md was last modified
LAST_MOD=$(stat -f "%m" "$STATE_FILE" 2>/dev/null || stat -c "%Y" "$STATE_FILE" 2>/dev/null)
NOW=$(date +%s)
DIFF=$((NOW - LAST_MOD))

# If STATE.md hasn't been updated in 30+ minutes, remind
if [ "$DIFF" -gt 1800 ]; then
  MINS=$((DIFF / 60))
  echo "REMINDER: STATE.md last updated ${MINS}m ago. Update it if significant work was done."
fi

exit 0
