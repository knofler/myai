#!/usr/bin/env bash
  # shellcheck source=scripts/lib/session_registry.sh disable=SC1091
# session_lanes.sh — find a live interactive session by LANE (<x> for ~/.claude-<x> |
# personal | agy) and read / type into it, whatever terminal it runs in.
# Backs the peek / nudge / takeover keywords (plan/SESSION_TAKEOVER_SPEC.md) and
# session_ping's live delivery to non-tmux sessions.
#
# WHY: the live-session registry only knows tmux panes, so a tech session in a
# plain iTerm tab was "not live-wakeable" — the master could mail it but never see
# or poke it. Proven by hand on office-mac (2026-10-03):
#   • the lane is found from the process table: a `claude` whose environment
#     carries CLAUDE_CONFIG_DIR=~/.claude-<lane> (`ps eww`), cwd via lsof;
#   • tmux pane  → `tmux capture-pane` reads, `tmux send-keys` types;
#   • iTerm tab  → AppleScript, NO permission prompt: the session whose `tty`
#     matches gives `contents`, and `write text` types. GOTCHA: Claude's TUI
#     takes write text's trailing newline as part of a paste and does NOT
#     submit; a SECOND, separate `write text ""` submits;
#   • Terminal.app `do script` runs a new command, it is not input injection —
#     such a session is reported not-reachable rather than guessed at.
#
# Every OS touchpoint is a small _lanes_* function so the suites can stub it
# (scripts/tests/test_session_lanes.sh). Sourced, never executed. bash 3.2-safe
# and safe under `set -euo pipefail` (no `| grep -q`, every probe guarded).
#
# After lanes_resolve succeeds these globals describe the session:
#   LANE_NAME LANE_PID LANE_TTY LANE_CFG LANE_CWD LANE_REPO
#   LANE_KIND   tmux | iterm | terminal | unknown
#   LANE_TMUX   tmux session name (kind=tmux, display only)
#   LANE_TMUX_PANE  tmux pane id (%N) — what reads/types TARGET, so a split or
#                   multi-window session never hits the wrong pane

LANES_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"

# ── OS touchpoints (stubbed in tests) ─────────────────────────────────────────
_lanes_ps()          { ps -axo pid=,tty=,args= 2>/dev/null || true; }
_lanes_env()         { ps eww -o command= -p "$1" 2>/dev/null || true; }
_lanes_cwd()         { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true; }
_lanes_tmux_panes()  { command -v tmux >/dev/null 2>&1 && tmux list-panes -a -F '#{pane_tty} #{pane_id} #{session_name}' 2>/dev/null || true; }
_lanes_ppid()        { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' ' || true; }
_lanes_comm()        { ps -o comm= -p "$1" 2>/dev/null || true; }
# ps, not pgrep: pgrep -x iTerm2 misses the app process from some shells
# (verified 2026-10-03 on office-mac while ps listed it).
# shellcheck disable=SC2009  # deliberate: pgrep misses iTerm2 here (see above)
_lanes_iterm_running() { [ "$(ps -axo comm= 2>/dev/null | grep -c '/iTerm2$' || true)" -gt 0 ]; }
_lanes_osascript()   { osascript - "$@" 2>/dev/null; }
_lanes_sleep()       { sleep "$1"; }
# The iTerm typing path lives in ONE place — scripts/lib/iterm_tab.sh
# (iterm_write_tab: newline NO + separate Enter + verify + one retry). Its hooks
# are routed through this file's, so a lane's tty, the screen read and every
# test stub here (_lanes_osascript / _lanes_sleep / lanes_screen) still apply.
# shellcheck source=/dev/null
. "$LANES_HERE/iterm_tab.sh"
_iterm_osascript() { _lanes_osascript "$@"; }
_iterm_sleep()     { _lanes_sleep "$1"; }
_iterm_running()   { _lanes_iterm_running; }
_iterm_screen()    { lanes_screen 40; }
_lanes_repo_of() { # <dir> → canonical repo id, lowercased
  local top
  top="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$1")"
  if ! command -v canonical_repo_id >/dev/null 2>&1; then
    # shellcheck source=/dev/null
    [ -f "$LANES_HERE/repo_id.sh" ] && . "$LANES_HERE/repo_id.sh" 2>/dev/null
  fi
  if command -v canonical_repo_id >/dev/null 2>&1; then
    canonical_repo_id "$top" | tr '[:upper:]' '[:lower:]'
  else
    basename "$top" | tr '[:upper:]' '[:lower:]'
  fi
}

