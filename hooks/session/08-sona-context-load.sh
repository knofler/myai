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

# One-line summary only (TOKEN task-2a431e9b). The full SONA block —
# category breakdown, learning rate, and the per-topic pattern context — is
# boot noise; `myai doctor` (or `sona_stats` directly) shows it on demand.
HIGH=$(jq '[.[] | select(.confidence >= 0.8)] | length' "$INDEX" 2>/dev/null || echo 0)

# Detected topics from recent state, kept to a compact inline list.
TAGS=""
STATE_FILE="$ROOT/state/STATE.md"
if [ -f "$STATE_FILE" ]; then
  TAGS=$(grep -iE '^\#{1,4}\s' "$STATE_FILE" 2>/dev/null | \
    tr '[:upper:]' '[:lower:]' | \
    grep -oE '(docker|vercel|mongo|api|frontend|hooks|deploy|test|git|ci|aws|azure|terraform)' | \
    sort -u | head -5 | tr '\n' ' ' | sed 's/ $//' || true)
fi

if [ -n "$TAGS" ]; then
  echo "SONA: $TOTAL patterns ($HIGH high-conf) · topics: $TAGS — 'myai doctor' for detail"
else
  echo "SONA: $TOTAL patterns ($HIGH high-conf) — 'myai doctor' for detail"
fi

exit 0
