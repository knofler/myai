#!/bin/bash
set +e
# Hook: GATEWAY freshness — "up" must also mean "current"
# Event: SessionStart
# Policy: the running gateway equals the built source, converged automatically.
#
# WHY (2026-08-29): "rebuilt the stale gateway image" recurs through
# state/AI_AGENT_HANDOFF.md as a MANUAL step an agent spotted and fixed by hand
# — 2026-08-26 (a 7-session STALE self-heal blocker), 2026-08-27, 2026-08-28.
# Nothing compared image age to source age, so a /health 200 from a two-day-old
# image was indistinguishable from a current one: MCP tools served stale code
# while the agent trusted them. The session this hook was written, the gateway
# was serving code ~10h behind runtime/src — including distill.ts, brain.ts and
# context-bundle.ts, i.e. exactly the brain/boot path the agent relies on.
#
# Rebuilds take minutes, so this NEVER blocks a session: gateway_ensure.sh is
# called with --apply --background, which detaches the rebuild under a lock and
# logs to $MYAI_HOME/logs/gateway-rebuild.log. Boot prints one line; the next
# boot finds a fresh image. Convergence with no human and no model in the loop.
#
# TOKEN task-2a431e9b: --background only detached the REBUILD. The freshness
# SCAN itself (scan_ctx walks every file under runtime/, one stat(1) per file)
# ran inline and cost ~56s of boot wall-clock on its own — more than the whole
# 20s hook budget. So the ENTIRE gateway_ensure call is now detached into the
# background and boot prints a single line. The scan + any rebuild happen off
# the critical path; the result surfaces via `myai doctor` and the log.
#
# Set MYAI_NO_GATEWAY_REBUILD=1 to detect-and-report (still backgrounded).

if [ -f /.dockerenv ] || [ -n "$MYAI_IN_CONTAINER" ]; then
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SCRIPT="$ROOT/scripts/gateway_ensure.sh"
[ -f "$SCRIPT" ] || SCRIPT="$ROOT/AI/scripts/gateway_ensure.sh"   # managed-repo layout
[ -x "$SCRIPT" ] || exit 0

# Only the repo that OWNS the compose stack should rebuild it. A managed repo
# has no runtime/ of its own and must never try.
[ -f "$ROOT/docker-compose.yml" ] || exit 0
grep -q '^  gateway:' "$ROOT/docker-compose.yml" 2>/dev/null || exit 0

# Detach the whole scan (+ optional background rebuild) so boot never waits on
# the per-file mtime walk. Output goes to the freshness log; `myai doctor` and
# the gateway-rebuild log carry the detail.
FRESHLOG="${MYAI_HOME:-$HOME/.myai}/logs/gateway-freshness.log"
mkdir -p "$(dirname "$FRESHLOG")" 2>/dev/null
if [ -n "${MYAI_NO_GATEWAY_REBUILD:-}" ]; then
  ( "$SCRIPT" >>"$FRESHLOG" 2>&1 & ) >/dev/null 2>&1
else
  ( "$SCRIPT" --apply --background >>"$FRESHLOG" 2>&1 & ) >/dev/null 2>&1
fi
echo "gateway: freshness check dispatched (background) — 'myai doctor' / $FRESHLOG"
exit 0
