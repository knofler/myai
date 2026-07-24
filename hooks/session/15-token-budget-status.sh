#!/usr/bin/env bash
set +e
# Hook: Token Budget Status — session-start account rolling-window awareness
# Event: SessionStart
#
# Prints the account-level rolling-window output-token burn (across ALL repos,
# the shared Claude.ai account) BEFORE any work starts. This is the preventive
# half of the token guard: seeing "rolling window: 2.7M/3M (89%)" at the top of
# a session is what stops you from diving into a token-hungry model and hitting
# the wall mid-task with no context saved.
#
# Read-only and silent unless the rolling window is enabled and has data.
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

[ "$(jq -r '.token_budget.enabled // false' "$CONFIG" 2>/dev/null)" = "true" ] || exit 0
[ "$(jq -r '.token_budget.rolling_window.enabled // false' "$CONFIG" 2>/dev/null)" = "true" ] || exit 0

ROLL_MINUTES=$(jq -r '.token_budget.rolling_window.window_minutes // 300' "$CONFIG" 2>/dev/null)
ROLL_BUDGET=$(jq -r '.token_budget.rolling_window.output_budget // 3000000' "$CONFIG" 2>/dev/null)

[ -d "$HOME/.claude/projects" ] || exit 0

roll_out=$(find "$HOME/.claude/projects" -name '*.jsonl' -mmin -"$ROLL_MINUTES" 2>/dev/null \
  -exec grep -h '"type":"assistant"' {} + 2>/dev/null \
  | jq -s '[.[].message.usage.output_tokens // 0] | add // 0' 2>/dev/null)
[ -z "$roll_out" ] && roll_out=0

pct=0
[ "$ROLL_BUDGET" -gt 0 ] 2>/dev/null && \
  pct=$(awk "BEGIN { printf \"%.0f\", ($roll_out / $ROLL_BUDGET) * 100 }")

# Prime the pre-tool guard's cache so it doesn't recompute immediately.
NOW=$(date +%s)
cat > "$AIDIR/state/.token-rolling-cache" <<EOF
computed_epoch=$NOW
rolling_output=$roll_out
rolling_warned=0
EOF

hh=$(( ROLL_MINUTES / 60 ))
if [ "$pct" -ge 85 ] 2>/dev/null; then
  echo "Token Guard: ACCOUNT ROLLING WINDOW ${pct}% — ${roll_out}/${ROLL_BUDGET} output tokens in last ${hh}h across ALL repos."
  echo "  ⚠ Near the account limit that freezes every session. Keep this session short; 'wrap up' early. Calibrate output_budget if this is wrong."
elif [ "$pct" -ge 60 ] 2>/dev/null; then
  echo "Token Guard: rolling window ${pct}% (${roll_out}/${ROLL_BUDGET} output tokens / last ${hh}h, all repos). Mind the burn on token-hungry models."
else
  echo "Token Guard: rolling window ${pct}% (${roll_out}/${ROLL_BUDGET} output tokens / last ${hh}h, all repos)."
fi
exit 0
