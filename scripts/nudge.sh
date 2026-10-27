#!/usr/bin/env bash
# nudge.sh — the `nudge <target> <message>` keyword: say something to a live
# session and make it act on it NOW.
#
#   1. durable: the message is mailed (tell.sh) — it can never be lost;
#   2. live:    the message is TYPED into the session and submitted —
#               tmux pane → send-keys; iTerm tab → AppleScript write text
#               (+ a separate empty write to submit, see session_lanes.sh);
#   3. proof:   the screen is re-read afterwards (busy marker / text visible).
#
# Refuses to type into a BUSY session (it would queue mid-turn) unless --force:
# the mail still lands and the session's mail-live hook surfaces it at its next
# tool call. Terminal.app / unknown terminals are reported not-reachable live.
# Never types into the session that runs it.
#
# Usage: nudge.sh <target> [--repo R] [--pid P] [--force] <message...>
#   <target>  <lane> (a ~/.claude-<x> profile, agy) | <repo> | <session label>
# Spec: plan/SESSION_TAKEOVER_SPEC.md. bash 3.2-safe; runs under set -euo pipefail.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib/session_registry.sh"
# shellcheck source=/dev/null
. "$HERE/lib/session_lanes.sh"
# shellcheck source=/dev/null
TELL_LIB_ONLY=1 . "$HERE/tell.sh"
# shellcheck source=/dev/null
SESSION_PING_LIB_ONLY=1 . "$HERE/session_ping.sh"

NUDGE_VERIFY_WAIT="${NUDGE_VERIFY_WAIT:-3}"

main() {
  local target="" repo="" pid="" force=0 msg="" rc=0 host addr out mid screen verdict typed trc
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) repo="${2:?--repo needs a value}"; shift 2 ;;
      --pid) pid="${2:?--pid needs a value}"; shift 2 ;;
      --force) force=1; shift ;;
      -h|--help) sed -n '2,20p' "$0"; return 0 ;;
      *) if [ -z "$target" ]; then target="$1"; else msg="${msg:+$msg }$1"; fi; shift ;;
    esac
  done
  if [ -z "$target" ] || [ -z "$msg" ]; then sed -n '2,20p' "$0" >&2; return 2; fi

  lanes_resolve "$target" "$repo" "$pid" || { rc=$?; return "$rc"; }
  if lanes_is_self; then
    echo "nudge: '$target' resolves to this very session (pid $LANE_PID) — not typing into myself" >&2
    return 2
  fi

  # 1. durable mail — the lane's own address, else the session's host/repo.
  host="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  # default/qwen sessions have no lane mailbox; every other lane label does.
  case "$LANE_NAME" in
    default|qwen) addr="$host/$LANE_REPO" ;;
    *) if session_is_profile_label "$LANE_NAME"; then addr="$host/$LANE_NAME"; else addr="$host/$LANE_REPO"; fi ;;
  esac
  out="$(TELL_NO_PING=1 tell "$addr" "$msg" 2>&1)" || { echo "$out" >&2; echo "nudge: mail failed — not typing either" >&2; return 1; }
  printf '%s\n' "$out"
  mid="$(printf '%s' "$out" | grep -oE 'mail-[0-9a-f-]+' | head -1 || true)"

  # 2. live — only into an idle tmux/iTerm session (or --force).
  case "$LANE_KIND" in
    tmux|iterm) ;;
    *) echo "nudge: $LANE_NAME pid $LANE_PID runs in a ${LANE_KIND} terminal — not live-reachable; the mail waits for its next prompt."; return 0 ;;
  esac
  screen="$(lanes_screen 30 2>/dev/null || true)"
  verdict="$(lanes_state "$screen")"   # record status + screen footer
  if [ "$verdict" = busy ] && [ "$force" != 1 ]; then
    echo "nudge: $LANE_NAME ($LANE_REPO, pid $LANE_PID) is BUSY — not typing (it would queue mid-turn). The mail${mid:+ $mid} is delivered; its mail-live hook shows it at the next tool call. --force types anyway."
    return 0
  fi
  typed="(nudge from $(_tell_own_address)${mid:+, $mid}) $msg"
  trc=0; lanes_type "$typed" || trc=$?
  if [ "$trc" = 5 ]; then
    _tell_alert_stranded "$LANE_NAME" "$mid"
    echo "nudge: STRANDED — the message is still in $LANE_NAME's input box after a retry (it now looks busy); coordinator alerted. check $target" >&2
    return 5
  fi
  if [ "$trc" != 0 ]; then
    echo "nudge: typing into $LANE_KIND ${LANE_TMUX:-$LANE_TTY} failed — the mail${mid:+ $mid} still waits" >&2
    return 1
  fi
  echo "nudge: typed into $LANE_NAME ($LANE_REPO, pid $LANE_PID, $LANE_KIND ${LANE_TMUX:-${LANE_TTY#/dev/}})"

  # 3. proof — re-read the screen.
  _lanes_sleep "$NUDGE_VERIFY_WAIT"
  screen="$(lanes_screen 30 2>/dev/null || true)"
  case "$screen" in
    *"esc to interrupt"*|*"esc to cancel"*) echo "nudge: verified — the session is working on it" ;;
    *"${msg:0:40}"*) echo "nudge: verified — the message is on its screen (not working yet)" ;;
    *) echo "nudge: typed, but not visible on screen yet — check $target to follow up" ;;
  esac
}

# NUDGE_LIB_ONLY=1: load the functions only (hermetic suites stub the OS calls).
[ -n "${NUDGE_LIB_ONLY:-}" ] || main "$@"
