#!/usr/bin/env bash
# session_ping.sh <label> [mail-id] — LIVE-wake an idle peer session.
#
# An idle claude session runs no hooks, so the mail-live hook (hooks/mail-live.sh)
# can't fire there until the operator next types something. This pokes it NOW:
# it resolves <label> to a tmux pane via the live-session registry
# (scripts/lib/session_registry.sh) and does
#
#     tmux send-keys -t <session> "check mail <id>" Enter
#
# which drops "check mail <id>" into the pane as if typed — the woken session
# reads that mail and acts. `tell` (scripts/tell.sh) calls this right after
# mail_send so the durable message AND the live poke travel together.
#
# NON-TMUX sessions (2026-10-03): a lane session in an iTerm tab is reached via
# AppleScript (session_lanes.sh) when idle. Before that: a session NOT inside tmux could not
# be injected — macOS blocks TIOCSTI, so there is no way to push keystrokes into
# a plain terminal/tty. The registry stores an empty tmux_session for such a
# session and resolve skips it; it still gets the mail on its next prompt (the
# mail-live hook) or next session start (the mailbox banner), just not instantly.
# Start interactive sessions inside tmux (as remote_fleet.sh does) to be live-
# wakeable.
#
# bash 3.2-safe. Source with SESSION_PING_LIB_ONLY=1 for the functions only
# (tests stub `tmux`). Exit 0 on a delivered ping, 1 when the label can't be
# resolved to a live tmux pane (caller decides whether that's fatal).

# _session_ping_lane <label> <msg> → live delivery to a NON-tmux session of a
# lane (a profile lane or agy) through session_lanes.sh: an iTerm tab
# gets AppleScript `write text` (the spec's proven path). Only into an IDLE
# session — a busy one already sees new mail through its mail-live hook — and
# never into the session running this. 0 delivered | 1 not reachable | 3 busy
# (reachable, but mid-turn or at a prompt — the caller may defer, see tell.sh).
_session_ping_lane() {
  local label="$1" msg="$2" screen trc
  if ! command -v lanes_resolve >/dev/null 2>&1; then
    # shellcheck source=/dev/null
    [ -f "$_SP_LIB_DIR/session_lanes.sh" ] && . "$_SP_LIB_DIR/session_lanes.sh"
  fi
  command -v lanes_resolve >/dev/null 2>&1 || return 1
  # Lane mail is swarm mail: resolve among the swarm repo's sessions (an
  # arrangement tab of the same lane in another repo is never pinged), and an
  # exact pid when the caller has one (the coordinator's, from tell).
  lanes_resolve "$label" "${SP_TARGET_REPO-$(session_master_repo 2>/dev/null)}" "${SP_TARGET_PID:-}" 2>/dev/null || return 1
  lanes_is_self && { echo "session_ping: '$label' is this very session — skipping self-ping" >&2; return 0; }
  case "$LANE_KIND" in iterm|tmux) ;; *)
    echo "session_ping: $label (pid $LANE_PID) runs in a $LANE_KIND terminal — not live-wakeable" >&2; return 1 ;;
  esac
  screen="$(lanes_screen 30 2>/dev/null || true)"
  if [ "$(lanes_state "$screen")" = busy ]; then
    echo "session_ping: $label (pid $LANE_PID, $LANE_KIND ${LANE_TTY#/dev/}) is busy — not typing into it" >&2
    return 3
  fi
  # SP_CONFIRM_IDLE=1 (the deferred loop): idle must hold on a second read ~1s
  # later, so a turn or prompt starting in between is never typed into.
  if [ "${SP_CONFIRM_IDLE:-0}" = 1 ]; then
    _sp_sleep 1
    screen="$(lanes_screen 30 2>/dev/null || true)"
    if [ "$(lanes_state "$screen")" = busy ]; then
      echo "session_ping: $label turned busy on re-check — not typing" >&2
      return 3
    fi
  fi
  trc=0; lanes_type "$msg" || trc=$?
  if [ "$trc" = 5 ]; then
    echo "session_ping: STRANDED — '$msg' is still sitting unsubmitted in $label's input box (pid $LANE_PID, ${LANE_TTY#/dev/}) after a retry" >&2
    return 5
  fi
  [ "$trc" = 0 ] || { echo "session_ping: typing into $LANE_KIND $LANE_TTY failed" >&2; return 1; }
  echo "pinged $label ($LANE_KIND ${LANE_TMUX:-${LANE_TTY#/dev/}}, pid $LANE_PID, repo $LANE_REPO): $msg"
  return 0
}