# _lanes_self_pid → pid of the claude/agy process THIS shell runs under (so a
# session never types into itself). Empty when not under one.
_lanes_self_pid() {
  local p="$$" d=0 c
  # A detached helper (tell's deferred ping, re-parented to launchd) cannot
  # find its caller by walking up — the caller passes its pid in (PR #483).
  if [ -n "${LANES_SELF_PID:-}" ]; then printf '%s' "$LANES_SELF_PID"; return 0; fi
  while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null && [ "$d" -lt 15 ]; do
    c="$(_lanes_comm "$p")"
    case "${c##*/}" in claude|agy) printf '%s' "$p"; return 0 ;; esac
    p="$(_lanes_ppid "$p")"; d=$((d + 1))
  done
  return 0
}

# lanes_candidates <lane|*> → one "pid<TAB>tty<TAB>cfg<TAB>cwd<TAB>lane" line
# per live, interactive session of that lane ("*" = every lane). Excludes
# headless runs (-p/--print, runner fires) and agy's own remote-control daemon.
# A claude session's lane comes from its config dir: ~/.claude-<lane>, or
# "default" for the bare ~/.claude.
lanes_candidates() {
  local want="$1" pid tty args bin envs cfg cwd lane
  # LANES_PROC_SCAN=0 disables the process scan (hermetic suites that only
  # exercise the tmux-registry path must never see this Mac's real sessions).
  [ "${LANES_PROC_SCAN:-1}" = 0 ] && return 0
  _lanes_ps | while read -r pid tty args; do
    [ -n "$pid" ] || continue
    case "$tty" in ''|'??'|'?') continue ;; esac
    bin="${args%% *}"; bin="${bin##*/}"
    case " $args " in *" -p "*|*" --print "*|*" --prompt "*|*"remote-control serve"*) continue ;; esac
    case "$bin" in
      agy) lane=agy; cfg=agy ;;
      claude)
        envs="$(_lanes_env "$pid")"
        case " $envs " in *" MYAI_RUNNER_FIRE=1 "*) continue ;; esac
        cfg="$(printf '%s\n' "$envs" | tr ' ' '\n' | sed -n 's/^CLAUDE_CONFIG_DIR=//p' | head -1)"
        case "$cfg" in
          */.claude-*) lane="${cfg##*/.claude-}" ;;
          *) lane=default; cfg="${cfg:-$HOME/.claude}" ;;
        esac ;;
      *) continue ;;
    esac
    [ "$want" = "*" ] || [ "$want" = "$lane" ] || continue
    cwd="$(_lanes_cwd "$pid")"
    printf '%s\t%s\t%s\t%s\t%s\n' "$pid" "/dev/${tty#/dev/}" "$cfg" "$cwd" "$lane"
  done
}

# _lanes_ps_tree → "pid ppid args" for every process (stubbable in tests).
_lanes_ps_tree() { ps -axo pid=,ppid=,args= 2>/dev/null || true; }

# lanes_has_watcher <session-pid> → 0 when a scripts/mail_watch.sh process
# descends from that claude/agy session (a run_in_background watcher is
# session → shell → bash mail_watch.sh). No watcher = the session is DEAF while
# idle: only a typed ping wakes it (swarm coordinator plan, 2026-10-04).
lanes_has_watcher() {
  local target="$1"
  case "$target" in ''|*[!0-9]*) return 1 ;; esac
  [ "$(_lanes_ps_tree | awk -v target="$target" '
    { pp[$1] = $2; if ($0 ~ /mail_watch\.sh/) w[$1] = 1 }
    END {
      for (p in w) {
        q = p
        for (i = 0; i < 25 && q > 1; i++) {
          if (q == target) { print "yes"; exit }
          q = pp[q]
        }
      }
    }')" = yes ]
}

