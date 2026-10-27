#!/bin/bash
set +e
# Hook: LOCAL STACK verify — "up" must also mean "current", proven BY CONTENT.
# Event: SessionStart
#
# WHY (2026-09-14): hook 28 (gateway-freshness) proves freshness by comparing
# an image's creation time against source mtimes. Two live incidents show
# mtime alone lies in both directions — the gateway's compiled user-auth.js
# was stamped BEFORE the merge that changed it while its content was correct,
# and (found live while building this hook) myai-gateway's image here was
# created AFTER runtime/src/core/user-auth.ts's last commit yet still runs
# pre-fix code. And a 2026-09-14 dashboard rebuild was PARTIAL — one route's
# fix landed, another commit silently didn't — which no single spot-check
# would have caught. scripts/verify_local_stack.sh greps the BUILT ARTIFACT
# inside each container for a literal that survives minification (a data
# property, never a function/variable identifier — those get renamed). This
# hook runs it at boot and says plainly, per service, FRESH or STALE.
#
# Fast by construction (a handful of `docker exec grep`, not a source-tree
# walk), so unlike hook 28's mtime scan this runs INLINE, not backgrounded.
#
# This hook never rebuilds anything — report only. Read-only checks
# (docker inspect / docker exec grep) are always safe to run, including from
# a workspace clone that must never `docker compose build/up` the shared
# myai stack itself (DEPLOY GUARD).

if [ -f /.dockerenv ] || [ -n "$MYAI_IN_CONTAINER" ]; then
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SCRIPT="$ROOT/scripts/verify_local_stack.sh"
[ -f "$SCRIPT" ] || SCRIPT="$ROOT/AI/scripts/verify_local_stack.sh"   # managed-repo layout
[ -x "$SCRIPT" ] || exit 0

# Only the repo that OWNS the compose stack has containers worth checking.
[ -f "$ROOT/docker-compose.yml" ] || exit 0
grep -q '^  gateway:' "$ROOT/docker-compose.yml" 2>/dev/null || exit 0

# Docker daemon down is already reported loudly by hook 03 — stay quiet here
# rather than duplicate it (verify_local_stack.sh exits 4 for this case).
OUT=$("$SCRIPT" --quiet 2>/dev/null)
RC=$?
[ "$RC" -eq 4 ] && exit 0

if [ "$RC" -eq 0 ]; then
  echo "local stack: FRESH — running containers match HEAD by content"
  printf '%s\n' "$OUT" | sed 's/^/  /'
else
  if [ -n "$NO_COLOR" ]; then RED=''; RESET=''; BOLD=''
  else RED=$'\033[1;31m'; RESET=$'\033[0m'; BOLD=$'\033[1m'; fi
  {
    echo "${RED}${BOLD}local stack: STALE — a running container does not match HEAD (by content, not mtime)${RESET}"
    printf '%s\n' "$OUT" | sed 's/^/  /'
    echo "  Rebuild from the OWNING checkout (never from a workspace clone): docker compose build <service> && docker compose up -d <service>"
    echo "  Re-verify: ./scripts/verify_local_stack.sh"
  } >&2
fi
exit 0
