#!/usr/bin/env bash
# 38-swarm-master-ensure.sh — SessionStart: the configured swarm master TAKES
# the coordinator lease itself (operator rule 2026-10-22: every device always
# has exactly one swarm master). Mechanical, not a banner: 37-arm-mail-watch
# only TOLD agents what to do and they skipped it, so on 2026-10-22 one Mac's
# master never held the lease and was deaf to the home Mac's mail.
#
#   • no master configured on this device → one RED line (fix: myai swarm
#     master set), printed only in sessions of the swarm repo.
#   • this session IS the configured master (lane = session_profile, repo =
#     the config's repo; scripts/lib/swarm_master_config.sh) and does not hold
#     swarm-coordinator:<host> yet → `swarm_master.sh take --force`, which
#     writes the lease + the active marker and mails the other lanes.
#     It then tells EVERY other live session on this Mac (all repos) who the
#     master is and where to report (sm_announce) — once per session pid and
#     epoch, so a compaction/resume SessionStart never re-mails (2026-10-26).
#   • any other session, while a valid lease exists → one line naming the
#     master and its address, so a session started after the announcement
#     still knows where to report; no lease → silent.
#
# Skipped in runner fires and per-task workspaces (ci-workspaces, git and lane
# worktrees — workers, never the master). Best-effort, always exit 0; the
# gateway calls are bounded (KL_TIMEOUT).
set +e

[ "${MYAI_RUNNER_FIRE:-0}" = 1 ] && exit 0
[ "${SWARM_MASTER_ENSURE:-1}" = 0 ] && exit 0

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$ROOT" ] && ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." 2>/dev/null && pwd)"
[ -z "$ROOT" ] && exit 0
WS_ROOT="${CI_WORKSPACES:-$HOME/ci-workspaces}"
case "$ROOT" in
  "$WS_ROOT"/*|*"/.worktrees/"*|"${LANE_WT_ROOT:-$HOME/.myai/worktrees}"/*) exit 0 ;;
esac

SM=""
for cand in "$ROOT/scripts/swarm_master.sh" "$ROOT/AI/scripts/swarm_master.sh"; do
  [ -f "$cand" ] && { SM="$cand"; break; }
done
[ -n "$SM" ] || exit 0

export KL_TIMEOUT="${KL_TIMEOUT:-4}"
# shellcheck source=/dev/null
SWARM_MASTER_LIB_ONLY=1 . "$SM" 2>/dev/null || exit 0

if [ -n "${NO_COLOR:-}" ]; then B='' R='' RED='' G=''
else B=$'\033[1m'; R=$'\033[0m'; RED=$'\033[1;31m'; G=$'\033[1;32m'; fi

if ! smc_exists; then
  if [ "$(_lanes_repo_of "$ROOT" 2>/dev/null)" = "$(session_master_repo)" ]; then
    printf '%s\n' "${RED}SWARM MASTER: none configured on $(smc_host)${R} — every device needs exactly one. Fix: ${B}myai swarm master set${R} (or bash $(dirname "$SM")/swarm_master_set.sh)"
  fi
  exit 0
fi

# _announce_once <epoch> — sm_announce unless this session already did for it.
_announce_once() {
  local stamp
  stamp="$SWARM_DIR/announced.$(sm_host).$(sm_pid).$1"
  [ -f "$stamp" ] && return 0
  sm_announce "$1"
  mkdir -p "$SWARM_DIR" 2>/dev/null; : > "$stamp" 2>/dev/null
  return 0
}

if ! smc_is_master_session "$(sm_lane)" "$(_lanes_repo_of "$ROOT" 2>/dev/null)"; then
  if sm_read_lease && [ "$L_PRESENT" = yes ] && [ "$L_STALE" = false ] && [ -n "$L_HOLDER" ]; then
    _h="${L_HOLDER%%/*}"; _l="$(printf '%s' "$L_HOLDER" | cut -d/ -f2)"
    printf '%s\n' "${G}SWARM MASTER${R}: ${B}$_l${R} ($_h) is the swarm master — send reports, blockers and merge-go to $_h/$_l (alias $_h/coordinator), never to another worker"
  fi
  exit 0
fi
[ -n "$(sm_pid)" ] || exit 0

if sm_read_lease && [ "$L_PRESENT" = yes ] && [ "$L_STALE" = false ] && [ "$L_HOLDER" = "$(sm_holder)" ]; then
  printf '%s\n' "${G}SWARM MASTER${R}: this session ($(sm_holder)) already holds $(sm_key)"
  _announce_once "${L_EPOCH:-1}"
  exit 0
fi

OUT="$(sm_take --force 2>&1)"; RC=$?
if [ "$RC" = 0 ]; then
  # sm_take already announced; stamp it so a later SessionStart doesn't repeat.
  mkdir -p "$SWARM_DIR" 2>/dev/null; : > "$SWARM_DIR/announced.$(sm_host).$(sm_pid).$(sm_state_get epoch)" 2>/dev/null
  printf '%s\n' "${G}SWARM MASTER${R}: you are this device's configured master — took $(sm_key) yourself"
  printf '%s\n' "$OUT" | sed 's/^/  /'
  printf '  %s\n' "Arm the mail watcher now: bash $(dirname "$SM")/mail_watch.sh (run_in_background) — the PreToolUse hook repeats this until it runs."
else
  printf '%s\n' "${RED}SWARM MASTER: could not take $(sm_key)${R} (rc $RC):"
  printf '%s\n' "$OUT" | sed 's/^/  /'
fi
exit 0
