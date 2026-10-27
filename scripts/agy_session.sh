#!/usr/bin/env bash
# agy_session.sh — run Antigravity (`agy`) as a first-class, reachable fleet
# session in a VISIBLE iTerm tab (operator direction 2026-10-03: every session
# lives in a visible iTerm tab — no hidden tmux), registered in the live-session
# registry, with Remote Control on. Reachable the same three ways as Claude:
#
#   phone        → launched with `--remote-control`, exactly like the operator's
#                  own `agy` wrapper in ~/.zshrc, which coexists with agy's
#                  remote-control daemon (launchd com.google.antigravity-cli-
#                  daemon, fixed instance "<host>" at antigravity.google.com).
#                  This script never starts, stops or re-registers that daemon;
#                  it only warns if it is down.
#   tell agy …   → durable mail to <host>/agy + a live "check mail <id>" typed
#                  into agy's iTerm tab (AppleScript write text + a second empty
#                  write to submit — scripts/lib/session_lanes.sh)
#   swarm        → unaffected: swarm children routed to agy run headless via the
#                  runner's agy lane (`agy -p`), not through this session
#
# agy has no hooks and no background watcher, so the typed `check mail <id>`
# IS its wake-up; GEMINI.md / AGENTS.md teach it what to do with that line.
#
# Usage:
#   agy_session.sh start [repo-dir] [--prompt "<first prompt>"] [--safe] [--new-tab]
#       Already running for that repo → reports it and brings its tab forward.
#       From an interactive iTerm tab → agy runs IN THIS TAB (agy-rc does this).
#       Otherwise (boot, scripts, --new-tab) → a new iTerm tab is opened for it.
#       default dir = this checkout, default prompt = "boot".
#       --safe drops --dangerously-skip-permissions (agy asks before tools).
#   agy_session.sh status            — live agy sessions + remote-control daemon
#   agy_session.sh attach [repo-dir] — bring that agy's iTerm tab to the front
#   agy_session.sh stop   [repo-dir] — stop that agy process (its tab stays)
#   agy_session.sh statusline        — install agy's bottom status line (start does it too)
#   agy_session.sh install-alias     — add the `agy-rc` shell command to ~/.zshrc
#
# bash 3.2-safe. Exit 0 on success.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib/session_registry.sh"
# shellcheck source=/dev/null
. "$HERE/lib/session_lanes.sh"

AGY_BIN="${AGY_BIN:-$(command -v agy 2>/dev/null || echo "$HOME/.local/bin/agy")}"
AGY_START_WAIT="${AGY_START_WAIT:-20}"

_agy_repo_id() { _lanes_repo_of "$1"; }

_agy_dir() { # [dir] → absolute git toplevel
  local d="${1:-$HERE/..}"
  (cd "$d" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) || (cd "$d" && pwd)
}

# _agy_find <repo> → 0 + LANE_* (the first one) when any interactive agy runs
# in <repo>. Two agy processes in one repo are still "running" — never a reason
# to open a third (PR #481 review).
_agy_find() {
  local row
  row="$(lanes_match agy "$1" | grep . | head -1 || true)"
  [ -n "$row" ] || return 1
  lanes_load "$row"
}

# _agy_new_tab <command> → opens a new iTerm tab (new window when none),
# types <command> into its shell, prints the tab's tty. Stubbed in tests.
_agy_new_tab() {
  printf '%s\n' 'on run argv
  set theCmd to item 1 of argv
  tell application "iTerm2"
    activate
    if (count of windows) = 0 then
      create window with default profile
    else
      tell current window to create tab with default profile
    end if
    tell current session of current window
      write text theCmd
      return tty
    end tell
  end tell
end run' | _lanes_osascript "$1"
}

# _agy_focus_tab <tty> → select the iTerm tab/window holding <tty>. Stubbed in tests.
_agy_focus_tab() {
  printf '%s\n' 'on run argv
  set theTty to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) is theTty then
            select t
            select w
            activate
            return "__MYAI_OK__"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "__MYAI_NO_SESSION__"
end run' | _lanes_osascript "$1" >/dev/null
}

_agy_register() { # <repo> <pid> <tty>
  local host
  host="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  session_registry_write "$(hostname -s) - $1 (agy)" agy "$1" "$host" "" "$2" "$host/agy"
  echo "agy_session: registered agy for $1 (address $host/agy, pid $2, ${3#/dev/})"
}

# _agy_swarm_loop <agy-pid> → detached `swarm_master.sh agy-loop <pid>`: agy has
# no hooks and no mail watcher, so this loop carries its coordinator-lease
# heartbeat/failover (plan/SWARM_COORDINATOR_PLAN.md row 2). It exits when agy's
# pid dies (releasing the lease if held) and refuses to run twice for one pid.
# AGY_SWARM_LOOP=0 disables it. Stubbed in tests.
_agy_swarm_loop() {
  [ "${AGY_SWARM_LOOP:-1}" = 1 ] || return 0
  [ -f "$HERE/swarm_master.sh" ] || return 0
  nohup bash "$HERE/swarm_master.sh" agy-loop "$1" >/dev/null 2>&1 &
}

