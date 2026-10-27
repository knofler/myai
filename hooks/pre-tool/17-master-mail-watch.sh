#!/usr/bin/env bash
# 17-master-mail-watch.sh — PreToolUse, WARN-ONLY: the configured swarm master
# must run its own mail watcher (operator rule 2026-10-22). Until a
# scripts/mail_watch.sh process descends from THIS session, every tool call
# gets a MANDATORY "arm the watcher now (run_in_background)" message injected
# as additional context. Never blocks: always exit 0.
#
# Cheap on the hot path: no config / not the master lane → exit before any
# process scan; a found watcher is cached for SWARM_WATCH_RECHECK seconds
# (default 60) per session pid. The arming call itself (a Bash command running
# mail_watch.sh) is not nagged. Runner fires and SWARM_MASTER_ENSURE=0 skip it.
set +e

[ "${MYAI_RUNNER_FIRE:-0}" = 1 ] && exit 0
[ "${SWARM_MASTER_ENSURE:-1}" = 0 ] && exit 0

INPUT="$(cat 2>/dev/null)"
HOST="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
SDIR="${SWARM_DIR:-$HOME/.myai/swarm}"
CONF="$SDIR/master.$HOST"
[ -s "$CONF" ] || exit 0

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." 2>/dev/null && pwd)"
LIB=""
for cand in "$HERE/scripts/lib" "$(git rev-parse --show-toplevel 2>/dev/null)/scripts/lib"; do
  [ -f "$cand/swarm_master_config.sh" ] && { LIB="$cand"; break; }
done
[ -n "$LIB" ] || exit 0
# shellcheck source=/dev/null
. "$LIB/session_registry.sh" 2>/dev/null
# shellcheck source=/dev/null
. "$LIB/session_lanes.sh" 2>/dev/null
# shellcheck source=/dev/null
. "$LIB/swarm_master_config.sh" 2>/dev/null

[ "$(session_profile)" = "$(smc_master_lane)" ] || exit 0
smc_is_master_session || exit 0
PID="$(_lanes_self_pid)"
[ -n "$PID" ] || exit 0

CACHE="$SDIR/watcher-ok.$HOST.$PID"
NOW="$(date +%s)"
LAST="$(cat "$CACHE" 2>/dev/null)"
case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac
[ $((NOW - LAST)) -lt "${SWARM_WATCH_RECHECK:-60}" ] && exit 0

# The call that arms the watcher is not nagged.
case "$INPUT" in *mail_watch.sh*) exit 0 ;; esac

if lanes_has_watcher "$PID"; then
  printf '%s\n' "$NOW" > "$CACHE" 2>/dev/null
  exit 0
fi

WATCH="$(cd "$LIB/.." && pwd)/mail_watch.sh"
MSG="MANDATORY — you are this device's swarm master ($(smc_master_agent), lane $(smc_master_lane)) and NO mail watcher runs under this session, so you are deaf while idle. Arm it now: run \`bash $WATCH\` with run_in_background (timeout 2h), and re-arm it every time it exits. This message repeats on every tool call until the watcher is live (warn-only, never blocks)."
echo "⚠ $MSG" >&2
MSG="$MSG" /usr/bin/python3 -c 'import json, os; m = "⚠ " + os.environ["MSG"]; print(json.dumps({"systemMessage": m, "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": m}}, ensure_ascii=False))' 2>/dev/null
exit 0