# lanes_load <row> → set LANE_* globals from one candidates row.
lanes_load() {
  IFS="$(printf '\t')" read -r LANE_PID LANE_TTY LANE_CFG LANE_CWD LANE_NAME <<EOF
$1
EOF
  LANE_REPO="$(_lanes_repo_of "$LANE_CWD")"
  _lanes_kind "$LANE_PID" "$LANE_TTY"
}

# lanes_match <target> [repo] → candidate rows for a `check <target>`: a lane
# name (session_is_profile_label), a live-session label / tmux session
# name from the registry, or a repo id (every lane's session in that repo).
# [repo] narrows a lane match. Prints nothing when nothing matches.
lanes_match() {
  local target="$1" repo="${2:-}" all row tmuxname panes ttyof tl rl
  tl="$(printf '%s' "$target" | tr '[:upper:]' '[:lower:]')"
  rl="$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')"
  all="$(lanes_candidates '*')"
  [ -n "$all" ] || return 0
  # shellcheck source=scripts/lib/session_registry.sh disable=SC1091
  type session_is_profile_label >/dev/null 2>&1 || . "$LANES_HERE/session_registry.sh"
  if session_is_profile_label "$tl"; then
      printf '%s\n' "$all" | while IFS= read -r row; do
        [ -n "$row" ] || continue
        [ "$(printf '%s' "$row" | cut -f5)" = "$tl" ] || continue
        if [ -n "$rl" ] && [ "$(_lanes_repo_of "$(printf '%s' "$row" | cut -f4)")" != "$rl" ]; then continue; fi
        printf '%s\n' "$row"
      done
      return 0
  fi
  # A registry label / tmux session name → that pane's tty.
  tmuxname=""
  if command -v session_registry_resolve >/dev/null 2>&1; then
    tmuxname="$(session_registry_resolve "$target" 2>/dev/null | cut -f5 || true)"
  fi
  [ -n "$tmuxname" ] || tmuxname="$target"
  panes="$(_lanes_tmux_panes)"
  ttyof="$(printf '%s\n' "$panes" | awk -v s="$tmuxname" '$3==s {print $1; exit}')"
  if [ -n "$ttyof" ]; then
    printf '%s\n' "$all" | awk -F'\t' -v t="$ttyof" '$2==t'
    return 0
  fi
  # Otherwise a repo id.
  printf '%s\n' "$all" | while IFS= read -r row; do
    [ -n "$row" ] || continue
    if [ "$(_lanes_repo_of "$(printf '%s' "$row" | cut -f4)")" = "$tl" ]; then printf '%s\n' "$row"; fi
  done
  return 0
}

# _lanes_kind <pid> <tty> → sets LANE_KIND / LANE_TMUX / LANE_TMUX_PANE
_lanes_kind() {
  local pid="$1" tty="$2" panes line p d=0 c
  LANE_KIND=unknown; LANE_TMUX=""; LANE_TMUX_PANE=""
  panes="$(_lanes_tmux_panes)"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if [ "${line%% *}" = "$tty" ]; then
      LANE_KIND=tmux; LANE_TMUX_PANE="$(printf '%s' "$line" | awk '{print $2}')"; LANE_TMUX="$(printf '%s' "$line" | awk '{print $3}')"
      return 0
    fi
  done <<EOF
$panes
EOF
  p="$pid"
  while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null && [ "$d" -lt 15 ]; do
    c="$(_lanes_comm "$p")"
    case "$c" in
      *iTerm*) LANE_KIND=iterm; return 0 ;;
      *Terminal.app*|*/Terminal) LANE_KIND=terminal; return 0 ;;
    esac
    p="$(_lanes_ppid "$p")"; d=$((d + 1))
  done
  return 0
}

