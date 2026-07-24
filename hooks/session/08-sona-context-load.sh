#!/bin/bash
set +e
# Hook: SONA Context Load
# Event: SessionStart
# Loads relevant patterns from the SONA memory store on session start

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SONA_LIB="$ROOT/memory/lib/sona.sh"

if [ ! -f "$SONA_LIB" ]; then
  exit 0
fi

# Source the SONA library
source "$SONA_LIB"

# Get pattern stats
INDEX="$ROOT/memory/patterns/index.json"
if [ ! -f "$INDEX" ]; then
  echo "SONA: No pattern index — skipping context load"
  exit 0
fi

TOTAL=$(jq 'length' "$INDEX" 2>/dev/null || echo 0)

if [ "$TOTAL" -eq 0 ]; then
  echo "SONA: Pattern store empty — no context to load"
  exit 0
fi

# Show stats
sona_stats

# Load context for common task types based on recent state
STATE_FILE="$ROOT/state/STATE.md"
if [ -f "$STATE_FILE" ]; then
  # Extract likely tags from state file headings and recent work
  TAGS=$(grep -iE '^\#{1,4}\s' "$STATE_FILE" 2>/dev/null | \
    tr '[:upper:]' '[:lower:]' | \
    grep -oE '(docker|vercel|mongo|api|frontend|hooks|deploy|test|git|ci|aws|azure|terraform)' | \
    sort -u | head -5 || true)

  if [ -n "$TAGS" ]; then
    TAG_ARRAY=($TAGS)
    echo ""
    echo "Loading context for detected topics: ${TAG_ARRAY[*]}"
    sona_context_for_task "${TAG_ARRAY[@]}"
  fi
fi

exit 0
