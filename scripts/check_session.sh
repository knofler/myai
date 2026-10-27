#!/usr/bin/env bash
# check_session.sh — the `check <target>` keyword (alias: `peek <target>`):
# a short, phone-relayable status of a live session on this Mac.
#
#   check <lane>                    a lane's session (e.g. check agy)
#   check <repo>                    every live session working in that repo
#   check <label>                   a live-session label / tmux session name
#
# Shows busy/idle (+ idle age), context %, and the last ~10 actions from the
# session's own transcript. One match → full status; several → one line each.
# `check bugs` / `check features` / `check mail` are existing keywords and are
# refused here. Read-only: never types into or signals a session.
#
# Usage: check_session.sh <target> [--repo R] [--pid P] [--actions N] [--screen [N]]
# Spec: plan/SESSION_TAKEOVER_SPEC.md. bash 3.2-safe; runs under set -euo pipefail.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib/session_registry.sh"
# shellcheck source=/dev/null
. "$HERE/lib/session_lanes.sh"

# check_age <seconds> → 45s | 3m05s | 2h13m | 3d4h
check_age() {
  local s="$1"
  if [ "$s" -lt 60 ]; then printf '%ss' "$s"
  elif [ "$s" -lt 3600 ]; then printf '%dm%02ds' $((s / 60)) $((s % 60))
  elif [ "$s" -lt 86400 ]; then printf '%dh%02dm' $((s / 3600)) $((s % 3600 / 60))
  else printf '%dd%dh' $((s / 86400)) $((s % 86400 / 3600)); fi
}

# check_state → "BUSY|IDLE|?" from the screen when readable, else from how
# recently the transcript was written (≤20s = busy).
check_state() {
  local screen idle v
  screen="$(lanes_screen 30 2>/dev/null || true)"
  v="$(lanes_state "$screen")"   # record status + screen (session_lanes.sh)
  if [ "$v" = unknown ]; then
    idle="$(lanes_idle_seconds 2>/dev/null || true)"
    if [ -n "$idle" ] && [ "$idle" -le 20 ]; then v=busy; elif [ -n "$idle" ]; then v=idle; fi
  fi
  case "$v" in busy) echo BUSY ;; idle) echo IDLE ;; *) echo "?" ;; esac
}

check_summary_line() { # one line per session (multi-match view)
  local idle ctx
  idle="$(lanes_idle_seconds 2>/dev/null || true)"
  ctx="$(lanes_context_pct 2>/dev/null || true)"
  printf '  %-8s pid %-6s %-6s %-16s %-4s %s%s\n' "$LANE_NAME" "$LANE_PID" "$LANE_KIND" "$LANE_REPO" \
    "$(check_state)" "${idle:+$(check_age "$idle")}" "${ctx:+  ctx ${ctx}%}"
}

# check_claims → "repo:path, …" — the claims (scripts/claim.sh) held by the
# resolved session (holder <host>/<lane>/<pid>). Empty when none, or when the
# gateway is slow/down (2s budget). Stubbable.
check_claims() {
  [ -f "$HERE/lib/claims.sh" ] || return 0
  (
    # shellcheck source=/dev/null
    . "$HERE/lib/claims.sh"
    KL_TIMEOUT=2 cl_holder_claims "$(kl_host)/$LANE_NAME/$LANE_PID"
  ) 2>/dev/null || true
}

check_full() { # full status for one session
  local actions="$1" screen_n="$2" idle ctx sid where shared claims
  idle="$(lanes_idle_seconds 2>/dev/null || true)"
  ctx="$(lanes_context_pct 2>/dev/null || true)"
  sid="$(lanes_session_id 2>/dev/null || true)"
  where="$LANE_KIND"; [ -n "$LANE_TMUX" ] && where="tmux $LANE_TMUX"
  echo "CHECK $LANE_NAME · $LANE_REPO · pid $LANE_PID · $where ${LANE_TTY#/dev/}$(lanes_is_self && echo ' · (this session)' || true)"
  echo "  state: $(check_state)${idle:+ · last activity $(check_age "$idle") ago}${ctx:+ · ctx ${ctx}%}${sid:+ · session ${sid%%-*}}"
  claims="$(check_claims)"
  if [ -n "$claims" ]; then echo "  active claims: $claims"; fi
  shared="$(lanes_transcript_shared)"
  if [ "${shared:-0}" -gt 0 ]; then
    echo "  ⚠ $shared other live session(s) share this project folder — activity, ctx and session id may be theirs"
  fi
  if [ "$LANE_NAME" = agy ]; then
    echo "  (agy keeps no Claude transcript — screen below)"
    [ "$screen_n" -gt 0 ] || screen_n=15
  else
    echo "  last $actions:"
    lanes_recent_actions "$actions" | sed 's/^/    /'
  fi
  if [ "$screen_n" -gt 0 ]; then
    echo "  screen:"
    lanes_screen "$screen_n" 2>/dev/null | sed 's/^/    | /' || echo "    (screen not readable for a $LANE_KIND session)"
  fi
}

main() {
  local target="" repo="" pid="" actions=10 screen_n=0 rows n row
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) repo="${2:?--repo needs a value}"; shift 2 ;;
      --pid) pid="${2:?--pid needs a value}"; shift 2 ;;
      --actions) actions="${2:?--actions needs a value}"; shift 2 ;;
      --screen) if [ $# -ge 2 ] && [ "${2#-}" = "$2" ] && [ "$2" -eq "$2" ] 2>/dev/null; then screen_n="$2"; shift 2; else screen_n=20; shift; fi ;;
      -h|--help) sed -n '2,16p' "$0"; return 0 ;;
      *) target="$1"; shift ;;
    esac
  done
  [ -n "$target" ] || { sed -n '2,16p' "$0" >&2; return 2; }
  case "$(printf '%s' "$target" | tr '[:upper:]' '[:lower:]')" in
    bugs|features|mail)
      echo "check: 'check $target' is the existing keyword — not a session lookup" >&2; return 2 ;;
  esac
  rows="$(lanes_match "$target" "$repo")"
  if [ -n "$pid" ]; then rows="$(printf '%s\n' "$rows" | awk -F'\t' -v p="$pid" '$1==p')"; fi
  n="$(printf '%s' "$rows" | grep -c . || true)"
  if [ "$n" = 0 ]; then
    echo "check: no live session matches '$target'${repo:+ in repo $repo}${pid:+ (pid $pid)} on $(hostname -s)"
    return 1
  fi
  if [ "$n" = 1 ]; then
    lanes_load "$(printf '%s' "$rows" | grep . | head -1)"
    check_full "$actions" "$screen_n"
    return 0
  fi
  echo "CHECK $target — $n live sessions on $(hostname -s)"
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    lanes_load "$row"
    check_summary_line
  done <<EOF
$rows
EOF
  echo "  → details: check $target --pid <pid>   (or --repo <repo>)"
}

# CHECK_LIB_ONLY=1: load the functions only (hermetic suites stub the OS calls).
[ -n "${CHECK_LIB_ONLY:-}" ] || main "$@"