session_ping() { # <label> [mail-id] → 0 delivered | 1 unresolved
  local label="$1" mailid="${2:-}" row target addr msg lrc
  if [ -z "$label" ]; then
    echo "session_ping: usage: session_ping <label> [mail-id]" >&2
    return 2
  fi
  command -v session_registry_resolve >/dev/null 2>&1 || {
    echo "session_ping: session_registry.sh not loaded" >&2; return 2; }

  if [ -n "$mailid" ]; then msg="check mail $mailid"; else msg="check mail"; fi
  # PRIMARY (operator direction 2026-10-03: every session lives in a visible
  # iTerm tab): a lane label resolves from the process table and is typed into
  # through iTerm (or its tmux pane, if that is where it runs).
  if command -v session_is_profile_label >/dev/null 2>&1 && session_is_profile_label "$label"; then
    _session_ping_lane "$label" "$msg"; lrc=$?
    # 0 delivered; 3 = found but busy — report it as such, never fall through
    # to a legacy tmux row (that could be a different session).
    [ "$lrc" = 0 ] && return 0
    [ "$lrc" = 3 ] && return 3
    [ "$lrc" = 5 ] && return 5   # stranded: never fall through to legacy tmux
  else
    # A REPO session (`tell AZURE`, sm_announce to host/<repo>) — resolve it
    # from the process table the same way: lanes_match turns a repo id into
    # the live session whose cwd is that repo, and its pid's tty finds the
    # iTerm tab (2026-10-26: AZURE/WEBSITE/foh/exo ran in iTerm tabs yet got
    # "no reachable iTerm tab or tmux pane" — only lane labels were tried).
    # Any repo: SP_TARGET_REPO="" (the swarm-repo narrowing is lane-only).
    SP_TARGET_REPO="" _session_ping_lane "$label" "$msg"; lrc=$?
    [ "$lrc" = 0 ] && return 0
    [ "$lrc" = 3 ] && return 3
    [ "$lrc" = 5 ] && return 5
  fi
  # LEGACY fallback: a registered tmux pane (older fleet doorways).
  row="$(session_registry_resolve "$label")" || row=""
  target="$(printf '%s' "$row" | awk -F'\t' '{print $5}')"
  addr="$(printf '%s' "$row" | awk -F'\t' '{print $7}')"
  if [ -z "$target" ]; then
    echo "session_ping: '$label' is not live-wakeable — no live iTerm tab or tmux pane (mail still waits in the mailbox)" >&2
    return 1
  fi

  # Self-guard: never inject into the pane we are running inside (a session
  # poking itself is a no-op that would echo a stray prompt).
  if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
    if [ "$(tmux display-message -p '#S' 2>/dev/null)" = "$target" ]; then
      echo "session_ping: '$label' is this very session — skipping self-ping" >&2
      return 0
    fi
  fi

  tmux send-keys -t "$target" "$msg" Enter 2>/dev/null || {
    echo "session_ping: tmux send-keys failed for pane '$target'" >&2
    return 1
  }
  echo "pinged $label (pane $target${addr:+, addr $addr}): $msg"
  return 0
}

