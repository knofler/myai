#!/bin/bash
set +e
# Hook: Session Status Dashboard (Traffic Light)
# Event: Stop
# Shows a visual traffic-light dashboard of session health

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
PROJECT=$(basename "$ROOT")

# ── Gather signals ──

# 1. Uncommitted changes
DIRTY=$(git status --porcelain 2>/dev/null | grep -v '^\?\?' | wc -l | tr -d ' ')
# 2. Unpushed commits
UNPUSHED=$(git log --oneline origin/$(git branch --show-current 2>/dev/null)..HEAD 2>/dev/null | wc -l | tr -d ' ')
# 3. Untracked files
UNTRACKED=$(git status --porcelain 2>/dev/null | grep '^\?\?' | wc -l | tr -d ' ')
# 4. STATE.md freshness (minutes since last edit)
STATE_FILE="$ROOT/AI/state/STATE.md"
[ ! -f "$STATE_FILE" ] && STATE_FILE="$ROOT/state/STATE.md"
STATE_AGE=999
if [ -f "$STATE_FILE" ]; then
  STATE_MOD=$(stat -f "%m" "$STATE_FILE" 2>/dev/null || stat -c "%Y" "$STATE_FILE" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  STATE_AGE=$(( (NOW - STATE_MOD) / 60 ))
fi
# 5. Handoff file freshness
HANDOFF_FILE="$ROOT/AI/state/AI_AGENT_HANDOFF.md"
[ ! -f "$HANDOFF_FILE" ] && HANDOFF_FILE="$ROOT/state/AI_AGENT_HANDOFF.md"
HANDOFF_AGE=999
if [ -f "$HANDOFF_FILE" ]; then
  HANDOFF_MOD=$(stat -f "%m" "$HANDOFF_FILE" 2>/dev/null || stat -c "%Y" "$HANDOFF_FILE" 2>/dev/null || echo 0)
  HANDOFF_AGE=$(( (NOW - HANDOFF_MOD) / 60 ))
fi
# 6. Current branch
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
# 7. Docker status
DOCKER_OK="--"
if [ -f "$ROOT/docker-compose.yml" ] && docker info &>/dev/null 2>&1; then
  RUNNING=$(docker compose -f "$ROOT/docker-compose.yml" ps --format json 2>/dev/null | jq -r 'select(.State == "running") | .Name' 2>/dev/null | wc -l | tr -d ' ')
  TOTAL=$(docker compose -f "$ROOT/docker-compose.yml" ps --format json 2>/dev/null | jq -r '.Name' 2>/dev/null | wc -l | tr -d ' ')
  DOCKER_OK="$RUNNING/$TOTAL"
fi
# 8. CI status (last run)
CI_STATUS="--"
if command -v gh &>/dev/null && gh repo view &>/dev/null 2>&1; then
  CI_STATUS=$(gh run list --limit 1 --json conclusion --jq '.[0].conclusion' 2>/dev/null || echo "--")
  [ -z "$CI_STATUS" ] && CI_STATUS="running"
fi

# 9. Session usage
USAGE_PCT="--"
METRICS_FILE="$ROOT/state/.session-metrics"
[ ! -f "$METRICS_FILE" ] && METRICS_FILE="$ROOT/AI/state/.session-metrics"
if [ -f "$METRICS_FILE" ]; then
  s_started=$(grep '^started_epoch=' "$METRICS_FILE" 2>/dev/null | cut -d= -f2)
  s_duration=$(grep '^duration_minutes=' "$METRICS_FILE" 2>/dev/null | cut -d= -f2)
  s_weighted=$(grep '^weighted_actions=' "$METRICS_FILE" 2>/dev/null | cut -d= -f2)
  s_max_actions=$(grep '^max_weighted_actions=' "$METRICS_FILE" 2>/dev/null | cut -d= -f2)
  s_now=$(date +%s)
  s_elapsed=$(( s_now - s_started ))
  s_total=$(( s_duration * 60 ))
  s_time_pct=0
  [ "$s_total" -gt 0 ] && s_time_pct=$(( (s_elapsed * 100) / s_total ))
  s_action_pct=0
  [ "$s_max_actions" -gt 0 ] && s_action_pct=$(awk "BEGIN { printf \"%d\", ($s_weighted / $s_max_actions) * 100 }" 2>/dev/null || echo 0)
  USAGE_PCT=$s_time_pct
  [ "$s_action_pct" -gt "$s_time_pct" ] 2>/dev/null && USAGE_PCT=$s_action_pct
fi

# ── Traffic light logic ──
# Green = done/good, Yellow = needs attention, Red = action required

light_commit="RED"
[ "$DIRTY" -eq 0 ] && light_commit="GRN"
[ "$DIRTY" -gt 0 ] && [ "$DIRTY" -le 3 ] && light_commit="YLW"

light_push="RED"
[ "$UNPUSHED" -eq 0 ] && light_push="GRN"
[ "$UNPUSHED" -gt 0 ] && [ "$UNPUSHED" -le 2 ] && light_push="YLW"

light_state="RED"
[ "$STATE_AGE" -lt 30 ] && light_state="GRN"
[ "$STATE_AGE" -ge 30 ] && [ "$STATE_AGE" -lt 60 ] && light_state="YLW"

light_handoff="RED"
[ "$HANDOFF_AGE" -lt 30 ] && light_handoff="GRN"
[ "$HANDOFF_AGE" -ge 30 ] && [ "$HANDOFF_AGE" -lt 60 ] && light_handoff="YLW"

light_branch="GRN"
[ "$BRANCH" = "main" ] && light_branch="YLW"

light_docker="GRN"
if [ "$DOCKER_OK" != "--" ]; then
  [ "$DOCKER_OK" = "0/0" ] && light_docker="YLW"
  DRUN=$(echo "$DOCKER_OK" | cut -d/ -f1)
  DTOT=$(echo "$DOCKER_OK" | cut -d/ -f2)
  [ "$DRUN" -lt "$DTOT" ] 2>/dev/null && light_docker="RED"
fi

light_ci="GRN"
[ "$CI_STATUS" = "failure" ] && light_ci="RED"
[ "$CI_STATUS" = "running" ] || [ "$CI_STATUS" = "--" ] && light_ci="YLW"

light_usage="GRN"
if [ "$USAGE_PCT" != "--" ]; then
  [ "$USAGE_PCT" -ge 80 ] 2>/dev/null && light_usage="YLW"
  [ "$USAGE_PCT" -ge 90 ] 2>/dev/null && light_usage="RED"
fi

# ── Render ──
icon() {
  case "$1" in
    GRN) echo "[OK]" ;;
    YLW) echo "[!!]" ;;
    RED) echo "[XX]" ;;
  esac
}