# lanes_resolve <target> [repo] [pid] → 0 + LANE_* globals | 1 none |
# 3 ambiguous (candidates listed on stderr). <target> is anything lanes_match
# takes. With several matches and no repo/pid, the one in the caller's own
# repo wins.
lanes_resolve() {
  local target="$1" repo="${2:-}" want="${3:-}" rows n own best row self
  # shellcheck disable=SC2034  # LANE_* are the public result, read by callers
  LANE_NAME="" LANE_PID="" LANE_TTY="" LANE_CFG="" LANE_CWD="" LANE_REPO="" LANE_KIND="" LANE_TMUX="" LANE_TMUX_PANE=""
  rows="$(lanes_match "$target" "$repo")"
  # Never pick the calling session: resolve is for acting on ANOTHER session
  # (nudge / takeover / ping), so drop self before counting (PR #481 review).
  self="$(_lanes_self_pid)"
  if [ -n "$self" ]; then rows="$(printf '%s\n' "$rows" | awk -F'\t' -v p="$self" 'NF && $1!=p')"; fi
  if [ -n "$want" ]; then rows="$(printf '%s\n' "$rows" | awk -F'\t' -v p="$want" '$1==p')"; fi
  n="$(printf '%s' "$rows" | grep -c . || true)"
  if [ "$n" -gt 1 ] && [ -z "$repo" ] && [ -z "$want" ]; then
    own="$(_lanes_repo_of "$(pwd)")"
    best=""
    while IFS= read -r row; do
      [ -n "$row" ] || continue
      if [ "$(_lanes_repo_of "$(printf '%s' "$row" | cut -f4)")" = "$own" ]; then best="$best$row
"; fi
    done <<EOF
$rows
EOF
    if [ "$(printf '%s' "$best" | grep -c . || true)" = 1 ]; then rows="$best"; n=1; fi
  fi
  if [ "$n" = 0 ]; then
    echo "session_lanes: no live session matches '$target'${repo:+ in repo $repo}${want:+ with pid $want}" >&2
    return 1
  fi
  if [ "$n" -gt 1 ]; then
    echo "session_lanes: $n live sessions match '$target' — pick one with --repo <repo> or --pid <pid>:" >&2
    printf '%s\n' "$rows" | awk -F'\t' 'NF{printf "  pid %s  %-8s %s  %s\n", $1, $5, $2, $4}' >&2
    return 3
  fi
  lanes_load "$(printf '%s' "$rows" | grep . | head -1)"
  return 0
}

# ── screen ────────────────────────────────────────────────────────────────────
_LANES_AS_READ='on run argv
  set theTty to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) is theTty then return contents of s
        end repeat
      end repeat
    end repeat
  end tell
  return "__MYAI_NO_SESSION__"
end run'

# lanes_screen [lines] → the last N lines visible in the resolved session.
# Exit 1 when the terminal can't be read (Terminal.app / unknown / not found).
lanes_screen() {
  local lines="${1:-40}" out
  case "$LANE_KIND" in
    tmux)  out="$(tmux capture-pane -p -t "$LANE_TMUX_PANE" -S "-$lines" 2>/dev/null)" || return 1 ;;
    iterm)
      _lanes_iterm_running || return 1
      out="$(printf '%s\n' "$_LANES_AS_READ" | _lanes_osascript "$LANE_TTY")" || return 1
      [ "$out" = "__MYAI_NO_SESSION__" ] && return 1 ;;
    *) return 1 ;;
  esac
  # Drop trailing blank lines (an idle full-screen TUI pads with them), keep N.
  printf '%s\n' "$out" | awk '{a[NR]=$0} END {n=NR; while (n > 0 && a[n] ~ /^[[:space:]]*$/) n--; s=n-'"$lines"'+1; if (s < 1) s=1; for (i=s; i<=n; i++) print a[i]}'
}