# session_ping_deferred <label> <mail-id> [max-secs] [interval] — retry the
# live ping until it is delivered (0), the session can't be reached (1 — give
# up), or max-secs pass. Used by tell.sh for HOOKLESS lanes (agy) that were busy.
#   • ONE loop per label (mkdir lock holding the loop's pid; a dead holder's lock
#     is taken over): further busy tells just leave their mail — the single ping
#     is a bare "check mail", which makes the session read ALL pending mail.
#   • idle must be seen twice ~1s apart before typing (SP_CONFIRM_IDLE).
#   • interval is clamped to ≥ 1s so the bound always advances.
# Each attempt is logged to ~/.myai/logs/deferred-ping.log.
# _sp_mail_handled <to> <mail-id> → 0 once that mail is no longer unacked in
# <to>'s inbox (the peer read it — stop pinging). A gateway error counts as
# NOT handled, so an outage never cancels a wake-up. Overridable in tests.
_sp_mail_handled() {
  local resp
  command -v kl_call >/dev/null 2>&1 || return 1
  resp="$(kl_call mail_inbox "$(printf '{"to":"%s"}' "$1")")" || return 1
  [ -n "$resp" ] || return 1
  printf '%s' "$resp" | MID="$2" /usr/bin/python3 -c '
import json, os, sys
try:
    d = json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)
ids = {m.get("messageId") for m in d.get("messages") or [] if not m.get("acked")}
sys.exit(1 if os.environ["MID"] in ids else 0)
' 2>/dev/null
}

session_ping_deferred() {
  local label="$1" mid="$2" max="${3:-600}" every="${4:-15}" waited=0 rc log lock holder
  case "$every" in ''|*[!0-9]*) every=15 ;; esac
  [ "$every" -ge 1 ] || every=1
  case "$max" in ''|*[!0-9]*) max=600 ;; esac
  log="${MYAI_HOME:-$HOME/.myai}/logs/deferred-ping.log"
  lock="${MYAI_HOME:-$HOME/.myai}/locks/deferred-ping-$(printf '%s' "$label" | tr -c 'A-Za-z0-9_-' '_').lock"
  mkdir -p "$(dirname "$log")" "$(dirname "$lock")" 2>/dev/null || true
  if ! mkdir "$lock" 2>/dev/null; then
    holder="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      printf '%s %s %s already deferred by pid %s — not starting another loop\n' "$(date '+%F %T')" "$label" "$mid" "$holder" >> "$log" 2>/dev/null || true
      return 0
    fi
    rm -rf "$lock" 2>/dev/null; mkdir "$lock" 2>/dev/null || return 0
  fi
  printf '%s' "$$" > "$lock/pid" 2>/dev/null || true
  rc=3
  while [ "$waited" -le "$max" ]; do
    if [ -n "$mid" ] && [ -n "${SP_MAIL_TO:-}" ] && _sp_mail_handled "$SP_MAIL_TO" "$mid"; then
      printf '%s %s %s already acked — no ping needed\n' "$(date '+%F %T')" "$label" "$mid" >> "$log" 2>/dev/null || true
      rc=0; break
    fi
    SP_CONFIRM_IDLE=1 session_ping "$label" "" >/dev/null 2>&1; rc=$?
    printf '%s %s %s rc=%s waited=%ss\n' "$(date '+%F %T')" "$label" "$mid" "$rc" "$waited" >> "$log" 2>/dev/null || true
    if [ "$rc" = 5 ]; then
      command -v _tell_alert_stranded >/dev/null 2>&1 && _tell_alert_stranded "$label" "$mid"
      break
    fi
    [ "$rc" = 3 ] || break
    _sp_sleep "$every"; waited=$((waited + every))
  done
  rm -rf "$lock" 2>/dev/null || true
  return "$rc"
}
_sp_sleep() { sleep "$1"; }

_SP_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)/lib"

[ -n "${SESSION_PING_LIB_ONLY:-}" ] && return 0


# ── CLI entry ────────────────────────────────────────────────────────────────
_SP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
for _lib in "$_SP_DIR/lib/session_registry.sh" "$_SP_DIR/../scripts/lib/session_registry.sh"; do
  # shellcheck source=/dev/null
  [ -f "$_lib" ] && . "$_lib" && break
done
if [ "${1:-}" = "--deferred" ]; then
  # The detached loop alerts the coordinator on a stranded ping — load tell.sh's helpers.
  # shellcheck source=/dev/null
  [ -f "$_SP_DIR/tell.sh" ] && TELL_LIB_ONLY=1 . "$_SP_DIR/tell.sh"
  shift; session_ping_deferred "$@"; exit $?
fi
session_ping "$@"
