#!/bin/bash
set +e
# Hook: Machine Switch Detector
# Event: SessionStart
# On machine switch: FORCE remove all containers + images, rebuild fresh

# Skip inside a container (e.g. the gateway's own hook registry): `hostname -s`
# is the container ID, so this would always "detect" a machine switch and emit
# the destructive `docker compose down -v` banner. Host-only hook.
if [ -f /.dockerenv ] || [ -n "$MYAI_IN_CONTAINER" ]; then
  echo "01-machine-switch: skipped (inside container — host-only hook)"
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
PROJECT=$(basename "$ROOT")

# Try multiple handoff locations
HANDOFF=""
for f in "$ROOT/AI/state/AI_AGENT_HANDOFF.md" "$ROOT/state/AI_AGENT_HANDOFF.md"; do
  [ -f "$f" ] && HANDOFF="$f" && break
done

CURRENT_HOST=$(hostname -s)

if [ -z "$HANDOFF" ]; then
  exit 0
fi

LAST_MACHINE=$(grep -oE 'Last machine:[[:space:]]*[^ ]+' "$HANDOFF" 2>/dev/null | sed 's/Last machine:[[:space:]]*//')

if [ -z "$LAST_MACHINE" ]; then
  exit 0
fi

if [ "$CURRENT_HOST" != "$LAST_MACHINE" ]; then
  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "  MACHINE SWITCH: $LAST_MACHINE → $CURRENT_HOST"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo ""
  echo "  ACTION REQUIRED (agent MUST execute all steps):"
  echo ""
  echo "  1. Wait for Dropbox sync to complete"
  echo "  2. Clean conflicts: find . -name '*conflicted*' -delete"
  echo "  3. Remove ALL containers for this project:"
  echo "     docker compose down --remove-orphans -v"
  echo "  4. Remove stale images:"
  echo "     docker image prune -f"
  echo "  5. Verify docker-compose.yml container names use '${PROJECT}-' prefix"
  echo "  6. Rebuild fresh:"
  echo "     docker compose up -d --build"
  echo "  7. Verify: docker compose ps"
  echo ""
  echo "  This is MANDATORY. Do not skip any step."
  echo ""
else
  echo "Same machine ($CURRENT_HOST) — no machine switch"
fi

exit 0
