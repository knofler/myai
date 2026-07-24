#!/usr/bin/env bash
# 21-iterm-no-green.sh — remap iTerm2's unreadable ANSI green → orange (#FF8700) every session.
#
# The operator cannot read green (AI_RULES §13). The `dark-daltonized` Claude Code
# theme + the framework's own orange output (PR #275) cover most of it, but iTerm's
# ANSI palette (green = pure #00C200) still paints any ANSI-green text — including
# Claude Code's own UI accents. We can't reach the tty from a hook (Claude Code runs
# us with no controlling terminal), but iTerm2 accepts color changes via Apple Events
# (osascript) out-of-band — so re-apply the green→orange remap to every open session
# at session start. Idempotent, silent, macOS+iTerm only.
set +e
[ "$(uname -s)" = "Darwin" ] || exit 0
[ "${TERM_PROGRAM:-}" = "iTerm.app" ] || exit 0
command -v osascript >/dev/null 2>&1 || exit 0

osascript >/dev/null 2>&1 <<'AS'
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        tell s
          set ANSI green color to {65535, 34695, 0}          -- #FF8700 orange (operator's pick 2026-07-05)
          set ANSI bright green color to {65535, 41120, 12336} -- #FFA030 lighter orange
        end tell
      end repeat
    end repeat
  end repeat
end tell
AS
exit 0