# lanes_record_field <field> → one field of Claude's own per-process record,
# <cfg>/sessions/<pid>.json (fields include sessionId, status, cwd, name). It is
# the AUTHORITATIVE pid → conversation link and live state; it only counts when
# its pid and cwd match the resolved session (a reused pid never borrows a stale
# record). Prints nothing for agy or when there is no matching record.
lanes_record_field() {
  local f
  [ -n "$LANE_CFG" ] && [ "$LANE_CFG" != agy ] && [ -n "$LANE_PID" ] || return 0
  f="$LANE_CFG/sessions/$LANE_PID.json"
  [ -f "$f" ] || return 0
  /usr/bin/python3 - "$f" "$1" "$LANE_PID" "$LANE_CWD" <<'PY' 2>/dev/null || true
import json, sys
f, field, pid, cwd = sys.argv[1:5]
try:
    d = json.load(open(f))
except Exception:
    sys.exit(0)
# Both cwds must be known and equal: a pid alone could be a reused pid reading a
# stale record left by a crashed session (PR #483 review).
if str(d.get("pid")) != pid or not d.get("cwd") or not cwd or d.get("cwd") != cwd:
    sys.exit(0)
v = d.get(field)
if v is not None:
    print(v)
PY
}

# lanes_state [screen-text] → busy | idle | unknown. Combines Claude's own
# record status (busy | idle | shell …) with the screen footer:
#   • a busy screen always wins — the record cannot see a permission/question
#     prompt, and typing into one would answer it;
#   • record busy / shell / anything not "idle" → busy (never type into it);
#   • record idle → idle; no record (agy) → the screen verdict.
lanes_state() {
  local scr rec
  scr="$(lanes_busy_verdict "${1:-}")"
  [ "$scr" = busy ] && { echo busy; return 0; }
  rec="$(lanes_record_field status)"
  case "$rec" in
    idle) echo idle ;;
    "") echo "$scr" ;;
    *) echo busy ;;
  esac
}

# lanes_busy_verdict <screen-text> → busy | idle | unknown. Claude Code shows
# "esc to interrupt" mid-turn, agy "esc to cancel". A permission / question
# prompt ("Esc to cancel", "Do you want to …", a "❯ 1." menu) is BUSY too:
# typed text + Enter there would answer the prompt (PR #481 review).
lanes_busy_verdict() {
  # Only the footer counts: the marker sits in the last few lines while a turn
  # runs, and scrollback above can still carry an old one (verified on agy).
  local tail8
  tail8="$(printf '%s\n' "$1" | awk 'NF' | tail -n 8)"
  [ -n "$1" ] || { echo unknown; return 0; }
  tail8="$(printf '%s' "$tail8" | tr '[:upper:]' '[:lower:]')"
  case "$tail8" in
    *"esc to interrupt"*|*"esc to cancel"*|*"do you want to"*|*"❯ 1."*|*"enter to confirm"*|*"(y/n)"*) echo busy ;;
    *) echo idle ;;
  esac
}

# lanes_input_has <text> [screen] → 0 when <text> is still sitting UNSUBMITTED
# in the session's input box. Only the LAST "> …" / "❯ …" line on screen counts:
# Claude echoes a SUBMITTED prompt as "> text" in the transcript above the box,
# so earlier prompt-looking lines are history, not the input (PR #485 review).
# Locale-safe: leading "│" / whitespace stripped with sed literals and the
# prefix found with index(), never a bracket expression holding a multibyte
# char (BSD awk in the C locale mangles "❯" there).
lanes_input_has() {
  local needle scr last
  needle="$(printf '%s' "$1" | cut -c1-30)"
  [ -n "$needle" ] || return 1
  scr="${2-$(lanes_screen 40 2>/dev/null || true)}"
  last="$(printf '%s\n' "$scr" | awk 'NF' | tail -n 12 \
    | sed -e 's/^[[:space:]]*//' -e 's/^│[[:space:]]*//' \
    | awk 'index($0, "> ") == 1 || index($0, "❯") == 1 { l = $0 } END { print l }')"
  [ -n "$last" ] || return 1
  case "$last" in *"$needle"*) return 0 ;; esac
  return 1
}

# _lanes_submit_once → press Enter once in the resolved session (retry path).
_lanes_submit_once() {
  case "$LANE_KIND" in
    tmux) tmux send-keys -t "$LANE_TMUX_PANE" Enter 2>/dev/null ;;
    iterm) _iterm_write_raw "$LANE_TTY" "" yes ;;
    *) return 1 ;;
  esac
}

