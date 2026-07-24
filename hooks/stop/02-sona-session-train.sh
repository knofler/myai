#!/bin/bash
set +e
# Hook: SONA Session Training
# Event: Stop
# Reminds the agent to extract patterns from completed work

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SONA_INDEX="$ROOT/memory/patterns/index.json"

if [ ! -f "$SONA_INDEX" ]; then
  exit 0
fi

TOTAL=$(jq 'length' "$SONA_INDEX" 2>/dev/null || echo 0)

# Only remind if patterns exist (system is active)
if [ "$TOTAL" -gt 0 ]; then
  echo "SONA: $TOTAL patterns in store. If you completed significant work this session:"
  echo "  - Extract new patterns: source memory/lib/sona.sh && sona_extract_pattern '<json>'"
  echo "  - Score reused patterns: source memory/lib/sona.sh && sona_score_pattern <id> success|failure"
  echo "  - Run session training: /neural-session-train"
fi

exit 0
