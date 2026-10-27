#!/usr/bin/env bash
# takeover.sh — the `takeover <target>` keyword: move a stuck or abandoned
# Claude session into a phone-drivable tmux session, same conversation, same
# account (the lane's own CLAUDE_CONFIG_DIR, so its own billing).
#
#   1. check   — resolve the session; read state, idle age, session id.
#   2. gate    — eligible only when idle ≥ --idle-min (default 10), or a nudge
#                (--nudge-id) is still unacked after --ack-min (default 5), or --force.
#   3. snapshot — state/takeover/<ts>-<lane>-<repo>/: diff.patch (git diff HEAD),
#                untracked.txt, note.md (screen, last actions, resume command).
#   4. PLAN ONLY unless --confirm: prints what step 5–6 would do and exits 3.
#   5. --confirm: SIGINT the pid (twice, then SIGTERM) and wait for it to exit —
#                never two live processes on one conversation.
#   6. --confirm: `claude --resume <session-id>` in tmux myai-takeover-<lane>-<repo>
#                with --remote-control "<host> - <repo> (takeover)"; verified by
#                tmux has-session + a non-empty pane, never by exit code.
#
# agy sessions are not taken over: they already run in tmux with remote control
# (check agy / nudge agy, or tmux attach). Never acts on the session running it.
#
# Usage: takeover.sh <target> [--repo R] [--pid P] [--idle-min N]
#                    [--nudge-id <mail-id> [--ack-min M]] [--session <id>] [--force] [--confirm]
#   --session <id>  only needed when Claude's own record (<cfg>/sessions/<pid>.json,
#                   which names each pid's conversation) is missing AND another live
#                   session shares this one's config dir + repo — then the newest
#                   transcript could be the OTHER session's (check <target> shows it).
# Spec: plan/SESSION_TAKEOVER_SPEC.md. bash 3.2-safe; runs under set -euo pipefail.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib/session_registry.sh"
# shellcheck source=/dev/null
. "$HERE/lib/session_lanes.sh"

TAKEOVER_DIR="${TAKEOVER_DIR:-$ROOT/state/takeover}"
TAKEOVER_EXIT_WAIT="${TAKEOVER_EXIT_WAIT:-10}"
TAKEOVER_START_WAIT="${TAKEOVER_START_WAIT:-6}"

# ── stubbable touchpoints ─────────────────────────────────────────────────────
_takeover_alive() { kill -0 "$1" 2>/dev/null; }
_takeover_signal() { kill "-$1" "$2" 2>/dev/null; }
_takeover_claude_bin() { command -v claude 2>/dev/null || echo "$HOME/.local/bin/claude"; }
# _takeover_mail_unacked_age <addr> <mail-id> → seconds since it was sent when
# it is still unacked in <addr>'s inbox; nothing otherwise.
_takeover_mail_unacked_age() {
  local addr="$1" id="$2" token resp
  for _gwlib in "$ROOT/scripts/lib/gateway.sh" "$ROOT/AI/scripts/lib/gateway.sh"; do
    # shellcheck source=/dev/null
    [ -f "$_gwlib" ] && . "$_gwlib" && break
  done
  token="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
  resp="$(curl -sf -m 5 -X POST "http://localhost:${MCP_PORT:-3100}/mcp" -H 'content-type: application/json' \
    -H "x-gateway-local-token: $token" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"mail_inbox\",\"arguments\":{\"to\":\"$addr\"}}}" 2>/dev/null)" || return 0
  printf '%s' "$resp" | ID="$id" /usr/bin/python3 -c '
import json, os, sys, datetime
try:
    d = json.loads(json.loads(sys.stdin.read())["result"]["content"][0]["text"])
except Exception:
    sys.exit(0)
for m in d.get("messages", []):
    if m.get("messageId") == os.environ["ID"] and not m.get("acked"):
        t = datetime.datetime.fromisoformat(m["createdAt"].replace("Z", "+00:00"))
        print(int((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()))
' 2>/dev/null || true
}

