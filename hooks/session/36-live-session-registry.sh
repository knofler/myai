#!/usr/bin/env bash
# 36-live-session-registry.sh — register THIS session in the live-session
# registry at session start, so `tell <label>` / session_ping.sh can wake it.
#
# Companion to the mail-live hook (hooks/mail-live.sh): the mailbox is how a
# message is DELIVERED durably; the registry is how a director finds the tmux
# pane to inject a live "check mail <id>" into an idle peer. See
# scripts/lib/session_registry.sh for the row format and the account-isolation
# rationale (two lanes on different accounts can't SendMessage each other; the
# mailbox can).
#
# Writes exactly one row (upsert by pid). Silent, best-effort, always exit 0 —
# a registry write must never slow or break a session start. bash 3.2-safe.
set +e

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

for _lib in "$ROOT/scripts/lib/session_registry.sh" "$ROOT/AI/scripts/lib/session_registry.sh"; do
  # shellcheck source=/dev/null
  [ -f "$_lib" ] && . "$_lib" && break
done
command -v session_registry_write >/dev/null 2>&1 || exit 0

for _ridlib in "$ROOT/scripts/lib/repo_id.sh" "$ROOT/AI/scripts/lib/repo_id.sh"; do
  # shellcheck source=/dev/null
  [ -f "$_ridlib" ] && . "$_ridlib" && break
done
if command -v canonical_repo_id >/dev/null 2>&1; then
  REPO=$(canonical_repo_id "$ROOT")
else
  REPO=$(basename "$ROOT")
fi
REPO=$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')
HOST=$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')

# Profile (account lane) from CLAUDE_CONFIG_DIR, same derivation remote_fleet.sh
# uses: ~/.claude → default, ~/.claude-<lane> → <lane>.
PROFILE=default
case "${CLAUDE_CONFIG_DIR:-}" in
  */.claude-*) PROFILE="${CLAUDE_CONFIG_DIR##*/.claude-}" ;;
esac
command -v session_profile >/dev/null 2>&1 && PROFILE="$(session_profile)"

# tmux session name — ONLY set when we are actually inside a tmux pane, because
# a non-tmux tty cannot be live-injected (macOS blocks TIOCSTI). An empty
# tmux_session makes session_registry_resolve correctly skip this row as a
# live-wake target while the mailbox still delivers on next prompt/boot.
TMUX_SESSION=""
if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
  TMUX_SESSION="$(tmux display-message -p '#S' 2>/dev/null)"
fi

# label: the tmux session name when we have one (what remote_fleet.sh names the
# doorway), else the "<device> - <repo>" handle the alias wrapper labels with.
if [ -n "$TMUX_SESSION" ]; then
  LABEL="$TMUX_SESSION"
else
  LABEL="${REMOTE_FLEET_DEVICE:-$(hostname -s)} - $(basename "$ROOT")"
fi

# pid: the claude process that owns this session (liveness probe). Walk up the
# ancestor chain from the hook's own pid to the first process named claude;
# fall back to the tmux pane pid, then $PPID.
CLAUDE_PID=""
_p=$$
_depth=0
while [ -n "$_p" ] && [ "$_p" -gt 1 ] 2>/dev/null && [ "$_depth" -lt 12 ]; do
  _cmd="$(ps -o command= -p "$_p" 2>/dev/null)"
  case "$_cmd" in
    */claude|claude|*/claude\ *|claude\ *) CLAUDE_PID="$_p"; break ;;
  esac
  _p="$(ps -o ppid= -p "$_p" 2>/dev/null | tr -d ' ')"
  _depth=$((_depth + 1))
done
if [ -z "$CLAUDE_PID" ] && [ -n "$TMUX_SESSION" ]; then
  CLAUDE_PID="$(tmux display-message -p '#{pane_pid}' 2>/dev/null)"
fi
[ -n "$CLAUDE_PID" ] || CLAUDE_PID="$PPID"

ADDRESS="$HOST/$REPO"

session_registry_write "$LABEL" "$PROFILE" "$REPO" "$HOST" "$TMUX_SESSION" "$CLAUDE_PID" "$ADDRESS"
exit 0
