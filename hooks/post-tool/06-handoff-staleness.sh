#!/usr/bin/env bash
set +e
# Hook: Handoff Staleness Guard — mechanical enforcement of AI_RULES §15
# Event: PostToolUse (all tools)
#
# WHY THIS EXISTS
# ---------------
# AI_RULES §15 (checkpoint-as-you-go) makes the handoff a CONTINUOUSLY-maintained
# document: a session killed at any moment must cost at most ~15 min of context.
# Operator directive 2026-07-05: "credit ended and no handoff existed; AI should
# make the call and constantly auto-save." Prose rules rot — this is the
# mechanical backstop.
#
# After every tool call, if state/AI_AGENT_HANDOFF.md has not been touched in
# ~stale_minutes AND ≥min_weighted_since weighted tool calls (same weights as the
# Usage Guard) have accrued since it was last written, emit a MANDATORY
# "CHECKPOINT OVERDUE" box directing an immediate handoff write + PUSH. Throttled
# so it nags without spamming. Optionally appends a free NO-LLM brain atom.
#
# Warn-only by design — NEVER blocks (exit 0 always). Companion to hook 15
# (token-budget checkpoint) and hook stop/04 (session-close LOUD red). bash 3.2 safe.

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
METRICS="$AIDIR/state/.session-metrics"
STATE="$AIDIR/state/.autosave-metrics"
LIB="$AIDIR/scripts/lib/autosave.sh"

[ -f "$HANDOFF" ] || exit 0
[ -f "$LIB" ] || exit 0
# shellcheck source=../../scripts/lib/autosave.sh
. "$LIB"

# Gate: autosave enforcement on?
[ "$(jq -r '.autosave.enabled // false' "$CONFIG" 2>/dev/null)" = "true" ] || exit 0

STALE_MIN=$(jq -r '.autosave.stale_minutes // 30' "$CONFIG" 2>/dev/null)
MIN_W=$(jq -r '.autosave.min_weighted_since // 40' "$CONFIG" 2>/dev/null)
THROTTLE_MIN=$(jq -r '.autosave.throttle_minutes // 5' "$CONFIG" 2>/dev/null)
BRAIN_ATOM=$(jq -r '.autosave.brain_atom // false' "$CONFIG" 2>/dev/null)
# Sanitize: only digits survive into arithmetic; malformed config → defaults.
echo "$STALE_MIN"    | grep -qE '^[0-9]+$' || STALE_MIN=30
echo "$MIN_W"        | grep -qE '^[0-9]+$' || MIN_W=40
echo "$THROTTLE_MIN" | grep -qE '^[0-9]+$' || THROTTLE_MIN=5
STALE_SEC=$(( STALE_MIN * 60 ))
THROTTLE_SEC=$(( THROTTLE_MIN * 60 ))

NOW=$(date +%s)

# ── Handoff mtime ────────────────────────────────────────────────────────────
HMTIME=$(stat -f "%m" "$HANDOFF" 2>/dev/null || stat -c "%Y" "$HANDOFF" 2>/dev/null)
echo "$HMTIME" | grep -qE '^[0-9]+$' || exit 0

# ── Current cumulative weighted actions (maintained by hooks/pre-tool/10) ─────
cur_weighted=0
if [ -f "$METRICS" ]; then
  cur_weighted=$(sed -n 's/^[[:space:]]*weighted_actions=//p' "$METRICS" | head -1)
fi
# Floor to integer for the math.
cur_weighted=$(awk "BEGIN { printf \"%.0f\", ${cur_weighted:-0} + 0 }" 2>/dev/null)
: "${cur_weighted:=0}"

# Session anchor to detect a fresh session (from the metrics file).
started_epoch=0
[ -f "$METRICS" ] && started_epoch=$(sed -n 's/^[[:space:]]*started_epoch=//p' "$METRICS" | head -1)
: "${started_epoch:=0}"

# ── Baseline state ───────────────────────────────────────────────────────────
handoff_mtime_seen=""; weighted_at_handoff=""; last_warned_epoch=0; started_seen=""
if [ -f "$STATE" ]; then
  handoff_mtime_seen=$(sed -n 's/^handoff_mtime_seen=//p' "$STATE" | head -1)
  weighted_at_handoff=$(sed -n 's/^weighted_at_handoff=//p' "$STATE" | head -1)
  last_warned_epoch=$(sed -n 's/^last_warned_epoch=//p' "$STATE" | head -1)
  started_seen=$(sed -n 's/^started_seen=//p' "$STATE" | head -1)
