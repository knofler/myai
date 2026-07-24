#!/usr/bin/env bash
set +e
# Hook: Token Budget Guard — REAL token-burn metering + proactive auto-checkpoint
# Event: PreToolUse (all tools)
#
# WHY THIS EXISTS
# ---------------
# The action-count Usage Guard (10-usage-guard.sh) counts tool calls as a proxy
# for context size. It CANNOT see real token consumption, and it never saves
# context before the wall. On token-hungry models (e.g. Fable) a session burns
# the account's rolling-window usage limit fast, hits the wall MID-TASK with
# nothing written, and the user is stuck with no handoff to resume from.
#
# This hook reads ACTUAL token usage from the session transcript JSONL
# (~/.claude/projects/.../<session>.jsonl) and from ALL transcripts in the
# rolling window across EVERY repo (the account-level signal a per-repo counter
# can never see — one Claude.ai account is shared by all repos/agents). It warns
# on real burn and, at a deliberately EARLY checkpoint threshold, emits a
# MANDATORY directive to write the handoff NOW, so hitting the wall is always
# survivable.
#
# Warn-only by design. It NEVER blocks (exit 0 always) — blocking on token burn
# would strand the user worse than warning. Budgets are in raw OUTPUT tokens.
#
# bash 3.2 safe (no mapfile / associative arrays). Cheap: session sum ~30ms;
# global rolling scan cached (default 90s TTL) so it runs ~once/90s.

INPUT=$(cat)

# jq is required; degrade silently if absent (matches sibling hooks).
command -v jq >/dev/null 2>&1 || exit 0

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
[ -z "$TOOL_NAME" ] && exit 0

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
if [ -f "$ROOT/config/session-limits.json" ]; then
  AIDIR="$ROOT"
elif [ -f "$ROOT/AI/config/session-limits.json" ]; then
  AIDIR="$ROOT/AI"
else
  exit 0
fi
CONFIG="$AIDIR/config/session-limits.json"

# Gate: token budget feature on?
[ "$(jq -r '.token_budget.enabled // false' "$CONFIG" 2>/dev/null)" = "true" ] || exit 0

