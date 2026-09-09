#!/bin/bash
set +e
# 09a-boot-sync.sh — run scripts/boot_sync.sh at session start so the BRAIN and
# the GATEWAY are actually current before any other hook reports on them.
#
# Operator directive 2026-08-28: "always make sure both machines in sync,
# through Dropbox, brain and git … gateway must remain up to date always at any
# cost and synced."
#
# ORDERING MATTERS, hence 09a. This must run BEFORE the hooks that merely
# REPORT on the same two pillars:
#   18-machine-selfheal   (warns 🟠/🔴/⛔ that the gateway image is stale)
#   23-brain-status       (prints the brain line + health score)
#   25-boot-selfcheck     (prints `boot: … brain N BEHIND …`)
# Run after them and the session would print a scary "brain 181 BEHIND" banner
# and only then quietly fix it — which is how the operator ends up distrusting
# the banner. Run first and those three report the reconciled truth.
#
# It runs after 03-docker-health so the engine is known-up before a rebuild is
# attempted.
#
# Contract: boot_sync.sh is silent when both pillars are already current, so on
# a healthy machine this hook adds nothing to the boot output. It speaks only
# when it changed something (a fast-forward, a reconcile, a rebuild) or when it
# genuinely needs the operator. It never blocks the session — a non-zero exit
# from boot_sync is surfaced as text, not propagated.
#
# Host-only, like its siblings: a container guest has neither the Dropbox fleet
# nor the Docker socket that owns the gateway stack.
if [ -f /.dockerenv ] || [ -n "$MYAI_IN_CONTAINER" ]; then
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$ROOT" ] && ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." 2>/dev/null && pwd)"
if [ -z "$ROOT" ]; then
    # Real precondition failure (both git rev-parse and the $0-relative
    # fallback failed to resolve a root) — same incident class as
    # hooks/session/17-schedule-status.sh. Warn instead of vanishing silently,
    # since this hook is supposed to run BEFORE the brain/gateway status
    # hooks so they report reconciled truth.
    echo "09a-boot-sync: cannot resolve repo (not a git repository) — boot sync skipped" >&2
    exit 0
fi

SCRIPT="$ROOT/scripts/boot_sync.sh"
[ -f "$SCRIPT" ] || exit 0

# Opt-out for a machine that deliberately wants a frozen gateway/brain.
if [ "$MYAI_BOOT_SYNC" = "0" ]; then
  exit 0
fi

OUTPUT="$(bash "$SCRIPT" 2>&1)"
[ -n "$OUTPUT" ] && printf 'BOOT SYNC\n%s\n' "$OUTPUT"

exit 0
