#!/usr/bin/env bash
# swarm-worker-role.sh — SessionStart + UserPromptSubmit, WARN-ONLY: while a
# swarm runs on this host, every session that is NOT the swarm master is told
# it is a WORKER that never tasks the operator (operator rule 2026-10-22,
# brain atom 9e22a437): questions, blockers, offers and next steps go to the
# master by mail (kind=request), results by kind=result; only the master talks
# to the operator.
#
#   SessionStart      → always injects the rule (additionalContext).
#   UserPromptSubmit  → re-injects it at most once per SWARM_WORKER_REMIND_EVERY
#                       seconds (default 1800) per session, so it survives
#                       context compaction.
#
# Silent (and never blocks) when: no active marker (no swarm — e.g. a worktree
# session with no swarm running), a runner fire, SWARM_WORKER_ROLE=0, or THIS
# session is the master (scripts/lib/swarm_master_config.sh smc_worker_reminder).
# Always exit 0.
set +e

[ "${SWARM_WORKER_ROLE:-1}" = 0 ] && exit 0
[ "${MYAI_RUNNER_FIRE:-0}" = 1 ] && exit 0

INPUT="$(cat 2>/dev/null)"
EVENT="${1:-}"
if [ -z "$EVENT" ]; then
  case "$INPUT" in
    *'"hook_event_name":"SessionStart"'*|*'"hook_event_name": "SessionStart"'*) EVENT=SessionStart ;;
    *) EVENT=UserPromptSubmit ;;
  esac
fi

HOST="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
SDIR="${SWARM_DIR:-$HOME/.myai/swarm}"
# Cheap exit before sourcing anything: no swarm on this host.
[ -f "$SDIR/active.$HOST" ] || exit 0

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)"
LIB=""
for cand in "$HERE/scripts/lib" "$(git rev-parse --show-toplevel 2>/dev/null)/scripts/lib" "$(git rev-parse --show-toplevel 2>/dev/null)/AI/scripts/lib"; do
  [ -f "$cand/swarm_master_config.sh" ] && { LIB="$cand"; break; }
done
[ -n "$LIB" ] || exit 0
# shellcheck source=/dev/null
. "$LIB/session_registry.sh" 2>/dev/null
# shellcheck source=/dev/null
. "$LIB/session_lanes.sh" 2>/dev/null
# shellcheck source=/dev/null
. "$LIB/swarm_master_config.sh" 2>/dev/null

MSG="$(smc_worker_reminder)" || exit 0
[ -n "$MSG" ] || exit 0

PID="$(_lanes_self_pid 2>/dev/null)"
STAMP="$SDIR/worker-reminded.$HOST.${PID:-nopid}"
NOW="$(date +%s)"
if [ "$EVENT" != SessionStart ]; then
  LAST="$(cat "$STAMP" 2>/dev/null)"
  case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac
  [ $((NOW - LAST)) -lt "${SWARM_WORKER_REMIND_EVERY:-1800}" ] && exit 0
fi
printf '%s\n' "$NOW" > "$STAMP" 2>/dev/null

EVENT="$EVENT" MSG="$MSG" /usr/bin/python3 -c 'import json, os; print(json.dumps({"hookSpecificOutput": {"hookEventName": os.environ["EVENT"], "additionalContext": "SWARM ROLE — " + os.environ["MSG"]}}, ensure_ascii=False))' 2>/dev/null
exit 0
