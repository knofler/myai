#!/usr/bin/env bash
# iterm_tab.sh — generic helper to open, drive, focus, and verify iTerm2 tabs.
# Shared helper: used by agy remote sessions and Claude fleet doorways.
#
# Functions:
#   iterm_running                  → 0 if running, 3 if not
#   iterm_read_tab <tty> [lines]   → screen contents of the tab with <tty>
#   iterm_open_tab <dir> <cmd> [wait_sec] → opens a tab in current window,
#                                    runs `cd <dir> && <cmd>`, verifies contents
#                                    before returning 0 with tty on stdout.
#   iterm_write_tab <tty> <text> [delay_sec] → types text (newline NO), waits,
#                                    submits with a separate empty write text,
#                                    re-reads the tab and retries the Enter once.
#   iterm_text_stuck <text> <screen> → 0 when text still sits in the input box.
#   iterm_focus_tab <tty>          → selects and activates the tab and window.
#
# Exit codes:
#   0 = success
#   1 = general failure (invalid arguments, timeout, command failure)
#   3 = iTerm not running or not scriptable (TCC / automation denied)
#   4 = tty not found in any iTerm window/tab
#   5 = text still unsubmitted in the input box after one retry (stranded)
#
# Hermetic testing: override _iterm_osascript, _iterm_running, _iterm_sleep, _iterm_screen.
# bash 3.2-safe.

_iterm_comm()        { ps -o comm= -p "$1" 2>/dev/null || true; }
# shellcheck disable=SC2009  # pgrep misses iTerm2 from some subshells on macOS
_iterm_running()     { [ "${ITERM_STUB_RUNNING:-0}" = "1" ] || [ "$(ps -axo comm= 2>/dev/null | grep -c '/iTerm2$' || true)" -gt 0 ]; }
# Scripts are fed on stdin with a here-string, never `printf | …`: a reader
# that exits without draining stdin would SIGPIPE the printf, and under
# pipefail that turned a good run into rc 3 (flaky CI, 2026-10-26).
_iterm_osascript()   { osascript - "$@" 2>/dev/null; }
_iterm_sleep()       { sleep "$1"; }
_iterm_screen()      { iterm_read_tab "$1" 40; }   # verify read (session_lanes routes it through lanes_screen)

iterm_running() {
  _iterm_running && return 0
  return 3
}

# ── screen reader ─────────────────────────────────────────────────────────────
_ITERM_AS_READ='on run argv
  set theTty to item 1 of argv
  set shortTty to theTty
  if shortTty starts with "/dev/" then
    set shortTty to text 6 thru -1 of shortTty
  end if
  set longTty to theTty
  if longTty does not start with "/dev/" then
    set longTty to "/dev/" & longTty
  end if
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) is longTty or (tty of s) is shortTty then
            return contents of s
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "__MYAI_NO_SESSION__"
end run'

iterm_read_tab() { # <tty> [lines] → text on screen, trailing blank lines trimmed
  local tty="${1:-}" lines="${2:-40}" out
  [ -n "$tty" ] || return 1
  _iterm_running || return 3
  out="$(_iterm_osascript "$tty" <<<"$_ITERM_AS_READ")" || return 3
  [ "$out" = "__MYAI_NO_SESSION__" ] && return 4
  # Trim trailing blank lines, preserve up to N lines
  printf '%s\n' "$out" | awk '{a[NR]=$0} END {n=NR; while (n > 0 && a[n] ~ /^[[:space:]]*$/) n--; s=n-'"$lines"'+1; if (s < 1) s=1; for (i=s; i<=n; i++) print a[i]}'
}

# ── tab opener & verifier ─────────────────────────────────────────────────────
_ITERM_AS_OPEN='on run argv
  set theDir to item 1 of argv
  set theCmd to item 2 of argv
  tell application "iTerm2"
    activate
    if (count of windows) = 0 then
      set newWin to (create window with default profile)
      set newSes to current session of newWin
    else
      tell current window
        set newTab to (create tab with default profile)
        set newSes to current session of newTab
      end tell
    end if
    tell newSes
      if theDir is not "" then
        write text ("cd " & quoted form of theDir)
      end if
      if theCmd is not "" then
        write text theCmd
      end if
      return tty
    end tell
  end tell
