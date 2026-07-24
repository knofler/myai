#!/usr/bin/env bash
set +e
# ════════════════════════════════════════════════════════════════════════════
#  budget_hook.sh  —  portable, self-installing token-budget guard
#  for Claude Code. ONE file. Share it, run `--install`, done.
#
#  WHAT IT DOES (same rules as the ai_management fleet):
#   • Session-start: prints your ACCOUNT rolling-window output-token burn
#     across ALL repos (the shared-account signal that freezes every session
#     at once) BEFORE you start, so you don't dive in and hit the wall.
#   • Before every tool call: meters REAL output tokens from the live session
#     transcript; warns at 70/85/95%; at an EARLY checkpoint % emits a MANDATORY
#     "write your handoff NOW" directive so hitting the wall is always
#     survivable; and nudges you to run /usage (the authoritative reading)
#     when burn is elevated.
#   • Warn-only — it NEVER blocks a tool (blocking on token burn strands you
#     worse). All budgets are in raw OUTPUT tokens.
#
#  GROUND TRUTH is Claude Code's `/usage` command. This hook is an on-disk
#  ESTIMATE (the real rate-limit % isn't written to any file a hook can read).
#  Calibrate once: run /usage, note its session %, see the session-start line's
#  token count, set session/rolling output_budget = count / (pct/100).
#
#  USAGE
#   bash budget_hook.sh --install     # wire into ~/.claude/settings.json
#   bash budget_hook.sh --uninstall   # remove it
#   bash budget_hook.sh --status      # print rolling-window burn now
#   bash budget_hook.sh --help
#
#  CONFIG (all optional) — ~/.claude/token-guard.json, e.g.
#   { "session_output_budget": 600000, "checkpoint_at_percent": 70,
#     "warn_at_percent": [70,85,95],
#     "rolling_window": { "output_budget": 4400000, "window_minutes": 300 },
#     "usage_ground_truth": { "enabled": true, "interval_minutes": 2, "floor_percent": 70 } }
#  Or quick env overrides: TOKEN_GUARD_SESSION_BUDGET, TOKEN_GUARD_ROLLING_BUDGET.
#
#  Requirements: bash, jq, coreutils (find/grep/awk). macOS bash 3.2 safe.
#  No dependency on any repo layout — purely user-level (~/.claude).
# ════════════════════════════════════════════════════════════════════════════

SELF="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/$(basename "$0")"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CONFIG="${TOKEN_GUARD_CONFIG:-$CLAUDE_DIR/token-guard.json}"
STATE_SESS="$CLAUDE_DIR/.token-guard-session"
STATE_ROLL="$CLAUDE_DIR/.token-guard-rolling"

# ── defaults (override via config file or env) ───────────────────────────────
DEF_SESS_BUDGET=600000
DEF_CHECKPOINT=70
DEF_WARNS="70 85 95"
DEF_ROLL_ENABLED=true
DEF_ROLL_MINUTES=300
DEF_ROLL_BUDGET=4400000
DEF_ROLL_TTL=90
DEF_UG_ENABLED=true
DEF_UG_INTERVAL=2
DEF_UG_FLOOR=70

cfg() { # cfg <jq-path> <default>
  if [ -f "$CONFIG" ] && command -v jq >/dev/null 2>&1; then
    local v; v=$(jq -r "$1 // empty" "$CONFIG" 2>/dev/null)
    [ -n "$v" ] && { printf '%s' "$v"; return; }
  fi
  printf '%s' "$2"
}

SESS_BUDGET="${TOKEN_GUARD_SESSION_BUDGET:-$(cfg '.session_output_budget' $DEF_SESS_BUDGET)}"
SESS_CHECKPOINT="$(cfg '.checkpoint_at_percent' $DEF_CHECKPOINT)"
SESS_WARNS="$(cfg '(.warn_at_percent // []) | join(" ")' "$DEF_WARNS")"; [ -z "$SESS_WARNS" ] && SESS_WARNS="$DEF_WARNS"
ROLL_ENABLED="$(cfg '.rolling_window.enabled' $DEF_ROLL_ENABLED)"
ROLL_MINUTES="$(cfg '.rolling_window.window_minutes' $DEF_ROLL_MINUTES)"
ROLL_BUDGET="${TOKEN_GUARD_ROLLING_BUDGET:-$(cfg '.rolling_window.output_budget' $DEF_ROLL_BUDGET)}"
ROLL_WARNS="$(cfg '(.rolling_window.warn_at_percent // []) | join(" ")' "$DEF_WARNS")"; [ -z "$ROLL_WARNS" ] && ROLL_WARNS="$DEF_WARNS"
ROLL_TTL="$(cfg '.rolling_window.cache_ttl_seconds' $DEF_ROLL_TTL)"
UG_ENABLED="$(cfg '.usage_ground_truth.enabled' $DEF_UG_ENABLED)"
UG_INTERVAL="$(cfg '.usage_ground_truth.interval_minutes' $DEF_UG_INTERVAL)"
UG_FLOOR="$(cfg '.usage_ground_truth.floor_percent' $DEF_UG_FLOOR)"

