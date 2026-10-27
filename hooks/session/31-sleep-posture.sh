#!/bin/bash
set +e
# Hook: Sleep / Lock Posture
# Event: SessionStart (every `agent mode` kickoff)
#
# The operator's standing requirement: "this mac should not sleep without me
# knowing" — and, explicitly, they will not remember to check it. Enforcement is
# the root LaunchDaemon (scripts/sleep_guard.sh --install-daemon); this hook is
# the VISIBILITY half, so a drifted posture surfaces at boot instead of being
# discovered by a lost night of scheduled work.
#
# Warn-only, like every other session hook. Never blocks, never needs sudo.
# macOS only — pmset/sysadminctl do not exist elsewhere.

[ "$(uname -s)" = "Darwin" ] || exit 0

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
GUARD="$ROOT/scripts/sleep_guard.sh"
[ -x "$GUARD" ] || exit 0

LINE=$("$GUARD" --oneline 2>/dev/null)
RC=$?

if [ "$RC" = 0 ]; then
  # Healthy: one quiet line. Boot output is already crowded.
  echo "$LINE"
  exit 0
fi

# Drifted: make it impossible to miss, and say what to run.
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
echo "  $LINE"
echo ""
echo "  Either this Mac can now sleep on lid close (killing every phone"
echo "  doorway and any scheduled run), or something is blocking display"
echo "  sleep so the screen never locks. Both are silent failures."
echo ""
echo "  Full report:  ./AI/scripts/sleep_guard.sh"
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
exit 0
