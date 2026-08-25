#!/usr/bin/env bash
set +e
# Hook: Brain Observe — passive session capture (BRAIN W1.1)
# Event: PostToolUse (all tools)
#
# WHY THIS EXISTS
# ----------------
# Every brain atom today only exists because a human typed 'wrap up' (or a
# hook nagged them into it — see post-tool/06-handoff-staleness.sh). If the
# session dies first, that work is gone. This is the mechanism claude-mem
# gets right and we currently lack: a raw, zero-LLM observation ring buffer
# that captures every tool call as it happens, with no dependency on anyone
# remembering to save.
#
# One JSONL record per tool call — {ts, tool, target, exit, files} — appended
# to a per-session file under the brain SCRATCH namespace
# ($(brain_dir)/scratch/observe/<repo>/<session>.jsonl). This is deliberately
# OUTSIDE the git-versioned atom store (memory/, repos/*/sessions/, .../handoffs/):
# it is raw, noisy, high-volume signal, not a curated fact, and is never
# git-added. A future distiller can fold it into real atoms; this hook only
# ever appends bytes to a bounded file.
#
# MUST-HOLD PROPERTIES (do not weaken these in a future edit):
#   - zero-LLM: no model calls, ever.
#   - zero-network: no curl/gh/docker/anything that can block or fail on a
#     flaky connection.
#   - cheap: jq + coreutils only, no subshells beyond what's needed.
#   - bounded: size-capped per-session file with rotation (never grows
#     unbounded across a long session).
#   - never breaks a session: set +e, every external command has a fallback,
#     and the script always exits 0.

command -v jq >/dev/null 2>&1 || exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
[ -n "$HOOK_DIR" ] || exit 0
ROOT="$(cd "$HOOK_DIR/../.." 2>/dev/null && pwd)"
[ -n "$ROOT" ] || exit 0
LIB="$ROOT/scripts/lib/brain.sh"
[ -f "$LIB" ] || exit 0
# shellcheck source=../../scripts/lib/brain.sh
. "$LIB" 2>/dev/null || exit 0

INPUT="$(cat 2>/dev/null)"
[ -n "$INPUT" ] || exit 0
printf '%s' "$INPUT" | jq -e . >/dev/null 2>&1 || exit 0

TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)"
[ -n "$TOOL" ] || TOOL="unknown"
SESSION="$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)"

