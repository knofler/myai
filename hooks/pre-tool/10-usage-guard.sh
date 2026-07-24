#!/usr/bin/env bash
set +e
# Hook: Usage Guard — Track and warn on session capacity
# Event: PreToolUse (all tools)
# Increments action count, checks time + action thresholds, emits warnings
# Exit 0 = allow (+ optional warning), Exit 2 = block (at 95% for heavy tools)

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)

# If jq not available or no tool name, skip silently
[[ -z "$TOOL_NAME" || "$TOOL_NAME" == "null" ]] && exit 0

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Find metrics file
METRICS_FILE=""
if [[ -f "$ROOT/state/.session-metrics" ]]; then
  METRICS_FILE="$ROOT/state/.session-metrics"
elif [[ -f "$ROOT/AI/state/.session-metrics" ]]; then
  METRICS_FILE="$ROOT/AI/state/.session-metrics"
fi

# No metrics file = usage guard not initialized, skip
[[ -z "$METRICS_FILE" || ! -f "$METRICS_FILE" ]] && exit 0

# Find config
CONFIG_FILE=""
if [[ -f "$ROOT/config/session-limits.json" ]]; then
  CONFIG_FILE="$ROOT/config/session-limits.json"
elif [[ -f "$ROOT/AI/config/session-limits.json" ]]; then
  CONFIG_FILE="$ROOT/AI/config/session-limits.json"
fi

# ── Read current metrics (whitespace-tolerant — Claude Code `!` adds indentation) ──
_get() { sed -n "s/^[[:space:]]*$1=//p" "$METRICS_FILE" | head -1; }
action_count=$(_get action_count)
weighted_actions=$(_get weighted_actions)
started_epoch=$(_get started_epoch)
duration_minutes=$(_get duration_minutes)
max_weighted_actions=$(_get max_weighted_actions)
warnings_sent=$(_get warnings_sent)

# Defaults for safety
: "${action_count:=0}"
: "${weighted_actions:=0.0}"
: "${started_epoch:=0}"
: "${duration_minutes:=240}"
: "${max_weighted_actions:=300}"

# ── Stale session check ──
# If the session has expired (e.g. stale file from previous session/machine via Dropbox),
# reset metrics instead of blocking. This prevents false 95% blocks on new sessions.
NOW_CHECK=$(date +%s)
expires_epoch=$(_get expires_epoch)
: "${expires_epoch:=0}"
if [[ "$NOW_CHECK" -gt "$expires_epoch" && "$expires_epoch" -gt 0 ]]; then
  # Session expired — reset the file
  NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  EXP_EPOCH=$(( NOW_CHECK + (duration_minutes * 60) ))
  EXP_ISO=$(date -u -r "$EXP_EPOCH" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "@$EXP_EPOCH" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
  cat > "$METRICS_FILE" <<RESET
started=$NOW_ISO
started_epoch=$NOW_CHECK
expires=$EXP_ISO
expires_epoch=$EXP_EPOCH
duration_minutes=$duration_minutes
max_weighted_actions=$max_weighted_actions
action_count=1
weighted_actions=$WEIGHT
warnings_sent=
RESET
  exit 0
fi

# ── Determine action weight ──
WEIGHT="0.5"
if [[ -n "$CONFIG_FILE" ]] && command -v jq &>/dev/null; then
  W=$(jq -r ".action_weights.\"$TOOL_NAME\" // .action_weights.default // 0.5" "$CONFIG_FILE" 2>/dev/null)
  [[ -n "$W" && "$W" != "null" ]] && WEIGHT="$W"
else
  case "$TOOL_NAME" in
    Bash|Edit|Write|Agent) WEIGHT="1.0" ;;
    Read|Glob|Grep)        WEIGHT="0.3" ;;
    *)                     WEIGHT="0.5" ;;
  esac
fi

# ── Read block policy from config ──
# block_at_percent: null/absent  → NEVER hard-block (warn-only mode)
# block_tools: []                → no tool is ever blocked
# Falls back to legacy behavior (block heavy tools at 95%) only when config/jq missing,
# so a broken/absent config never silently removes the safety backstop.
BLOCK_AT_PERCENT=""
BLOCK_TOOLS=""
if [[ -n "$CONFIG_FILE" ]] && command -v jq &>/dev/null; then
  BLOCK_AT_PERCENT=$(jq -r '.block_at_percent // empty' "$CONFIG_FILE" 2>/dev/null)
  BLOCK_TOOLS=$(jq -r '(.block_tools // []) | join(" ")' "$CONFIG_FILE" 2>/dev/null)
else
  BLOCK_AT_PERCENT=95
  BLOCK_TOOLS="Bash Edit Write Agent"
fi

# ── Increment counters ──
action_count=$(( action_count + 1 ))
weighted_actions=$(awk "BEGIN { printf \"%.1f\", $weighted_actions + $WEIGHT }")

# ── Calculate time-based percentage ──
NOW_EPOCH=$(date +%s)
elapsed_seconds=$(( NOW_EPOCH - started_epoch ))
total_seconds=$(( duration_minutes * 60 ))
time_pct=0
[[ "$total_seconds" -gt 0 ]] && time_pct=$(awk "BEGIN { printf \"%.0f\", ($elapsed_seconds / $total_seconds) * 100 }")

# ── Calculate action-based percentage ──
action_pct=0
[[ "$max_weighted_actions" -gt 0 ]] && action_pct=$(awk "BEGIN { printf \"%.0f\", ($weighted_actions / $max_weighted_actions) * 100 }")