desc_commit="$DIRTY uncommitted"
[ "$DIRTY" -eq 0 ] && desc_commit="clean"
desc_push="$UNPUSHED unpushed"
[ "$UNPUSHED" -eq 0 ] && desc_push="synced"
desc_state="${STATE_AGE}m ago"
[ "$STATE_AGE" -lt 5 ] && desc_state="fresh"
desc_handoff="${HANDOFF_AGE}m ago"
[ "$HANDOFF_AGE" -lt 5 ] && desc_handoff="fresh"
desc_docker="$DOCKER_OK containers"
desc_ci="$CI_STATUS"
desc_usage="${USAGE_PCT}%"
[ "$USAGE_PCT" = "--" ] && desc_usage="no data"

echo ""
echo "================================================================"
echo "  SESSION DASHBOARD: $PROJECT"
echo "================================================================"
echo ""
printf "  %-6s %-20s %s\n" "$(icon $light_commit)" "Commit" "$desc_commit"
printf "  %-6s %-20s %s\n" "$(icon $light_push)" "Push" "$desc_push"
printf "  %-6s %-20s %s\n" "$(icon $light_state)" "STATE.md" "$desc_state"
printf "  %-6s %-20s %s\n" "$(icon $light_handoff)" "Handoff" "$desc_handoff"
printf "  %-6s %-20s %s\n" "$(icon $light_branch)" "Branch" "$BRANCH"
printf "  %-6s %-20s %s\n" "$(icon $light_docker)" "Docker" "$desc_docker"
printf "  %-6s %-20s %s\n" "$(icon $light_ci)" "CI" "$desc_ci"
printf "  %-6s %-20s %s\n" "$(icon $light_usage)" "Usage" "$desc_usage"
echo ""

# Overall verdict
ALL_GREEN=true
for l in $light_commit $light_push $light_state $light_handoff $light_ci $light_usage; do
  [ "$l" = "RED" ] && ALL_GREEN=false
done

if [ "$ALL_GREEN" = true ]; then
  echo "  >>> ALL GREEN — safe to close session <<<"
else
  echo "  >>> ACTION NEEDED before closing session <<<"
fi
echo ""
echo "================================================================"

exit 0