PROJECTS_DIR="$CLAUDE_DIR/projects"

# ── shared: compute rolling-window output tokens across ALL transcripts ──────
compute_rolling() {
  [ -d "$PROJECTS_DIR" ] || { printf '0'; return; }
  local out
  out=$(find "$PROJECTS_DIR" -name '*.jsonl' -mmin -"$ROLL_MINUTES" 2>/dev/null \
        -exec grep -h '"type":"assistant"' {} + 2>/dev/null \
        | jq -s '[.[].message.usage.output_tokens // 0] | add // 0' 2>/dev/null)
  [ -z "$out" ] && out=0
  printf '%s' "$out"
}

pct_of() { # pct_of <value> <budget>
  awk "BEGIN { if ($2>0) printf \"%.0f\", ($1/$2)*100; else print 0 }"
}

# ════════════════════════════════════════════════════════════════════════════
#  --install / --uninstall / --status / --help
# ════════════════════════════════════════════════════════════════════════════
do_install() {
  command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required (brew install jq / apt install jq)"; exit 1; }
  mkdir -p "$CLAUDE_DIR"
  local dest="$CLAUDE_DIR/budget_hook.sh"
  if [ "$SELF" != "$dest" ]; then cp "$SELF" "$dest" && chmod +x "$dest"; fi
  local settings="$CLAUDE_DIR/settings.json"
  [ -f "$settings" ] || echo '{}' > "$settings"
  cp "$settings" "$settings.tokenguard.bak" 2>/dev/null
  local tmp; tmp=$(mktemp)
  jq --arg cmd "$dest" '
    .hooks //= {} |
    .hooks.SessionStart //= [] |
    .hooks.PreToolUse //= [] |
    (if any(.hooks.SessionStart[]?; (.hooks[]?.command // "") == $cmd)
       then . else .hooks.SessionStart += [{matcher:"", hooks:[{type:"command", command:$cmd, timeout:8000}]}] end) |
    (if any(.hooks.PreToolUse[]?; (.hooks[]?.command // "") == $cmd)
       then . else .hooks.PreToolUse += [{matcher:"", hooks:[{type:"command", command:$cmd, timeout:8000}]}] end)
  ' "$settings" > "$tmp" 2>/dev/null && mv "$tmp" "$settings" || { echo "ERROR: failed to update $settings (backup at $settings.tokenguard.bak)"; rm -f "$tmp"; exit 1; }
  echo "✅ Installed. Token guard wired into:"
  echo "   $settings  (SessionStart + PreToolUse)"
  echo "   script:  $dest"
  echo "   backup:  $settings.tokenguard.bak"
  echo ""
  echo "Restart Claude Code. You'll see a rolling-window line at session start,"
  echo "and burn warnings + an early checkpoint directive as you work."
  echo "Tune budgets in $CONFIG (see --help). Ground truth is /usage."
}

do_uninstall() {
  command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }
  local settings="$CLAUDE_DIR/settings.json"; [ -f "$settings" ] || { echo "no settings.json — nothing to do"; exit 0; }
  local dest="$CLAUDE_DIR/budget_hook.sh"
  local tmp; tmp=$(mktemp)
  jq --arg cmd "$dest" '
    if .hooks then
      .hooks.SessionStart = [ (.hooks.SessionStart // [])[] | select(all(.hooks[]?; (.command // "") != $cmd)) ] |
      .hooks.PreToolUse  = [ (.hooks.PreToolUse  // [])[] | select(all(.hooks[]?; (.command // "") != $cmd)) ]
    else . end
  ' "$settings" > "$tmp" 2>/dev/null && mv "$tmp" "$settings" && echo "✅ Removed token guard from $settings" || { echo "ERROR updating settings"; rm -f "$tmp"; exit 1; }
}

do_status() {
  command -v jq >/dev/null 2>&1 || { echo "jq required"; exit 1; }
  local out pct hh; out=$(compute_rolling); pct=$(pct_of "$out" "$ROLL_BUDGET"); hh=$(( ROLL_MINUTES / 60 ))
  echo "Token Guard — account rolling window: ${pct}% (${out}/${ROLL_BUDGET} output tokens / last ${hh}h, all repos)."
  echo "Ground truth: run /usage in Claude Code. Calibrate output_budget if this diverges."
}

case "$1" in
  --install)   do_install;   exit 0 ;;
  --uninstall) do_uninstall; exit 0 ;;
  --status)    do_status;    exit 0 ;;
  -h|--help)
    sed -n '2,40p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

# ════════════════════════════════════════════════════════════════════════════
#  HOOK MODE — invoked by Claude Code with JSON on stdin.
# ════════════════════════════════════════════════════════════════════════════
command -v jq >/dev/null 2>&1 || exit 0
INPUT=$(cat 2>/dev/null)
[ -z "$INPUT" ] && exit 0
EVENT=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
NOW=$(date +%s)
mkdir -p "$CLAUDE_DIR" 2>/dev/null

# ── SessionStart: rolling-window awareness (and prime the cache) ─────────────
if [ "$EVENT" = "SessionStart" ]; then
  [ "$ROLL_ENABLED" = "true" ] || exit 0
  out=$(compute_rolling); pct=$(pct_of "$out" "$ROLL_BUDGET"); hh=$(( ROLL_MINUTES / 60 ))
  printf 'computed_epoch=%s\nrolling_output=%s\nrolling_warned=0\n' "$NOW" "$out" > "$STATE_ROLL"
  if [ "$pct" -ge 85 ] 2>/dev/null; then
    echo "Token Guard: ACCOUNT ROLLING WINDOW ${pct}% — ${out}/${ROLL_BUDGET} output tokens in last ${hh}h across ALL repos."
    echo "  ⚠ Near the account limit that freezes every session. Keep this short; 'wrap up' early. Calibrate output_budget if wrong (/usage)."
  elif [ "$pct" -ge 60 ] 2>/dev/null; then
    echo "Token Guard: rolling window ${pct}% (${out}/${ROLL_BUDGET} output tokens / last ${hh}h, all repos). Mind the burn on token-hungry models."
  else
    echo "Token Guard: rolling window ${pct}% (${out}/${ROLL_BUDGET} output tokens / last ${hh}h, all repos)."
  fi
  exit 0
fi

# ── Everything else = PreToolUse-style guard ─────────────────────────────────
# Resolve transcript: prefer the harness-provided path; else newest jsonl.
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  TRANSCRIPT=$(ls -t "$PROJECTS_DIR"/*/*.jsonl 2>/dev/null | head -1)
fi
[ -f "$TRANSCRIPT" ] || exit 0

# Session output-token sum (full transcript)
SESS_OUT=$(grep '"type":"assistant"' "$TRANSCRIPT" 2>/dev/null \
  | jq -s '[.[].message.usage.output_tokens // 0] | add // 0' 2>/dev/null)
[ -z "$SESS_OUT" ] && SESS_OUT=0
sess_pct=$(pct_of "$SESS_OUT" "$SESS_BUDGET")

# Dedup state (per transcript)
prev_transcript=""; sess_warned=""; checkpointed=0; usage_prompted_epoch=0
if [ -f "$STATE_SESS" ]; then
  prev_transcript=$(sed -n 's/^transcript=//p' "$STATE_SESS" | head -1)
  sess_warned=$(sed -n 's/^sess_warned=//p' "$STATE_SESS" | head -1)
  checkpointed=$(sed -n 's/^checkpointed=//p' "$STATE_SESS" | head -1)
  usage_prompted_epoch=$(sed -n 's/^usage_prompted_epoch=//p' "$STATE_SESS" | head -1)
fi
[ "$prev_transcript" != "$TRANSCRIPT" ] && { sess_warned=""; checkpointed=0; usage_prompted_epoch=0; }
: "${checkpointed:=0}"; : "${usage_prompted_epoch:=0}"

write_sess_state() {
  printf 'transcript=%s\nsess_warned=%s\ncheckpointed=%s\nusage_prompted_epoch=%s\n' \
    "$TRANSCRIPT" "$sess_warned" "$checkpointed" "$usage_prompted_epoch" > "$STATE_SESS"
}
already_warned() { case ",$sess_warned," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

sess_hit=0
for t in $SESS_WARNS; do [ "$sess_pct" -ge "$t" ] 2>/dev/null && [ "$t" -gt "$sess_hit" ] && sess_hit=$t; done

# Session checkpoint directive (EARLY, once) — supersedes plain warns below it
if [ "$sess_pct" -ge "$SESS_CHECKPOINT" ] 2>/dev/null && [ "$checkpointed" != "1" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  TOKEN GUARD: CHECKPOINT — ${sess_pct}% of session output budget"
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║  Session output: ${SESS_OUT} / ${SESS_BUDGET} tokens"
  echo "║  MANDATORY (now, before the next heavy step): write a short"
  echo "║  handoff — done / in-progress (branch + uncommitted) / next /"
  echo "║  blockers — and commit it. A SAVE POINT, not a stop: if the"
  echo "║  account rolling-window limit hits mid-task, you can resume."
  echo "╚══════════════════════════════════════════════════════════════╝"
  checkpointed=1
  for t in $SESS_WARNS; do [ "$sess_pct" -ge "$t" ] 2>/dev/null && ! already_warned "$t" && sess_warned="${sess_warned},${t}"; done
elif [ "$sess_hit" -gt 0 ] && ! already_warned "$sess_hit"; then
  echo "[TOKEN GUARD: SESSION ${sess_pct}%] output ${SESS_OUT}/${SESS_BUDGET} — consider wrapping up soon"
  sess_warned="${sess_warned},${sess_hit}"
fi

# Rolling-window (account-level, cross-repo) — cached (TTL)
roll_pct=0
if [ "$ROLL_ENABLED" = "true" ]; then
  roll_out=""; roll_computed=0; roll_warned=0
  if [ -f "$STATE_ROLL" ]; then
    roll_out=$(sed -n 's/^rolling_output=//p' "$STATE_ROLL" | head -1)
    roll_computed=$(sed -n 's/^computed_epoch=//p' "$STATE_ROLL" | head -1)
    roll_warned=$(sed -n 's/^rolling_warned=//p' "$STATE_ROLL" | head -1)
  fi
  : "${roll_computed:=0}"; : "${roll_warned:=0}"
  age=$(( NOW - roll_computed ))
  if [ -z "$roll_out" ] || [ "$age" -ge "$ROLL_TTL" ] 2>/dev/null; then
    roll_out=$(compute_rolling)
    printf 'computed_epoch=%s\nrolling_output=%s\nrolling_warned=%s\n' "$NOW" "$roll_out" "$roll_warned" > "$STATE_ROLL"
  fi
  roll_pct=$(pct_of "$roll_out" "$ROLL_BUDGET")
  roll_hit=0
  for t in $ROLL_WARNS; do [ "$roll_pct" -ge "$t" ] 2>/dev/null && [ "$t" -gt "$roll_hit" ] && roll_hit=$t; done
  lowest=$(echo "$ROLL_WARNS" | awk '{m=$1; for(i=1;i<=NF;i++) if($i<m)m=$i; print m}')
  [ "$roll_pct" -lt "$lowest" ] 2>/dev/null && roll_warned=0
  if [ "$roll_hit" -gt "$roll_warned" ] 2>/dev/null; then
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  TOKEN GUARD: ACCOUNT ROLLING WINDOW — ${roll_pct}%"
    echo "╠══════════════════════════════════════════════════════════════╣"
    echo "║  ${roll_out} / ${ROLL_BUDGET} output tokens in the last ${ROLL_MINUTES}m"
    echo "║  ACROSS ALL REPOS (shared account). This is the limit that"
    echo "║  freezes every session at once."
    echo "║  At 85%+: finish + wrap up ALL active sessions. At 95%+: write"
    echo "║  handoffs everywhere and stop starting new work."
    echo "╚══════════════════════════════════════════════════════════════╝"
    roll_warned=$roll_hit
  fi
  printf 'computed_epoch=%s\nrolling_output=%s\nrolling_warned=%s\n' "${roll_computed:-$NOW}" "${roll_out:-0}" "$roll_warned" > "$STATE_ROLL"
fi

# Periodic /usage ground-truth nudge (throttled, when burn elevated)
if [ "$UG_ENABLED" = "true" ]; then
  echo "$UG_INTERVAL" | grep -qE '^[0-9]+$' || UG_INTERVAL=2
  echo "$UG_FLOOR" | grep -qE '^[0-9]+$' || UG_FLOOR=70
  hi_pct=${sess_pct:-0}; [ "${roll_pct:-0}" -gt "$hi_pct" ] 2>/dev/null && hi_pct=${roll_pct:-0}
  if [ "$hi_pct" -ge "$UG_FLOOR" ] 2>/dev/null; then
    elapsed=$(( NOW - usage_prompted_epoch ))
    if [ "$elapsed" -ge "$(( UG_INTERVAL * 60 ))" ] 2>/dev/null; then
      echo ""
      echo "[TOKEN GUARD: GROUND-TRUTH CHECK DUE — burn ~${hi_pct}% (estimate)]"
      echo "  Run /usage now for the authoritative session + weekly %. This is an"
      echo "  on-disk estimate; /usage is truth. If they diverge, recalibrate output_budget."
      usage_prompted_epoch=$NOW
    fi
  fi
fi

write_sess_state
exit 0