# ── Effective usage = higher of the two ──
usage_pct=$time_pct
[[ "$action_pct" -gt "$time_pct" ]] && usage_pct=$action_pct

# ── Remaining budget ──
remaining_actions=$(awk "BEGIN { printf \"%.0f\", $max_weighted_actions - $weighted_actions }")
remaining_minutes=$(( (total_seconds - elapsed_seconds) / 60 ))
[[ "$remaining_minutes" -lt 0 ]] && remaining_minutes=0

# ── Update metrics file (whitespace-tolerant sed) ──
sed -i.bak "s/^[[:space:]]*action_count=.*/action_count=$action_count/" "$METRICS_FILE"
sed -i.bak "s/^[[:space:]]*weighted_actions=.*/weighted_actions=$weighted_actions/" "$METRICS_FILE"
rm -f "${METRICS_FILE}.bak"

# ── Check thresholds ──
EXIT_CODE=0

if [[ "$usage_pct" -ge 95 ]]; then
  # Record warning
  if [[ "$warnings_sent" != *"95"* ]]; then
    sed -i.bak "s/^[[:space:]]*warnings_sent=.*/warnings_sent=${warnings_sent},95/" "$METRICS_FILE"
    rm -f "${METRICS_FILE}.bak"
  fi

  # Is this a tool that should be blocked? Governed by config (block_at_percent /
  # block_tools). With block_at_percent=null + block_tools=[] this is always false
  # → warn-only mode (the 95% branch still prints the EMERGENCY nudge, never blocks).
  IS_HEAVY=false
  if [[ -n "$BLOCK_AT_PERCENT" && "$BLOCK_AT_PERCENT" != "null" && "$usage_pct" -ge "$BLOCK_AT_PERCENT" ]]; then
    for bt in $BLOCK_TOOLS; do
      [[ "$TOOL_NAME" == "$bt" ]] && IS_HEAVY=true && break
    done
  fi

  # Allow writes to AI_AGENT_HANDOFF.md even at 95%
  IS_HANDOFF=false
  if [[ "$TOOL_NAME" == "Write" || "$TOOL_NAME" == "Edit" ]]; then
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null)
    [[ "$FILE_PATH" == *"AI_AGENT_HANDOFF"* ]] && IS_HANDOFF=true
  fi

  if [[ "$IS_HEAVY" == true && "$IS_HANDOFF" == false ]]; then
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  USAGE GUARD: EMERGENCY — ${usage_pct}% CAPACITY REACHED           ║"
    echo "╠══════════════════════════════════════════════════════════════╣"
    echo "║  Time: ${remaining_minutes}m remaining | Actions: ${remaining_actions} remaining"
    echo "║  BLOCKED: ${TOOL_NAME} — only handoff writes allowed now"
    echo "║"
    echo "║  MANDATORY: Write AI_AGENT_HANDOFF.md NOW with:"
    echo "║    - What was done this session"
    echo "║    - What is in progress (branch + uncommitted files)"
    echo "║    - What should be done next"
    echo "║    - Current blockers"
    echo "║  Then tell the user to commit/push manually."
    echo "╚══════════════════════════════════════════════════════════════╝"
    EXIT_CODE=2
  else
    echo "[USAGE GUARD: EMERGENCY ${usage_pct}%] ${remaining_minutes}m / ${remaining_actions} actions left — WRITE HANDOFF NOW"
  fi

elif [[ "$usage_pct" -ge 90 ]]; then
  if [[ "$warnings_sent" != *"90"* ]]; then
    sed -i.bak "s/^[[:space:]]*warnings_sent=.*/warnings_sent=${warnings_sent},90/" "$METRICS_FILE"
    rm -f "${METRICS_FILE}.bak"
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  USAGE GUARD: RED WARNING — ${usage_pct}% CAPACITY                 ║"
    echo "╠══════════════════════════════════════════════════════════════╣"
    echo "║  Time: ${remaining_minutes}m remaining | Actions: ${remaining_actions} remaining"
    echo "║"
    echo "║  MANDATORY: Run 'wrap up' NOW."
    echo "║  - Stop new work immediately"
    echo "║  - Commit current changes"
    echo "║  - Update STATE.md + AI_AGENT_HANDOFF.md"
    echo "║  - Push to remote"
    echo "║  If wrap up exceeds budget, skip to emergency:"
    echo "║  just write AI_AGENT_HANDOFF.md with done/next/blockers."
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
  else
    echo "[USAGE GUARD: RED ${usage_pct}%] ${remaining_minutes}m / ${remaining_actions} actions left — WRAP UP NOW"
  fi

elif [[ "$usage_pct" -ge 80 ]]; then
  if [[ "$warnings_sent" != *"80"* ]]; then
    sed -i.bak "s/^[[:space:]]*warnings_sent=.*/warnings_sent=${warnings_sent},80/" "$METRICS_FILE"
    rm -f "${METRICS_FILE}.bak"
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  USAGE GUARD: YELLOW WARNING — ${usage_pct}% CAPACITY              ║"
    echo "╠══════════════════════════════════════════════════════════════╣"
    echo "║  Time: ${remaining_minutes}m remaining | Actions: ${remaining_actions} remaining"
    echo "║"
    echo "║  ACTION: Start wrapping up current task."
    echo "║  - Finish what you're working on (don't start new tasks)"
    echo "║  - Prioritize: commit > push > state update > handoff"
    echo "║  - Budget remaining actions for wrap-up ceremony"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
  fi
fi

exit $EXIT_CODE
