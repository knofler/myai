#!/usr/bin/env bash
set +e
# Hook: Handoff Staleness — session-close LOUD red (AI_RULES §15)
# Event: Stop
#
# The last line of defence for checkpoint-as-you-go. If the session is ending
# with an unsaved handoff AND there is real work to lose (dirty tree or unpushed
# commits), shout in red so the close-out ritual is never skipped silently.
# Companion to hooks/post-tool/06 (mid-session throttled box). Warn-only.
# bash 3.2 safe.

command -v jq >/dev/null 2>&1 || exit 0

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
if [ -f "$ROOT/config/session-limits.json" ]; then
  AIDIR="$ROOT"
elif [ -f "$ROOT/AI/config/session-limits.json" ]; then
  AIDIR="$ROOT/AI"
else
  exit 0
fi
CONFIG="$AIDIR/config/session-limits.json"
HANDOFF="$AIDIR/state/AI_AGENT_HANDOFF.md"
LIB="$AIDIR/scripts/lib/autosave.sh"

[ -f "$HANDOFF" ] || exit 0
[ -f "$LIB" ] || exit 0
. "$LIB"

[ "$(jq -r '.autosave.enabled // false' "$CONFIG" 2>/dev/null)" = "true" ] || exit 0
STALE_MIN=$(jq -r '.autosave.stale_minutes // 30' "$CONFIG" 2>/dev/null)
echo "$STALE_MIN" | grep -qE '^[0-9]+$' || STALE_MIN=30
STALE_SEC=$(( STALE_MIN * 60 ))

NOW=$(date +%s)
HMTIME=$(stat -f "%m" "$HANDOFF" 2>/dev/null || stat -c "%Y" "$HANDOFF" 2>/dev/null)
echo "$HMTIME" | grep -qE '^[0-9]+$' || exit 0

[ "$(autosave_stop_stale "$NOW" "$HMTIME" "$STALE_SEC")" = "STALE" ] || exit 0

# Only shout if there is something to lose: uncommitted changes or unpushed commits.
dirty=$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
unpushed=""
branch=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ -n "$branch" ] && git -C "$ROOT" rev-parse --verify "@{u}" >/dev/null 2>&1; then
  unpushed=$(git -C "$ROOT" rev-list --count '@{u}..HEAD' 2>/dev/null)
fi
: "${dirty:=0}"; : "${unpushed:=0}"
[ "$dirty" -eq 0 ] && [ "$unpushed" -eq 0 ] && exit 0

age_min=$(( (NOW - HMTIME) / 60 ))
echo ""
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
echo "  HANDOFF STALE AT SESSION CLOSE — ${age_min}m old (AI_RULES §15)"
echo "  Unsaved work: ${dirty} uncommitted file(s), ${unpushed} unpushed commit(s)."
echo ""
echo "  The handoff is your resume point. Closing now risks losing this"
echo "  session's context to a credit/machine death with NO handoff."
echo "  DO NOW: update state/AI_AGENT_HANDOFF.md (done / in-progress /"
echo "  next / blockers) and PUSH 'chore: update state' (build-free, §16),"
echo "  or run 'wrap up'."
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
exit 0
