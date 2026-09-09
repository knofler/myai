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
# BRAIN W1.3 (mid-session checkpoint atom): the atom appended on OVERDUE_EMIT
# reuses this exact weighted/stale threshold and throttle — it does not run its
# own counter. It is synthesized, zero-LLM, from the W1.1 observation ring
# buffer (hooks/post-tool/07-brain-observe.sh) plus `git diff --stat`, the same
# posture hooks/stop/05-brain-autoatom.sh uses for its session-end fallback.
# Written as kind=session-auto (NOT kind=session) precisely so it stays
# invisible to 05's "did a real hand-written atom already land this session?"
# check and so the distiller weights it below curated atoms, same as any other
# mechanical fact dump.
#
# Warn-only by design — NEVER blocks (exit 0 always). Companion to hook 15
# (token-budget checkpoint) and hook stop/04 (session-close LOUD red). bash 3.2 safe.

command -v jq >/dev/null 2>&1 || exit 0

# Captured once, up front — nothing else in this hook reads stdin, and it can
# only be read once. Used solely to locate this session's W1.1 observation
# buffer for the mid-session checkpoint atom below.
INPUT="$(cat 2>/dev/null)"
SESSION=""
if [ -n "$INPUT" ] && printf '%s' "$INPUT" | jq -e . >/dev/null 2>&1; then
  SESSION="$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)"
fi

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
# shellcheck source=../../scripts/lib/autosave.sh
. "$LIB"

# Per-machine-scoped paths (task-d4c32377, 2026-08-31): STATE (.autosave-metrics)
# is rewritten by write_state() below on EVERY PostToolUse call — the hottest
# write path in the framework and the dominant source of the recurring
# Dropbox conflicted-copy pileup. See scripts/lib/local_state.sh.
local_state_path() { printf '%s' "$1"; }  # fallback if lib below is missing
LOCAL_STATE_LIB="$AIDIR/scripts/lib/local_state.sh"
[ -f "$LOCAL_STATE_LIB" ] && . "$LOCAL_STATE_LIB"
METRICS="$(local_state_path "$AIDIR/state/.session-metrics")"
STATE="$(local_state_path "$AIDIR/state/.autosave-metrics")"

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

# GNU FIRST (473a19a, fleet-wide rule): on Linux `stat -f "%m"` is
# --file-system and SUCCEEDS, printing the mount point — so a BSD-first
# `||` chain never reaches the GNU form and the age math silently breaks.
# Do not reorder these.
NOW=$(date +%s)

# ── Handoff mtime ────────────────────────────────────────────────────────────
HMTIME=$(stat -c "%Y" "$HANDOFF" 2>/dev/null || stat -f "%m" "$HANDOFF" 2>/dev/null)
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

  # ── Mid-session checkpoint atom (BRAIN W1.3) ─────────────────────────────────
  # Same trigger as the box above (OVERDUE_EMIT, i.e. same threshold + throttle
  # — never a separate counter). Zero-LLM: synthesized from the W1.1 observation
  # ring buffer + `git diff --stat`, same posture as hooks/stop/05-brain-autoatom.sh.
  # Atoms are ~free and auto-push, so even if the agent ignores the box above,
  # the session's recent progress survives a machine death. Best-effort + fully
  # guarded — never lets a brain problem affect this warn-only hook's exit code.
  BRAIN_LIB="$ROOT/scripts/lib/brain.sh"
  if [ "$BRAIN_ATOM" = "true" ] && [ -f "$BRAIN_LIB" ]; then
    (
      # shellcheck source=../../scripts/lib/brain.sh
      . "$BRAIN_LIB" 2>/dev/null || exit 0
      bdir="$(brain_dir 2>/dev/null)"
      brain_is_repo "$bdir" 2>/dev/null || exit 0

      # canonical, worktree-stable (see brain_repo_name in scripts/lib/brain.sh)
      repo=$(brain_repo_name "$ROOT")
      branch=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
      session_safe="$(printf '%s' "${SESSION:-unknown}" | tr -c 'A-Za-z0-9_.-' '-')"
      [ -n "$session_safe" ] || exit 0
      obsfile="$bdir/scratch/observe/$repo/$session_safe.jsonl"

      # No W1.1 observation buffer for this session → nothing to synthesize
      # (e.g. jq was unavailable when 07-brain-observe.sh ran, or a hook-less
      # tool client). Silent no-op, same posture as 05-brain-autoatom.sh.
      [ -s "$obsfile" ] || exit 0

      first_ts="$(head -1 "$obsfile" 2>/dev/null | jq -r '.ts // empty' 2>/dev/null)"
      [ -n "$first_ts" ] || exit 0

      commits="$(git -C "$ROOT" log --oneline --since="$first_ts" 2>/dev/null | head -20)"
      [ -n "$commits" ] || commits="(none)"
      diffstat="$(git -C "$ROOT" diff --stat HEAD 2>/dev/null | tail -30)"
      [ -n "$diffstat" ] || diffstat="(clean working tree)"
      tool_count="$(wc -l < "$obsfile" 2>/dev/null | tr -d ' ')"
      files_touched="$(jq -r '.files[]?' "$obsfile" 2>/dev/null | sort -u | head -30)"
      [ -n "$files_touched" ] || files_touched="(none recorded)"
      commands="$(jq -r 'select(.tool=="Bash") | .target' "$obsfile" 2>/dev/null | sort -u | head -20)"
      [ -n "$commands" ] || commands="(none)"

      body="$(cat <<EOF
# Mid-session checkpoint (mechanical — CHECKPOINT OVERDUE, AI_RULES §15)

Repo: $repo
Branch: $branch
Session: ${SESSION:-unknown}
Handoff: ${age_min}m stale, ${weighted_since} weighted tool calls since last write
Tool calls observed: $tool_count

## Commits (since observation window began)
$commits

## git diff --stat (uncommitted, vs HEAD)
$diffstat

## Files touched (from observation buffer)
$files_touched

## Commands run
$commands

_Mechanical mid-session checkpoint, zero LLM tokens — the handoff has not been
updated in ${age_min}m across ${weighted_since} weighted tool calls. See
hooks/post-tool/06-handoff-staleness.sh (BRAIN W1.3)._
EOF
)"

      code_sha="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"
      export BRAIN_TOPIC="continuity"
      export BRAIN_CODE_REPO="$repo"
      export BRAIN_CODE_BRANCH="$branch"
      export BRAIN_CODE_SHA="$code_sha"
      printf '%s\n' "$body" | brain_atom_write "session-auto" "$repo" "checkpoint" >/dev/null 2>&1
      brain_sync_push >/dev/null 2>&1
    ) || true
  fi
fi

write_state
exit 0
