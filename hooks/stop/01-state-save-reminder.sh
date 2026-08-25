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
# GNU-first (AI_RULES §4): on Linux, BSD-style `stat -f "%m"` is `--file-system`
# (a boolean flag), so it succeeds and prints a mount-point line instead of
# failing over — the BSD form must never run first in a `||` chain.
LAST_MOD=$(stat -c "%Y" "$STATE_FILE" 2>/dev/null || stat -f "%m" "$STATE_FILE" 2>/dev/null)
NOW=$(date +%s)
DIFF=$((NOW - LAST_MOD))

# If STATE.md hasn't been updated in 30+ minutes, remind
if [ "$DIFF" -gt 1800 ]; then
  MINS=$((DIFF / 60))
  echo "REMINDER: STATE.md last updated ${MINS}m ago. Update it if significant work was done."
fi

exit 0