# lanes_type <text> → types <text> into the resolved session, submits it, and
# VERIFIES the submit took. 0 submitted | 1 not reachable | 5 STRANDED (the text
# is still sitting in the input box after one retry — the caller must alert the
# coordinator: a session with unsubmitted text looks busy and every later ping
# is skipped; 2026-10-03, tech went dark ~45 min that way). Callers own the busy
# / self checks. LANES_VERIFY_WAIT (default 1s) is the settle time per check.
# Residual risk (documented): a permission menu that appears in the instant
# between the idle re-check and the retry Enter could still be answered.
lanes_type() {
  local text="$1" wait="${LANES_VERIFY_WAIT:-1}" scr rc
  case "$LANE_KIND" in
    iterm)
      # ONE AppleScript layer (scripts/lib/iterm_tab.sh): type with newline NO,
      # separate Enter, re-read, one more Enter if the text is still in the box.
      ITERM_VERIFY_WAIT="$wait" iterm_write_tab "$LANE_TTY" "$text" "${LANES_SUBMIT_DELAY:-1.2}"; rc=$?
      case "$rc" in 0) return 0 ;; 5) return 5 ;; *) return 1 ;; esac ;;
    tmux)
      tmux send-keys -t "$LANE_TMUX_PANE" -l "$text" 2>/dev/null || return 1
      tmux send-keys -t "$LANE_TMUX_PANE" Enter 2>/dev/null || return 1 ;;
    *) return 1 ;;
  esac
  # tmux: a running turn means it was submitted; otherwise the text must have
  # left the input box.
  _lanes_sleep "$wait"
  scr="$(lanes_screen 40 2>/dev/null || true)"
  [ "$(lanes_state "$scr")" = busy ] && return 0
  lanes_input_has "$text" "$scr" || return 0
  # Still sitting in an idle session's box: retry the submit ONCE (the idle
  # check above means no prompt is showing that our Enter could answer).
  _lanes_submit_once || true
  _lanes_sleep "$wait"
  scr="$(lanes_screen 40 2>/dev/null || true)"
  [ "$(lanes_state "$scr")" = busy ] && return 0
  lanes_input_has "$text" "$scr" || return 0
  return 5
}

# lanes_is_self → 0 when the resolved session is the one running this shell.
lanes_is_self() { [ -n "$LANE_PID" ] && [ "$(_lanes_self_pid)" = "$LANE_PID" ]; }

# ── conversation activity (Claude lanes) ──────────────────────────────────────
# lanes_project_dir → <cfg>/projects/<slug>, slug = cwd with every
# non-alphanumeric character replaced by '-' (Claude Code's convention).
lanes_project_dir() {
  [ -n "$LANE_CFG" ] && [ "$LANE_CFG" != agy ] || return 1
  printf '%s/projects/%s' "$LANE_CFG" "$(printf '%s' "$LANE_CWD" | sed 's/[^A-Za-z0-9]/-/g')"
}