end run'

iterm_open_tab() { # <dir> <cmd> [wait_sec] → prints tty on stdout, verifies content
  local dir="${1:-}" cmd="${2:-}" wait_sec="${3:-5}" tty screen waited=0 step=1
  _iterm_running || {
    echo "iterm_tab: iTerm2 is not running" >&2
    return 3
  }

  tty="$(_iterm_osascript "$dir" "$cmd" <<<"$_ITERM_AS_OPEN")" || {
    echo "iterm_tab: failed to execute AppleScript to create tab" >&2
    return 3
  }

  case "$tty" in
    /dev/*|ttys*) ;;
    *)
      echo "iterm_tab: expected tty device from AppleScript, got: '$tty'" >&2
      return 1
      ;;
  esac

  # Normalise /dev/ttys001 format
  case "$tty" in
    /dev/*) ;;
    *) tty="/dev/$tty" ;;
  esac

  # Verify by reading contents back (proof, not just exit code)
  while [ "$waited" -lt "$wait_sec" ]; do
    screen="$(iterm_read_tab "$tty" 30 2>/dev/null || true)"
    if [ -n "$screen" ]; then
      # Confirmed: tab exists and returned content
      printf '%s\n' "$tty"
      return 0
    fi
    _iterm_sleep "$step"
    waited=$((waited + step))
  done

  # Final attempt
  screen="$(iterm_read_tab "$tty" 30 2>/dev/null || true)"
  if [ -n "$screen" ]; then
    printf '%s\n' "$tty"
    return 0
  fi

  echo "iterm_tab: tab opened at $tty but contents could not be verified within ${wait_sec}s" >&2
  return 1
}

# ── tab writer: type, submit separately, VERIFY ─────────────────────────────
# Proven on office-mac (plan/SESSION_TAKEOVER_SPEC.md + 2026-10-04 strandings in
# personal's and qwen's tabs): a Claude/agy TUI takes `write text`'s trailing
# newline as part of a PASTE — the text lands in the input box unsubmitted (the
# "ctrl+g to edit in Vim" hint = still in the box). So:
#   1. type the text with `newline NO` (PR #483 review: a typed newline could
#      also submit early, and then step 2's Enter answers whatever prompt just
#      appeared);
#   2. after [delay], a SEPARATE `write text ""` (one Enter) submits;
#   3. re-read the tab: still in the box → wait ~2 s, ONE more separate Enter;
#      still there → 5 (stranded), so the caller can alert instead of assuming.
# argv: tty, text, "yes"|"no" (append newline).
_ITERM_AS_WRITE_RAW='on run argv
  set theTty to item 1 of argv
  set theMsg to item 2 of argv
  set withNewline to (item 3 of argv) is "yes"
  set shortTty to theTty
  if shortTty starts with "/dev/" then
    set shortTty to text 6 thru -1 of shortTty
  end if
  set longTty to theTty
  if longTty does not start with "/dev/" then
    set longTty to "/dev/" & longTty
  end if
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) is longTty or (tty of s) is shortTty then
            if withNewline then
              tell s to write text theMsg
            else
              tell s to write text theMsg newline NO
            end if
            return "__MYAI_OK__"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "__MYAI_NO_SESSION__"
end run'

# _iterm_write_raw <tty> <text> <yes|no> → 0 ok, 3 unscriptable, 4 no such tty, 1 other
_iterm_write_raw() {
  local out
  out="$(_iterm_osascript "$1" "$2" "$3" <<<"$_ITERM_AS_WRITE_RAW")" || return 3
  case "$out" in
    __MYAI_OK__) return 0 ;;
    __MYAI_NO_SESSION__) return 4 ;;
    *) return 1 ;;
  esac
}

# iterm_text_stuck <text> <screen> → 0 when <text> still sits UNSUBMITTED in
# the input box. Only the LAST "❯ …" (Claude) / "> …" (agy) line among the
# bottom 12 non-blank lines counts — a submitted prompt is echoed as "> text"
# in the history above the box. First 30 chars of <text> are matched (a long
# message wraps). Claude's live input box is "❯" + a NON-BREAKING space, while
# the echo of a submitted prompt uses a normal space — so match the bare "❯"
# (matching "❯ " missed the empty box and read the echo above it as stuck:
# every idle delivery came back 5, live-verified 2026-10-04). Locale-safe: no
# multibyte char in a bracket expression.
iterm_text_stuck() {
  local needle last
  needle="$(printf '%s' "$1" | cut -c1-30)"
  [ -n "$needle" ] || return 1
  # Sent into a BUSY session, the Enter QUEUES the message: Claude re-renders
  # it as "❯ <text>" above the box with "ctrl+enter to send now" and "Press up
  # to edit queued messages" — submitted, not stuck (live-verified 2026-10-04:
  # without this a correct queued delivery came back as 5).
  case "${2:-}" in *"edit queued messages"*|*"ctrl+enter to send now"*) return 1 ;; esac
  last="$(printf '%s\n' "${2:-}" | awk 'NF' | tail -n 12 \
    | sed -e 's/^[[:space:]]*//' -e 's/^│[[:space:]]*//' \
    | awk 'index($0, "> ") == 1 || index($0, "❯") == 1 { l = $0 } END { print l }')"
  [ -n "$last" ] || return 1
  case "$last" in *"$needle"*) return 0 ;; esac
  return 1
}

