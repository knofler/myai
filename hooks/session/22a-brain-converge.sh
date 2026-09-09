#!/bin/bash
set +e
# Hook: BRAIN boot convergence — the fork killer
# Event: SessionStart
# Policy: brain is up to date BEFORE the agent reads anything. Zero model tokens.
#
# WHY (2026-08-29): brain sync was ASYMMETRIC. `brain_sync_push` is wired into
# hooks/stop/05-brain-autoatom.sh and hooks/post-tool/06-handoff-staleness.sh,
# so every machine pushes routinely and unattended — but `brain_sync_pull` was
# reachable only through brain_session_start, which interactive `agent mode` /
# `agent mode -min` never calls. Push-without-pull guarantees a fork, and the
# ff-only pull deliberately refused to merge one, so the reconcile fell to the
# MODEL: two full sessions in 24h (77f9280f, e138b210) spent re-deriving the
# same mechanical merge, each fork also breaking `-min` anchor resolution so
# boot silently degraded to the blank-agent brief.
#
# This hook closes the loop in shell. It runs BEFORE 23-brain-status.sh so the
# 🧠 banner reports a converged brain rather than warning about a fork nobody
# fixed. It is deliberately INDEPENDENT of the gateway and the myai MCP bridge
# — both were dark the session this was written, which is precisely when
# convergence matters most.
#
# Safety is brain_converge's (scripts/lib/brain.sh): backup ref before any
# merge, never reset --hard/clean/force-push, auto-resolve ONLY the regenerable
# distiller outputs, and abort + escalate LOUD on any real atom conflict.

# host-only (the brain is a host-side git repo)
if [ -f /.dockerenv ] || [ -n "$MYAI_IN_CONTAINER" ]; then
  exit 0
fi

# opt-out for CI / hermetic test runs
[ -n "${MYAI_NO_BRAIN_CONVERGE:-}" ] && exit 0

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
LIB="$ROOT/scripts/lib/brain.sh"
[ -f "$LIB" ] || LIB="$ROOT/AI/scripts/lib/brain.sh"   # managed-repo layout
[ -f "$LIB" ] || exit 0

# shellcheck disable=SC1090
. "$LIB" 2>/dev/null || exit 0
command -v brain_converge >/dev/null 2>&1 || exit 0

# Time-box the whole thing: a hung fetch must never delay a session start.
# brain_converge already bounds its own network calls, this is belt-and-braces.
if command -v timeout >/dev/null 2>&1; then
  BC() { timeout "${BRAIN_CONVERGE_TIMEOUT:-45}" bash -c '. "$1"; brain_converge' _ "$LIB"; }
else
  BC() { brain_converge; }
fi
BC
exit 0