# lanes_transcript → newest *.jsonl for the session's project (empty if none).
lanes_transcript() {
  local dir sid
  dir="$(lanes_project_dir)" || return 0
  [ -d "$dir" ] || return 0
  # Exact: the record names this pid's conversation (sessions/<pid>.json).
  sid="$(lanes_record_field sessionId)"
  if [ -n "$sid" ]; then
    # The record is authoritative: its conversation, or nothing. Never fall back
    # to the newest file — that may be ANOTHER session's (PR #483 review: a fresh
    # or just-/cleared session has no transcript yet).
    if [ -f "$dir/$sid.jsonl" ]; then printf '%s\n' "$dir/$sid.jsonl"; fi
    return 0
  fi
  # shellcheck disable=SC2012  # ls -t is the portable newest-first on macOS
  ls -t "$dir"/*.jsonl 2>/dev/null | head -1 || true
}

# lanes_transcript_shared → how many OTHER live sessions use the same config dir
# + cwd. Claude does not hold its transcript open, so the newest *.jsonl is only
# THIS pid's when nobody else shares the project folder (PR #481 review): with
# sharing, session id / idle age / actions may belong to another session.
lanes_transcript_shared() {
  [ -n "$LANE_CFG" ] && [ "$LANE_CFG" != agy ] || { echo 0; return 0; }
  # With a matching record the transcript is known exactly — nothing is shared.
  if [ -n "$(lanes_record_field sessionId)" ]; then echo 0; return 0; fi
  lanes_candidates '*' | awk -F'\t' -v c="$LANE_CFG" -v d="$LANE_CWD" -v p="$LANE_PID" '$3==c && $4==d && $1!=p {n++} END {print n+0}'
}

# lanes_session_id → the transcript's session id (its basename), for --resume.
lanes_session_id() {
  local sid t
  sid="$(lanes_record_field sessionId)"
  if [ -n "$sid" ]; then printf '%s\n' "$sid"; return 0; fi
  t="$(lanes_transcript)"; [ -n "$t" ] && basename "$t" .jsonl
}

# lanes_idle_seconds → seconds since the transcript was last written.
lanes_idle_seconds() {
  local t m now
  t="$(lanes_transcript)"; [ -n "$t" ] || return 1
  m="$(stat -c %Y "$t" 2>/dev/null || stat -f %m "$t" 2>/dev/null)" || return 1  # GNU first (AI_RULES §4)
  now="$(date +%s)"; printf '%s' "$((now - m))"
}

# lanes_context_pct → context-window use of the session's last turn, as an
# integer %. Same estimate as the Claude status line (~/.claude-org-statusline.sh):
# input + cache_creation + cache_read + output tokens of the last assistant
# turn, over 1M for Claude 5-family models else 200k (MYAI_CONTEXT_WINDOW_TOKENS
# overrides). Prints nothing when unknown (agy, no transcript yet).
lanes_context_pct() {
  local t
  t="$(lanes_transcript)"; [ -n "$t" ] || return 0
  /usr/bin/python3 - "$t" <<'PY' 2>/dev/null || true
import json, os, sys
p = sys.argv[1]
size = os.path.getsize(p)
with open(p, "rb") as f:
    f.seek(max(0, size - 400_000)); data = f.read()
for raw in reversed(data.split(b"\n")):
    if b'"type":"assistant"' not in raw: continue
    try: o = json.loads(raw)
    except Exception: continue
    m = o.get("message") or {}; u = m.get("usage") or {}
    if not u: continue
    used = sum((u.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"))
    ov = os.environ.get("MYAI_CONTEXT_WINDOW_TOKENS", "")
    model = (m.get("model") or "").lower()
    win = int(ov) if ov.isdigit() else (1_000_000 if any(t in model for t in ("sonnet-5", "opus-5", "fable-5")) else 200_000)
    print(int(round(max(0.0, min(100.0, used / win * 100)))))
    break
PY
}

# lanes_recent_actions [n] → the last n user prompts / tool calls / replies.
lanes_recent_actions() {
  local n="${1:-10}" t
  t="$(lanes_transcript)"; [ -n "$t" ] || return 0
  tail -n 400 "$t" | /usr/bin/python3 -c '
import json, sys
n = int(sys.argv[1]); out = []
def clip(s, k=110):
    s = " ".join(str(s).split()); return s if len(s) <= k else s[:k-1] + "…"
for line in sys.stdin:
    try: e = json.loads(line)
    except Exception: continue
    m = e.get("message") or {}
    c = m.get("content")
    if e.get("type") == "user" and isinstance(c, str) and c.strip():
        out.append("user   " + clip(c))
    elif e.get("type") == "assistant" and isinstance(c, list):
        for it in c:
            if it.get("type") == "tool_use":
                i = it.get("input") or {}
                arg = i.get("description") or i.get("command") or i.get("file_path") or i.get("pattern") or ""
                out.append("tool   " + it.get("name", "?") + (": " + clip(arg, 90) if arg else ""))
            elif it.get("type") == "text" and it.get("text", "").strip():
                out.append("reply  " + clip(it["text"]))
for l in out[-n:]: print(l)
' "$n" 2>/dev/null || true
}
