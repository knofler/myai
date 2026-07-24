#!/usr/bin/env bash
set +e
# Hook: HANDOFF/STATE Size Guard
# Event: SessionStart (fires for EVERY session — full `agent mode`, `agent
# mode -min`, `agent mode -resume`, or no keyword typed at all)
#
# WHY THIS EXISTS
# ---------------
# scripts/rotate_state.sh's trim logic is correct in isolation, but it was
# only ever INVOKED from markdown protocol steps: `agent mode` step 0e and
# `wrap up` step 1b. `agent mode -min` / `agent mode -resume` (the lightweight
# boot paths meant for headless/scheduled sessions) never mention it — so a
# repo that mostly boots via -min/-resume silently blows past
# HANDOFF_MAX_BYTES for weeks (observed: connect's AI_AGENT_HANDOFF.md grew
# 43KB -> 46KB -> 48KB -> 49KB -> 57KB across consecutive -min/-resume
# sessions, never a full agent-mode/wrap-up). rotate_state.sh itself is
# already idempotent and cheap (no-op when under threshold) — the fix is to
# call it from a SessionStart hook, which the harness runs unconditionally,
# so trimming no longer depends on which keyword got typed.

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
if [ -f "$ROOT/scripts/rotate_state.sh" ]; then
  SCRIPT="$ROOT/scripts/rotate_state.sh"
elif [ -f "$ROOT/AI/scripts/rotate_state.sh" ]; then
  SCRIPT="$ROOT/AI/scripts/rotate_state.sh"
else
  exit 0
fi

# `timeout`/`gtimeout` aren't guaranteed on macOS without coreutils — degrade
# to running rotate_state.sh directly rather than failing the whole guard.
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout 15"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout 15"
fi

OUT=$(cd "$ROOT" && $TIMEOUT_BIN bash "$SCRIPT" 2>&1)
RC=$?
if [ $RC -ne 0 ]; then
  echo "State Size Guard: rotate_state.sh failed (exit $RC) — check manually"
  exit 0
fi

# Keep session-start noise low: only surface output when something actually
# rotated (mirrors 13-ram-guard.sh's quiet-when-fine convention).
if echo "$OUT" | grep -qE "^(Rotating STATE\.md|HANDOFF\.md is)"; then
  echo "$OUT" | grep -E "^(Rotating STATE\.md|HANDOFF\.md is|  Rotated session|  New (STATE|HANDOFF)\.md size)"
else
  echo "State Size Guard: STATE.md + HANDOFF.md within thresholds"
fi

exit 0