# ── Resolve the session transcript ───────────────────────────────────────────
# Prefer the path the harness hands us; fall back to the newest jsonl for this
# repo's project dir, then the newest across all projects.
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  TRANSCRIPT=$(ls -t "$HOME/.claude/projects"/*/*.jsonl 2>/dev/null | head -1)
fi
[ -f "$TRANSCRIPT" ] || exit 0

# ── Config values ────────────────────────────────────────────────────────────
SESS_BUDGET=$(jq -r '.token_budget.session_output_budget // 400000' "$CONFIG" 2>/dev/null)
SESS_CHECKPOINT=$(jq -r '.token_budget.checkpoint_at_percent // 70' "$CONFIG" 2>/dev/null)
SESS_WARNS=$(jq -r '(.token_budget.warn_at_percent // [70,85,95]) | join(" ")' "$CONFIG" 2>/dev/null)
ROLL_ENABLED=$(jq -r '.token_budget.rolling_window.enabled // false' "$CONFIG" 2>/dev/null)
ROLL_MINUTES=$(jq -r '.token_budget.rolling_window.window_minutes // 300' "$CONFIG" 2>/dev/null)
ROLL_BUDGET=$(jq -r '.token_budget.rolling_window.output_budget // 3000000' "$CONFIG" 2>/dev/null)
ROLL_WARNS=$(jq -r '(.token_budget.rolling_window.warn_at_percent // [70,85,95]) | join(" ")' "$CONFIG" 2>/dev/null)
ROLL_TTL=$(jq -r '.token_budget.rolling_window.cache_ttl_seconds // 90' "$CONFIG" 2>/dev/null)

NOW=$(date +%s)

# ── Session output-token sum (full transcript, ~30ms) ────────────────────────
SESS_OUT=$(grep '"type":"assistant"' "$TRANSCRIPT" 2>/dev/null \
  | jq -s '[.[].message.usage.output_tokens // 0] | add // 0' 2>/dev/null)
[ -z "$SESS_OUT" ] && SESS_OUT=0

sess_pct=0
[ "$SESS_BUDGET" -gt 0 ] 2>/dev/null && \
  sess_pct=$(awk "BEGIN { printf \"%.0f\", ($SESS_OUT / $SESS_BUDGET) * 100 }")

# ── Dedup state (per transcript) ─────────────────────────────────────────────
STATE="$AIDIR/state/.token-metrics"
prev_transcript=""; sess_warned=""; checkpointed=0; usage_prompted_epoch=0
if [ -f "$STATE" ]; then
  prev_transcript=$(sed -n 's/^transcript=//p' "$STATE" | head -1)
  sess_warned=$(sed -n 's/^sess_warned=//p' "$STATE" | head -1)
  checkpointed=$(sed -n 's/^checkpointed=//p' "$STATE" | head -1)
  usage_prompted_epoch=$(sed -n 's/^usage_prompted_epoch=//p' "$STATE" | head -1)
fi
# New session (transcript changed) → reset dedup
if [ "$prev_transcript" != "$TRANSCRIPT" ]; then
  sess_warned=""; checkpointed=0; usage_prompted_epoch=0
fi
: "${checkpointed:=0}"; : "${usage_prompted_epoch:=0}"

write_state() {
  cat > "$STATE" <<EOF
transcript=$TRANSCRIPT
sess_warned=$sess_warned
checkpointed=$checkpointed
usage_prompted_epoch=$usage_prompted_epoch
EOF
}

# Highest session warn threshold crossed
sess_hit=0
for t in $SESS_WARNS; do
  if [ "$sess_pct" -ge "$t" ] 2>/dev/null; then
    [ "$t" -gt "$sess_hit" ] && sess_hit=$t
  fi
done

# already_warned <threshold> — true if this threshold is in the csv sess_warned
already_warned() { case ",$sess_warned," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

emitted=0

# ── Session checkpoint directive (EARLY, once) ───────────────────────────────
if [ "$sess_pct" -ge "$SESS_CHECKPOINT" ] 2>/dev/null && [ "$checkpointed" != "1" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  TOKEN GUARD: CHECKPOINT — ${sess_pct}% of session output budget   "
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║  Session output: ${SESS_OUT} / ${SESS_BUDGET} tokens"
  echo "║"
  echo "║  MANDATORY (AI_RULES §15 — do this NOW, before the next step):"
  echo "║    Write state/AI_AGENT_HANDOFF.md with done / in-progress"
  echo "║    (branch + uncommitted) / next / blockers, then COMMIT AND"
  echo "║    PUSH 'chore: update state'. State pushes are BUILD-FREE at"
  echo "║    every gate (§16) — an unpushed handoff dies with the machine."
  echo "║  This is a SAVE POINT, not a stop. If the account rolling-window"
  echo "║  limit is hit mid-task, you can resume from the pushed handoff."
  echo "╚══════════════════════════════════════════════════════════════╝"
  checkpointed=1
  emitted=1
  # The checkpoint box supersedes any plain warn line at/below this %.
  # Mark all crossed warn thresholds as already-warned so the next call is quiet.
  for t in $SESS_WARNS; do
    if [ "$sess_pct" -ge "$t" ] 2>/dev/null && ! already_warned "$t"; then
      sess_warned="${sess_warned},${t}"
    fi
  done
elif [ "$sess_hit" -gt 0 ] && ! already_warned "$sess_hit"; then
  echo "[TOKEN GUARD: SESSION ${sess_pct}%] output ${SESS_OUT}/${SESS_BUDGET} — consider 'wrap up' soon"
  sess_warned="${sess_warned},${sess_hit}"
  emitted=1
fi

# ── Rolling-window (account-level, cross-repo) ───────────────────────────────
if [ "$ROLL_ENABLED" = "true" ]; then
  RCACHE="$AIDIR/state/.token-rolling-cache"
  roll_out=""; roll_computed=0; roll_warned=0
  if [ -f "$RCACHE" ]; then
    roll_out=$(sed -n 's/^rolling_output=//p' "$RCACHE" | head -1)
    roll_computed=$(sed -n 's/^computed_epoch=//p' "$RCACHE" | head -1)
    roll_warned=$(sed -n 's/^rolling_warned=//p' "$RCACHE" | head -1)
  fi
  : "${roll_computed:=0}"; : "${roll_warned:=0}"
  age=$(( NOW - roll_computed ))
  if [ -z "$roll_out" ] || [ "$age" -ge "$ROLL_TTL" ] 2>/dev/null; then
    # Recompute: sum output_tokens across all transcripts touched in the window.
    roll_out=$(find "$HOME/.claude/projects" -name '*.jsonl' -mmin -"$ROLL_MINUTES" 2>/dev/null \
      -exec grep -h '"type":"assistant"' {} + 2>/dev/null \
      | jq -s '[.[].message.usage.output_tokens // 0] | add // 0' 2>/dev/null)
    [ -z "$roll_out" ] && roll_out=0
    cat > "$RCACHE" <<EOF
computed_epoch=$NOW
rolling_output=$roll_out
rolling_warned=$roll_warned
EOF
  fi

  roll_pct=0
  [ "$ROLL_BUDGET" -gt 0 ] 2>/dev/null && \
    roll_pct=$(awk "BEGIN { printf \"%.0f\", ($roll_out / $ROLL_BUDGET) * 100 }")

  roll_hit=0
  for t in $ROLL_WARNS; do
    if [ "$roll_pct" -ge "$t" ] 2>/dev/null; then
      [ "$t" -gt "$roll_hit" ] && roll_hit=$t
    fi
  done

  # Reset dedup when burn falls back under the lowest threshold (new window).
  lowest=$(echo "$ROLL_WARNS" | awk '{m=$1; for(i=1;i<=NF;i++) if($i<m)m=$i; print m}')
  [ "$roll_pct" -lt "$lowest" ] 2>/dev/null && roll_warned=0

  if [ "$roll_hit" -gt "$roll_warned" ] 2>/dev/null; then
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  TOKEN GUARD: ACCOUNT ROLLING WINDOW — ${roll_pct}%               "
    echo "╠══════════════════════════════════════════════════════════════╣"
    echo "║  ${roll_out} / ${ROLL_BUDGET} output tokens in the last ${ROLL_MINUTES}m"
    echo "║  ACROSS ALL REPOS (shared Claude.ai account). This is the limit"
    echo "║  that freezes every session at once."
    echo "║"
    echo "║  ${roll_pct}% — at 85%+: finish + 'wrap up' on ALL active sessions."
    echo "║  At 95%+: write handoffs everywhere and stop starting new work."
    echo "╚══════════════════════════════════════════════════════════════╝"
    roll_warned=$roll_hit
    emitted=1
  fi
  # Persist rolling dedup without forcing a recompute
  if [ -f "$RCACHE" ]; then
    rc_epoch=$(sed -n 's/^computed_epoch=//p' "$RCACHE" | head -1)
    rc_out=$(sed -n 's/^rolling_output=//p' "$RCACHE" | head -1)
    cat > "$RCACHE" <<EOF
computed_epoch=${rc_epoch:-$NOW}
rolling_output=${rc_out:-$roll_out}
rolling_warned=$roll_warned
EOF
  fi
fi

# ── Periodic /usage ground-truth reminder (throttled, when burn elevated) ─────
# The agent can't run /usage itself — it's an interactive Claude Code command
# with no tool/MCP surface. So when the higher of session/rolling burn is at or
# above the floor, nudge (at most once per interval_minutes) to run /usage — the
# authoritative reading — and recalibrate the estimate if it diverges.
UG_ENABLED=$(jq -r '.token_budget.usage_ground_truth.enabled // false' "$CONFIG" 2>/dev/null)
if [ "$UG_ENABLED" = "true" ]; then
  UG_INTERVAL=$(jq -r '.token_budget.usage_ground_truth.interval_minutes // 2' "$CONFIG" 2>/dev/null)
  UG_FLOOR=$(jq -r '.token_budget.usage_ground_truth.floor_percent // 70' "$CONFIG" 2>/dev/null)
  # Sanitize: only digits survive into bash arithmetic; malformed config falls back to defaults
  echo "$UG_INTERVAL" | grep -qE '^[0-9]+$' || UG_INTERVAL=2
  echo "$UG_FLOOR" | grep -qE '^[0-9]+$' || UG_FLOOR=70
  hi_pct=${sess_pct:-0}
  [ "${roll_pct:-0}" -gt "$hi_pct" ] 2>/dev/null && hi_pct=${roll_pct:-0}
  if [ "$hi_pct" -ge "$UG_FLOOR" ] 2>/dev/null; then
    elapsed=$(( NOW - usage_prompted_epoch ))
    if [ "$elapsed" -ge "$(( UG_INTERVAL * 60 ))" ] 2>/dev/null; then
      echo ""
      echo "[TOKEN GUARD: GROUND-TRUTH CHECK DUE — burn ~${hi_pct}% (estimate)]"
      echo "  Run /usage now for the authoritative session + weekly %. This hook is an"
      echo "  on-disk APPROXIMATION; /usage is truth. If they diverge, recalibrate"
      echo "  token_budget.*.output_budget (formula in config/session-limits.json)."
      usage_prompted_epoch=$NOW
      emitted=1
    fi
  fi
fi

write_state
exit 0