fi
: "${last_warned_epoch:=0}"

write_state() {
  cat > "$STATE" <<EOF
handoff_mtime_seen=$handoff_mtime_seen
weighted_at_handoff=$weighted_at_handoff
last_warned_epoch=$last_warned_epoch
started_seen=$started_epoch
EOF
}

# Rebase the baseline when: first run, the handoff was (re)written since we last
# looked, or a new session started. Any of these means "the handoff is current
# right now" → reset the work counter and stay quiet this call.
if [ -z "$handoff_mtime_seen" ] || [ "$handoff_mtime_seen" != "$HMTIME" ] || [ "$started_seen" != "$started_epoch" ]; then
  handoff_mtime_seen="$HMTIME"
  weighted_at_handoff="$cur_weighted"
  last_warned_epoch=0
  write_state
  exit 0
fi
echo "$weighted_at_handoff" | grep -qE '^[0-9]+$' || weighted_at_handoff=$cur_weighted

weighted_since=$(( cur_weighted - weighted_at_handoff ))
[ "$weighted_since" -lt 0 ] && weighted_since=0

verdict=$(autosave_verdict "$NOW" "$HMTIME" "$weighted_since" "$last_warned_epoch" \
  "$STALE_SEC" "$MIN_W" "$THROTTLE_SEC")

if [ "$verdict" = "OVERDUE_EMIT" ]; then
  age_min=$(( (NOW - HMTIME) / 60 ))
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  CHECKPOINT OVERDUE — handoff ${age_min}m stale, ${weighted_since} weighted calls since  "
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║  AI_RULES §15 (checkpoint-as-you-go): the handoff is ALWAYS"
  echo "║  current, never end-loaded. A kill -9 right now would lose more"
  echo "║  than ~15 min of context."
  echo "║"
  echo "║  MANDATORY (do this NOW, before the next unit of work):"
  echo "║    1. Update state/AI_AGENT_HANDOFF.md delta — done /"
  echo "║       in-progress (branch + uncommitted) / next / blockers."
  echo "║    2. git commit + PUSH 'chore: update state' — state pushes"
  echo "║       are BUILD-FREE at every gate (§16). Do not just write it;"
  echo "║       an unpushed handoff dies with the machine."
  echo "╚══════════════════════════════════════════════════════════════╝"
  last_warned_epoch=$NOW

  # ── Optional cheap layer: append a free NO-LLM auto brain atom ───────────────
  # Atoms are ~free and auto-push, so even if the agent ignores the box above the
  # session's recent progress survives a machine death. Best-effort + fully guarded.
  if [ "$BRAIN_ATOM" = "true" ] && [ -f "$AIDIR/scripts/myai_brain.sh" ]; then
    repo=$(basename "$ROOT")
    branch=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    # NO-LLM summary: timestamp + recent commit subjects + dirty count. Any RESULT
    # lines from the newest runner log for this repo are appended verbatim.
    dirty=$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    commits=$(git -C "$ROOT" log --oneline -5 2>/dev/null | sed 's/^/  - /')
    resultln=$(ls -t "$HOME/.ai-cli-runner/logs/"*"-${repo}-task-"*.log 2>/dev/null | head -1)
    results=""
    [ -n "$resultln" ] && [ -f "$resultln" ] && \
      results=$(grep -h '^RESULT:' "$resultln" 2>/dev/null | tail -3 | sed 's/^/  /')
    {
      printf 'autosave checkpoint (§15) — %s\nrepo: %s  branch: %s  uncommitted: %s files\nrecent commits:\n%s\n' \
        "$ts" "$repo" "$branch" "$dirty" "$commits"
      [ -n "$results" ] && printf 'recent RESULT lines:\n%s\n' "$results"
    } | timeout 15 bash "$AIDIR/scripts/myai_brain.sh" write session "$repo" autosave >/dev/null 2>&1 || true
  fi
fi

write_state
exit 0