main() {
  local target="" repo="" pid="" idle_min=10 nudge_id="" ack_min=5 force=0 confirm=0 rc=0 want_sid="" shared screen verdict t m skip args
  local idle sid host why age snap ts tmux_name label cmd pane i
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) repo="${2:?--repo needs a value}"; shift 2 ;;
      --pid) pid="${2:?--pid needs a value}"; shift 2 ;;
      --idle-min) idle_min="${2:?--idle-min needs a value}"; shift 2 ;;
      --nudge-id) nudge_id="${2:?--nudge-id needs a value}"; shift 2 ;;
      --ack-min) ack_min="${2:?--ack-min needs a value}"; shift 2 ;;
      --force) force=1; shift ;;
      --session) want_sid="${2:?--session needs a value}"; shift 2 ;;
      --confirm) confirm=1; shift ;;
      -h|--help) sed -n '2,25p' "$0"; return 0 ;;
      *) target="$1"; shift ;;
    esac
  done
  [ -n "$target" ] || { sed -n '2,25p' "$0" >&2; return 2; }

  # 1. check
  lanes_resolve "$target" "$repo" "$pid" || { rc=$?; return "$rc"; }
  if lanes_is_self; then echo "takeover: '$target' is this very session (pid $LANE_PID) — refusing" >&2; return 2; fi
  if [ "$LANE_NAME" = agy ]; then
    echo "takeover: agy sessions already run in tmux with remote control — use check agy / nudge agy, or: tmux attach -t ${LANE_TMUX:-myai-agy-$LANE_REPO}" >&2
    return 2
  fi
  # Which conversation is this pid's? Only certain when no other live session
  # shares the project folder (PR #481 review: resuming the wrong one would put
  # two processes on one conversation).
  shared="$(lanes_transcript_shared)"
  if [ -n "$want_sid" ]; then
    t="$(lanes_project_dir)/$want_sid.jsonl"
    [ -f "$t" ] || { echo "takeover: no transcript $want_sid under $(lanes_project_dir)" >&2; return 1; }
    sid="$want_sid"
    m="$(stat -c %Y "$t" 2>/dev/null || stat -f %m "$t" 2>/dev/null || echo 0)"
    idle=$(( $(date +%s) - m ))
  else
    if [ "$shared" -gt 0 ]; then
      echo "takeover: $shared other live session(s) share $LANE_NAME's project folder ($LANE_REPO) — cannot tell which conversation is pid $LANE_PID's. Pick it explicitly: --session <id> (transcripts: $(lanes_project_dir))." >&2
      return 2
    fi
    sid="$(lanes_session_id 2>/dev/null || true)"
    [ -n "$sid" ] || { echo "takeover: no transcript found for pid $LANE_PID under $(lanes_project_dir 2>/dev/null) — cannot resume it" >&2; return 1; }
    # The conversation must exist on disk BEFORE anything is stopped: a fresh or
    # just-/cleared session has a session id but no transcript, and killing it
    # would leave nothing to resume (PR #483 review).
    if [ ! -f "$(lanes_project_dir)/$sid.jsonl" ]; then
      echo "takeover: pid $LANE_PID's conversation $sid has no transcript yet ($(lanes_project_dir)) — nothing to resume; not touching it" >&2
      return 1
    fi
    idle="$(lanes_idle_seconds 2>/dev/null || echo 0)"
  fi
  # A readable screen that shows a turn or a prompt in progress is never idle,
  # whatever the transcript age (a long Bash call writes nothing for minutes).
  screen="$(lanes_screen 30 2>/dev/null || true)"
  verdict="$(lanes_state "$screen")"   # record status + screen footer
  host="$(hostname -s 2>/dev/null)"

  # 2. gate
  why=""
  if [ "$idle" -ge $((idle_min * 60)) ] && [ "$verdict" != busy ]; then why="idle ${idle}s ≥ ${idle_min}m"; fi
  if [ -z "$why" ] && [ -n "$nudge_id" ]; then
    age="$(_takeover_mail_unacked_age "$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')/$LANE_NAME" "$nudge_id")"
    if [ -n "$age" ] && [ "$age" -ge $((ack_min * 60)) ] && [ "$verdict" != busy ]; then why="nudge $nudge_id unacked for ${age}s ≥ ${ack_min}m"; fi
  fi
  if [ -z "$why" ] && [ "$force" = 1 ]; then why="--force"; fi
  if [ -z "$why" ]; then
    echo "takeover: $LANE_NAME ($LANE_REPO, pid $LANE_PID) is active (last write ${idle}s ago${verdict:+, screen $verdict}) — not eligible. Nudge it first (nudge $target …), then pass --nudge-id <mail-id>, or --force."
    return 4
  fi

  # 3. snapshot (always — it is the record of what was there)
  ts="$(date +%Y%m%d-%H%M%S)"
  snap="$TAKEOVER_DIR/$ts-$LANE_NAME-$LANE_REPO"
  mkdir -p "$snap"
  git -C "$LANE_CWD" diff HEAD > "$snap/diff.patch" 2>/dev/null || true
  git -C "$LANE_CWD" ls-files --others --exclude-standard > "$snap/untracked.txt" 2>/dev/null || true
  tmux_name="myai-takeover-$LANE_NAME-$LANE_REPO"
  label="$host - $LANE_REPO (takeover)"
  # Same permission mode as the session being replaced (never escalate), and
  # every value %q-quoted so a quote in a path, id or label cannot break out.
  args="$(_lanes_ps | awk -v p="$LANE_PID" '$1==p {$1=""; $2=""; print; exit}')"
  skip=""
  case " $args " in *" --dangerously-skip-permissions "*) skip=" --dangerously-skip-permissions" ;; esac
  cmd="unset ANTHROPIC_API_KEY; export CLAUDE_CONFIG_DIR=$(printf '%q' "$LANE_CFG"); exec $(printf '%q' "$(_takeover_claude_bin)") --resume $(printf '%q' "$sid")$skip --remote-control $(printf '%q' "$label")"
  {
    echo "# Takeover snapshot — $LANE_NAME / $LANE_REPO ($ts)"
    echo "- pid $LANE_PID · $LANE_KIND ${LANE_TMUX:-$LANE_TTY} · cwd \`$LANE_CWD\`"
    echo "- session \`$sid\` · config \`$LANE_CFG\` · reason: $why"
    echo "- git: $(git -C "$LANE_CWD" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?') @ $(git -C "$LANE_CWD" rev-parse --short HEAD 2>/dev/null || echo '?'); diff.patch $(wc -l < "$snap/diff.patch" | tr -d ' ') lines; $(wc -l < "$snap/untracked.txt" | tr -d ' ') untracked"
    echo "- resume: \`tmux new-session -d -s $tmux_name -c $(printf '%q' "$LANE_CWD") \"$cmd\"\`"
    echo; echo "## Last actions"; lanes_recent_actions 15 | sed 's/^/    /'
    echo; echo "## Screen"; lanes_screen 40 2>/dev/null | sed 's/^/    /' || echo "    (not readable)"
  } > "$snap/note.md"
  echo "takeover: snapshot → ${snap#"$ROOT"/}"

  # 4. plan only
  if [ "$confirm" != 1 ]; then
    echo "takeover PLAN for $LANE_NAME ($LANE_REPO) — eligible: $why"
    echo "  stop:   SIGINT pid $LANE_PID (×2, then SIGTERM), wait for it to exit"
    echo "  resume: claude --resume $sid in tmux $tmux_name, on the phone as \"$label\""
    echo "  → run again with --confirm to do it"
    return 3
  fi

  # 5. stop the old process — never two live processes on one conversation
  if tmux has-session -t "$tmux_name" 2>/dev/null; then
    echo "takeover: tmux $tmux_name already exists — attach to it instead (tmux attach -t $tmux_name)" >&2
    return 1
  fi
  for sig in INT INT TERM; do
    _takeover_alive "$LANE_PID" || break
    _takeover_signal "$sig" "$LANE_PID" || true
    i=0
    while _takeover_alive "$LANE_PID" && [ "$i" -lt "$TAKEOVER_EXIT_WAIT" ]; do _lanes_sleep 1; i=$((i + 1)); done
  done
  if _takeover_alive "$LANE_PID"; then
    echo "takeover: pid $LANE_PID did not exit after SIGINT×2 + SIGTERM — NOT resuming (two processes on one conversation would corrupt it). Snapshot kept." >&2
    return 1
  fi
  echo "takeover: pid $LANE_PID stopped"

  # 6. resume in a phone-drivable tmux session, then prove it
  tmux new-session -d -s "$tmux_name" -c "$LANE_CWD" "$cmd" || { echo "takeover: tmux new-session failed — resume by hand: see ${snap#"$ROOT"/}/note.md" >&2; return 1; }
  _lanes_sleep "$TAKEOVER_START_WAIT"
  pane="$(tmux capture-pane -p -t "$tmux_name" 2>/dev/null | grep -c . || true)"
  if tmux has-session -t "$tmux_name" 2>/dev/null && [ "${pane:-0}" -gt 0 ]; then
    echo "takeover: DONE — conversation $sid resumed in tmux $tmux_name"
    echo "  phone: \"$label\" in the Claude app's Code list · here: tmux attach -t $tmux_name"
    return 0
  fi
  echo "takeover: tmux $tmux_name did not come up with a live pane — resume by hand: see ${snap#"$ROOT"/}/note.md" >&2
  return 1
}

# TAKEOVER_LIB_ONLY=1: load the functions only (hermetic suites stub the OS calls).
[ -n "${TAKEOVER_LIB_ONLY:-}" ] || main "$@"