iterm_write_tab() { # <tty> <text> [delay_sec] → 0 submitted · 1 · 3 down · 4 no tty · 5 stranded
  local tty="${1:-}" text="${2:-}" delay="${3:-1.2}" rc scr
  [ -n "$tty" ] || return 1
  _iterm_running || return 3

  # 1. Type — no trailing newline.
  _iterm_write_raw "$tty" "$text" no; rc=$?
  [ "$rc" = 0 ] || return "$rc"
  # 2. Separate Enter.
  _iterm_sleep "$delay"
  _iterm_write_raw "$tty" "" yes; rc=$?
  [ "$rc" = 0 ] || return "$rc"
  [ "${ITERM_NO_VERIFY:-0}" = 1 ] && return 0
  [ -n "$text" ] || return 0
  # 3. Verify by reading the tab back (proof, not an exit code). An unreadable
  #    tab can't be verified — report the submit as done rather than stranded.
  _iterm_sleep "${ITERM_VERIFY_WAIT:-1}"
  scr="$(_iterm_screen "$tty" 2>/dev/null)" || return 0
  iterm_text_stuck "$text" "$scr" || return 0
  _iterm_sleep "${ITERM_RETRY_WAIT:-2}"
  _iterm_write_raw "$tty" "" yes; rc=$?
  [ "$rc" = 0 ] || return "$rc"
  _iterm_sleep "${ITERM_VERIFY_WAIT:-1}"
  scr="$(_iterm_screen "$tty" 2>/dev/null)" || return 0
  iterm_text_stuck "$text" "$scr" && return 5
  return 0
}

# ── tab focus ─────────────────────────────────────────────────────────────────
_ITERM_AS_FOCUS='on run argv
  set theTty to item 1 of argv
  set shortTty to theTty
  if shortTty starts with "/dev/" then
    set shortTty to text 6 thru -1 of shortTty
  end if
  set longTty to theTty
  if longTty does not start with "/dev/" then
    set longTty to "/dev/" & longTty
  end if
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) is longTty or (tty of s) is shortTty then
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
end run'

iterm_focus_tab() { # <tty> → 0 ok, 3 unscriptable/down, 4 tty not found
  local tty="${1:-}" out
  [ -n "$tty" ] || return 1
  _iterm_running || return 3

  out="$(_iterm_osascript "$tty" <<<"$_ITERM_AS_FOCUS")" || return 3
  case "$out" in
    __MYAI_OK__) return 0 ;;
    __MYAI_NO_SESSION__) return 4 ;;
    *) return 1 ;;
  esac
}
