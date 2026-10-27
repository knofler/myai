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

# host-only (the brain is a host-side git repo). MYAI_BOOT_SYNC_ALLOW_CONTAINER
# is the same test-only override scripts/boot_sync.sh documents and
# test_boot_sync.sh uses — test_boot_sync_resolve.sh needs this hook to
# actually run (against a throwaway brain + MYAI_BOOT_SYNC_STATE_DIR) inside a
# containerized CI runner to exercise the RESOLVED handoff end-to-end.
if { [ -f /.dockerenv ] || [ -n "$MYAI_IN_CONTAINER" ]; } && [ -z "${MYAI_BOOT_SYNC_ALLOW_CONTAINER:-}" ]; then
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

# 09a-boot-sync (scripts/boot_sync.sh) runs before this hook and already tries
# to push an ahead-only brain, retrying once on failure. If that retry STILL
# fails it drops "BOOT SYNC — needs operator" and leaves a marker at
# state/.brain-push-needs-operator. brain_converge below re-tries the very
# same push (it never knows the first attempt happened) and, on a transient
# blip, often succeeds — which used to surface as a second, silently
# contradictory "brain: converged -N (pushed)" line with no acknowledgement
# of the earlier alarm. When the marker is present and this run's push
# succeeds, say so explicitly instead of leaving two disagreeing verdicts.
MARKER="${MYAI_BOOT_SYNC_STATE_DIR:-$ROOT/state}/.brain-push-needs-operator"
OUT="$(BC 2>&1)"
if [ -n "$OUT" ]; then
  printf '%s\n' "$OUT"
fi
if [ -f "$MARKER" ] && printf '%s' "$OUT" | grep -qE 'brain: converged (-[0-9]+ \(pushed\)|\(clean auto-merge|\(auto-resolved)'; then
  echo "RESOLVED: brain pushed — an earlier push attempt this boot failed and needed the operator; brain is now pushed and up to date with origin/main."
  rm -f "$MARKER" 2>/dev/null
fi
exit 0