# ── target: a short, tool-appropriate description of what was acted on ──────
TARGET="$(printf '%s' "$INPUT" | jq -r '
  (.tool_input.file_path // .tool_input.path
   // .tool_input.command
   // .tool_input.pattern
   // .tool_input.query
   // .tool_input.url
   // .tool_input.description
   // "") | tostring' 2>/dev/null)"
# Truncate defensively — a Bash command or Write content can be huge; this is
# an observation log, not a transcript.
TARGET="$(printf '%s' "$TARGET" | tr '\n' ' ' | cut -c1-300)"

# ── files touched: best-effort, from well-known tool_input shapes only ──────
FILES_JSON="$(printf '%s' "$INPUT" | jq -c '
  [ (.tool_input.file_path // empty),
    (.tool_input.notebook_path // empty)
  ] + ( (.tool_input.edits // []) | map(.file_path // empty) )
  | map(select(. != "" and . != null)) | unique' 2>/dev/null)"
[ -n "$FILES_JSON" ] && printf '%s' "$FILES_JSON" | jq -e . >/dev/null 2>&1 || FILES_JSON="[]"

# ── exit status: best-effort across the plausible tool_response shapes ──────
# NOTE: jq's `//` treats `false` (not just `null`) as falsy — `.success // true`
# would silently turn success:false into true. Use `has()` + an explicit `==
# false` check instead of `//` wherever a real boolean `false` must survive.
EXIT_STATUS="$(printf '%s' "$INPUT" | jq -r '
  (.tool_response // {}) as $r |
  if ($r.is_error // false) == true then "error"
  elif ($r.error // null) != null then "error"
  elif (($r.exit_code // null) != null and ($r.exit_code // 0) != 0) then "error"
  elif (($r | has("success")) and ($r.success == false)) then "error"
  else "ok"
  end' 2>/dev/null)"
case "$EXIT_STATUS" in ok|error) ;; *) EXIT_STATUS="unknown" ;; esac

REPO="$(basename "$ROOT" 2>/dev/null)"
[ -n "$REPO" ] || REPO="unknown-repo"

# Session key: prefer the hook-supplied session_id; fall back to an
# hour-bucketed, PID-suffixed key so concurrent sessions without one still
# get distinct (if imperfect) buffers rather than colliding.
if [ -z "$SESSION" ]; then
  SESSION="$(date -u +%Y%m%dT%H)-$$"
fi
SESSION_SAFE="$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9_.-' '-')"
[ -n "$SESSION_SAFE" ] || exit 0

BDIR="$(brain_dir 2>/dev/null)"
[ -n "$BDIR" ] || exit 0

# Self-heal: gitignore scratch/ so it can never trip a "working tree must be
# clean" gate (brain_merge/checkout/stash/revert all require one). New brains
# get this from brain_init; this covers brains initialized before that (incl.
# BRAIN W1.4's brain_observe MCP tool self-heals the same way in brain.ts).
if brain_is_repo "$BDIR" 2>/dev/null && ! grep -qx 'scratch/' "$BDIR/.gitignore" 2>/dev/null; then
  printf 'scratch/\n' >> "$BDIR/.gitignore" 2>/dev/null
  git -C "$BDIR" add .gitignore >/dev/null 2>&1
  git -C "$BDIR" commit -q -m 'brain(chore): gitignore scratch/ (observation ring buffer, BRAIN W1.4)' >/dev/null 2>&1
fi

OUTDIR="$BDIR/scratch/observe/$REPO"
mkdir -p "$OUTDIR" 2>/dev/null || exit 0
OUTFILE="$OUTDIR/$SESSION_SAFE.jsonl"

# ── bounded size with rotation (ring buffer) ─────────────────────────────────
# Cap each session file at MAX_BYTES; on overflow, rotate .1 -> .2 -> ... up
# to KEEP generations and start a fresh file. Total footprint per session is
# bounded at roughly MAX_BYTES * (KEEP + 1), never unbounded growth.
MAX_BYTES=524288
KEEP=3
if [ -f "$OUTFILE" ]; then
  SZ="$(wc -c < "$OUTFILE" 2>/dev/null | tr -d ' ')"
  case "$SZ" in
    ''|*[!0-9]*) SZ=0 ;;
  esac
  if [ "$SZ" -ge "$MAX_BYTES" ]; then
    i=$KEEP
    while [ "$i" -ge 1 ]; do
      if [ -f "${OUTFILE}.${i}" ]; then
        if [ "$i" -eq "$KEEP" ]; then
          rm -f "${OUTFILE}.${i}" 2>/dev/null
        else
          j=$((i + 1))
          mv -f "${OUTFILE}.${i}" "${OUTFILE}.${j}" 2>/dev/null
        fi
      fi
      i=$((i - 1))
    done
    mv -f "$OUTFILE" "${OUTFILE}.1" 2>/dev/null
  fi
fi

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"
[ -n "$TS" ] || TS="unknown"

RECORD="$(jq -nc \
  --arg ts "$TS" \
  --arg tool "$TOOL" \
  --arg target "$TARGET" \
  --arg exit "$EXIT_STATUS" \
  --argjson files "$FILES_JSON" \
  '{ts:$ts, tool:$tool, target:$target, exit:$exit, files:$files}' 2>/dev/null)"

[ -n "$RECORD" ] && printf '%s\n' "$RECORD" >> "$OUTFILE" 2>/dev/null

exit 0