_agy_daemon_check() {
  if ! "$AGY_BIN" remote-control status 2>/dev/null | grep -q 'state = running'; then
    echo "  ⚠ agy remote-control daemon is NOT running — the phone can't see agy. Fix: agy remote-control start --name $(hostname -s)"
  fi
}

agy_start() {
  local dir="" prompt="boot" safe=0 newtab=0 repo cmd skip qprompt tty i
  while [ $# -gt 0 ]; do
    case "$1" in
      --prompt)
        [ $# -ge 2 ] || { echo "agy_session: --prompt needs a value" >&2; return 2; }
        prompt="$2"; shift 2 ;;
      --safe) safe=1; shift ;;
      --new-tab) newtab=1; shift ;;
      *) dir="$1"; shift ;;
    esac
  done
  dir="$(_agy_dir "$dir")"
  [ -x "$AGY_BIN" ] || { echo "agy_session: agy not found ($AGY_BIN)" >&2; return 1; }
  repo="$(_agy_repo_id "$dir")"
  agy_statusline_install || echo "agy_session: (status line not installed — continuing)" >&2
  if _agy_find "$repo"; then
    echo "agy_session: agy already running for $repo (pid $LANE_PID, $LANE_KIND ${LANE_TMUX:-${LANE_TTY#/dev/}})"
    [ "$LANE_KIND" = iterm ] && _agy_focus_tab "$LANE_TTY"
    _agy_register "$repo" "$LANE_PID" "$LANE_TTY"
    _agy_swarm_loop "$LANE_PID"
    _agy_daemon_check
    return 0
  fi
  skip="--dangerously-skip-permissions"
  [ "$safe" = 1 ] && skip=""
  qprompt="$(printf '%q' "$prompt")"
  # MYAI_SESSION_PROFILE=agy makes any myai helper agy runs (mail_watch, tell)
  # address itself as <host>/agy.
  if [ "$newtab" = 0 ] && [ "${TERM_PROGRAM:-}" = iTerm.app ] && [ -t 0 ] && [ -t 1 ]; then
    # Run in THIS tab: the pid survives exec, so register before handing over.
    _agy_register "$repo" "$$" "$(tty 2>/dev/null)"
    _agy_swarm_loop "$$"
    _agy_daemon_check
    echo "agy_session: starting agy here (prompt: $prompt) — message it with: tell agy \"<message>\""
    cd "$dir" || return 1
    export MYAI_SESSION_PROFILE=agy
    # shellcheck disable=SC2086  # $skip is deliberately one optional flag
    exec "$AGY_BIN" $skip --remote-control -i "$prompt"
  fi
  cmd="cd $(printf '%q' "$dir") && MYAI_SESSION_PROFILE=agy $(printf '%q' "$AGY_BIN") $skip --remote-control -i $qprompt"
  tty="$(_agy_new_tab "$cmd" 2>/dev/null || true)"
  case "$tty" in /dev/*) ;; *)
    echo "agy_session: could not open an iTerm tab (is iTerm2 installed and allowed to be scripted?) — run by hand: $cmd" >&2
    return 1 ;;
  esac
  echo "agy_session: opened iTerm tab ${tty#/dev/} for $repo (prompt: $prompt)"
  i=0
  while [ "$i" -lt "$AGY_START_WAIT" ]; do
    if _agy_find "$repo" && [ "$LANE_TTY" = "$tty" ]; then
      _agy_register "$repo" "$LANE_PID" "$tty"
      _agy_swarm_loop "$LANE_PID"
      _agy_daemon_check
      echo "  message it: ./scripts/tell.sh agy \"<message>\""
      return 0
    fi
    _lanes_sleep 1; i=$((i + 1))
  done
  echo "agy_session: tab ${tty#/dev/} opened but no agy process appeared there within ${AGY_START_WAIT}s — look at the tab" >&2
  return 1
}

# agy_statusline_install — point agy's custom status line at
# scripts/agy_statusline.py (repo/branch/lane/model/myAI badge, like the Claude
# sessions' bottom line). Idempotent; preserves every other agy setting and
# keeps a one-time backup. AGY_SETTINGS overrides the path (tests).
agy_statusline_install() {
  local settings="${AGY_SETTINGS:-$HOME/.gemini/antigravity-cli/settings.json}"
  local script="$HERE/agy_statusline.py"
  [ -f "$script" ] || { echo "agy_session: $script missing" >&2; return 1; }
  mkdir -p "$(dirname "$settings")" 2>/dev/null
  [ -f "$settings" ] && [ ! -f "$settings.pre-statusline.bak" ] && cp "$settings" "$settings.pre-statusline.bak"
  AGY_SL_SETTINGS="$settings" AGY_SL_CMD="python3 '$script'" /usr/bin/python3 - <<'PY' || return 1
import json, os
import sys
p = os.environ["AGY_SL_SETTINGS"]
d = {}
if os.path.exists(p) and os.path.getsize(p) > 0:
    try:
        d = json.load(open(p))
    except Exception as e:
        # Never rewrite a file we can't parse — that would wipe every other agy setting.
        sys.stderr.write("agy_session: %s is not plain JSON (%s) — not touching it\n" % (p, e))
        sys.exit(1)
if not isinstance(d, dict):
    sys.stderr.write("agy_session: %s is not a JSON object — not touching it\n" % p)
    sys.exit(1)
want = {"type": "command", "command": os.environ["AGY_SL_CMD"], "stack_with_default": True}
if d.get("statusLine") == want:
    print("agy_session: status line already installed")
else:
    d["statusLine"] = want
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=2)
    os.replace(tmp, p)
    print("agy_session: status line installed -> " + p)
PY
}

# agy_alias_install — the `agy-rc` shell command, the agy counterpart of the
# claude-<lane> functions: start-or-attach this repo's agy session.
# Own marker block in ~/.zshrc (ZSHRC overrides for tests); idempotent.
agy_alias_install() {
  local rc="${ZSHRC:-$HOME/.zshrc}" tmp nb ne
  local begin="# >>> agy-rc (managed by agy_session.sh) >>>" end="# <<< agy-rc <<<"
  touch "$rc" 2>/dev/null || return 1
  # Write through a symlink (dotfile managers) instead of replacing it.
  if [ -L "$rc" ]; then rc="$(/usr/bin/python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$rc")"; fi
  # Unbalanced markers would make the awk below drop everything after the begin
  # line — refuse rather than truncate the operator's shell config.
  nb="$(grep -cxF "$begin" "$rc")"; ne="$(grep -cxF "$end" "$rc")"
  if [ "$nb" != "$ne" ] || [ "$nb" -gt 1 ]; then
    echo "agy_session: $rc has unbalanced agy-rc markers (begin=$nb end=$ne) — fix by hand, not rewriting" >&2
    return 1
  fi
  tmp="$rc.agyrc.$$"
  awk -v b="$begin" -v e="$end" '$0==b{skip=1} !skip{print} $0==e{skip=0}' "$rc" > "$tmp" || return 1
  {
    printf '%s\n' "$begin"
    printf '%s\n' "# agy-rc [--safe] [--prompt \"<first prompt>\"] — run Antigravity for the current"
    printf '%s\n' "# repo in THIS iTerm tab (or bring its existing tab forward); reachable by"
    printf '%s\n' "# \`tell agy\` + the phone (agy daemon)."
    printf '%s\n' "agy-rc() {"
    printf '%s\n' "  local dir; dir=\"\$(git rev-parse --show-toplevel 2>/dev/null || pwd)\""
    printf '%s\n' "  bash '$HERE/agy_session.sh' start \"\$dir\" \"\$@\""
    printf '%s\n' "}"
    printf '%s\n' "$end"
  } >> "$tmp"
  mv -f "$tmp" "$rc" && echo "agy_session: agy-rc installed in $rc (new terminal, or: source $rc)"
}

agy_status() {
  echo "── live agy sessions ──"
  bash "$HERE/check_session.sh" agy 2>&1 | sed 's/^/  /' || true
  echo "── remote-control daemon ──"
  "$AGY_BIN" remote-control status 2>&1 | sed 's/^/  /'
}

agy_attach() {
  local repo
  repo="$(_agy_repo_id "$(_agy_dir "${1:-}")")"
  _agy_find "$repo" || { echo "agy_session: no agy running for $repo — start it: agy-rc" >&2; return 1; }
  case "$LANE_KIND" in
    iterm) _agy_focus_tab "$LANE_TTY"; echo "agy_session: brought agy's tab (${LANE_TTY#/dev/}) to the front" ;;
    tmux) exec tmux attach -t "$LANE_TMUX" ;;
    *) echo "agy_session: agy pid $LANE_PID runs in a $LANE_KIND terminal (${LANE_TTY#/dev/})" ;;
  esac
}

agy_stop() {
  local repo i=0
  repo="$(_agy_repo_id "$(_agy_dir "${1:-}")")"
  _agy_find "$repo" || { echo "agy_session: no agy running for $repo"; return 0; }
  kill -TERM "$LANE_PID" 2>/dev/null || true
  while kill -0 "$LANE_PID" 2>/dev/null && [ "$i" -lt 10 ]; do _lanes_sleep 1; i=$((i + 1)); done
  if kill -0 "$LANE_PID" 2>/dev/null; then echo "agy_session: pid $LANE_PID still running" >&2; return 1; fi
  echo "agy_session: stopped agy pid $LANE_PID for $repo (its tab stays open)"
}

[ -n "${AGY_SESSION_LIB_ONLY:-}" ] && return 0

case "${1:-}" in
  start) shift; agy_start "$@" ;;
  status) agy_status ;;
  attach) shift; agy_attach "$@" ;;
  stop) shift; agy_stop "$@" ;;
  statusline) agy_statusline_install ;;
  install-alias) agy_alias_install ;;
  *) sed -n '22,35p' "$0"; exit 2 ;;
esac
