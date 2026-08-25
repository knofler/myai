#!/usr/bin/env bash
set +e
# Hook: Brain Auto-Atom — session-end mechanical safety net (BRAIN W1.2)
# Event: Stop
#
# WHY THIS EXISTS
# ----------------
# Every brain atom, even with W1.1's passive observation buffer
# (hooks/post-tool/07-brain-observe.sh) in place, still only becomes real
# CONTEXT if something calls brain_commit — normally a human typing
# 'wrap up'. If the session just ends (credit runs out, the human closes the
# tab, a headless runner task finishes without calling wrap up), everything
# W1.1 recorded sits in the scratch/ ring buffer and is never folded into an
# atom the distiller compiles into brief.md/working.md.
#
# This hook is the fallback: at Stop, if no real atom was committed this
# session, synthesize ONE mechanical atom — zero LLM tokens — from the W1.1
# observation buffer plus `git log` / `git diff --stat` on the code repo:
# branch, commits made, files touched, commands run. Committed with
# kind: session-auto (scripts/lib/brain.sh brain_atom_write) so it lands in
# the same repos/<name>/sessions/ dir the distiller already reads, but is
# tagged so a future distiller pass can weight it below hand-written atoms —
# it is a raw fact dump, not a curated summary.
#
# MUST-HOLD PROPERTIES (do not weaken these in a future edit):
#   - zero-LLM: no model calls, ever.
#   - non-fatal: brain not initialized / gateway or remote unreachable / any
#     git op failing never breaks session close. set +e, always exit 0.
#   - only fires when nothing better already happened: if a real atom
#     (kind session|handoff) was committed to this repo's namespace since the
#     session started, this hook is a silent no-op.
#   - bounded: truncates commit/file/command lists so the atom body stays
#     small — this is a fact dump, not a transcript.

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
SESSION=""
if [ -n "$INPUT" ] && printf '%s' "$INPUT" | jq -e . >/dev/null 2>&1; then
  SESSION="$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)"
fi

REPO="$(basename "$ROOT" 2>/dev/null)"
[ -n "$REPO" ] || REPO="unknown-repo"

BDIR="$(brain_dir 2>/dev/null)"
[ -n "$BDIR" ] || exit 0
brain_is_repo "$BDIR" || exit 0

SESSION_SAFE="$(printf '%s' "${SESSION:-unknown}" | tr -c 'A-Za-z0-9_.-' '-')"
[ -n "$SESSION_SAFE" ] || exit 0
OBSFILE="$BDIR/scratch/observe/$REPO/$SESSION_SAFE.jsonl"

# No observations for this session (jq unavailable earlier, or a tool-less
# session) → nothing meaningful to synthesize. Non-fatal no-op.
[ -s "$OBSFILE" ] || exit 0

FIRST_TS="$(head -1 "$OBSFILE" 2>/dev/null | jq -r '.ts // empty' 2>/dev/null)"
[ -n "$FIRST_TS" ] || exit 0
LAST_TS="$(tail -1 "$OBSFILE" 2>/dev/null | jq -r '.ts // empty' 2>/dev/null)"
[ -n "$LAST_TS" ] || LAST_TS="$FIRST_TS"

# ── skip if a real (hand-written) atom already landed this session ──────────
# Any session/handoff atom committed to this repo's namespace — on ANY brain
# branch, since 'wrap up' commits on a session/* branch before merging to
# main — since this session started means the real thing already happened;
# don't clutter it with a mechanical duplicate. A prior session-auto atom
# from an earlier Stop event in the SAME session doesn't count — a longer
# session with more work since the last mechanical snapshot still deserves a
# fresh one.
# NOTE: the brain namespace dir is the SLUGIFIED repo name (brain_ensure_ns /
# _brain_slugify — underscores etc become hyphens), unlike the scratch/observe
# buffer path above which uses the raw basename. Using the raw $REPO here
# would silently never match for any repo whose folder name needs slugifying.
REPO_SLUG="$(_brain_slugify "$REPO" 2>/dev/null)"
[ -n "$REPO_SLUG" ] || REPO_SLUG="$REPO"
ALREADY="$(git -C "$BDIR" log --all --since="$FIRST_TS" --oneline -- \
  "repos/$REPO_SLUG/sessions" "repos/$REPO_SLUG/handoffs" 2>/dev/null | grep -v 'brain(session-auto):')"
[ -z "$ALREADY" ] || exit 0

# ── gather mechanical facts (zero LLM) ───────────────────────────────────────
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)"
[ -n "$BRANCH" ] || BRANCH="unknown"
CODE_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"

COMMITS="$(git -C "$ROOT" log --oneline --since="$FIRST_TS" 2>/dev/null | head -20)"
[ -n "$COMMITS" ] || COMMITS="(none)"

DIFFSTAT="$(git -C "$ROOT" diff --stat HEAD 2>/dev/null | tail -30)"
[ -n "$DIFFSTAT" ] || DIFFSTAT="(clean working tree)"

TOOL_COUNT="$(wc -l < "$OBSFILE" 2>/dev/null | tr -d ' ')"
BASH_COUNT="$(jq -rs '[.[] | select(.tool=="Bash")] | length' "$OBSFILE" 2>/dev/null)"
[ -n "$BASH_COUNT" ] || BASH_COUNT=0

FILES_TOUCHED="$(jq -r '.files[]?' "$OBSFILE" 2>/dev/null | sort -u | head -30)"
[ -n "$FILES_TOUCHED" ] || FILES_TOUCHED="(none recorded)"

COMMANDS="$(jq -r 'select(.tool=="Bash") | .target' "$OBSFILE" 2>/dev/null | sort -u | head -20)"
[ -n "$COMMANDS" ] || COMMANDS="(none)"

BODY="$(cat <<EOF
# Auto-captured session (mechanical fallback — no atom saved this session)

Repo: $REPO
Branch: $BRANCH
Session: ${SESSION:-unknown}
Window: $FIRST_TS -> $LAST_TS
Tool calls observed: $TOOL_COUNT (bash: $BASH_COUNT)

## Commits
$COMMITS

## git diff --stat (uncommitted, vs HEAD)
$DIFFSTAT

## Files touched (from observation buffer)
$FILES_TOUCHED

## Commands run
$COMMANDS

_Mechanical capture, zero LLM tokens — synthesized because no brain atom was
committed this session. See hooks/stop/05-brain-autoatom.sh._
EOF
)"

export BRAIN_TOPIC="continuity"
export BRAIN_CODE_REPO="$REPO"
export BRAIN_CODE_BRANCH="$BRANCH"
export BRAIN_CODE_SHA="$CODE_SHA"
printf '%s\n' "$BODY" | brain_atom_write "session-auto" "$REPO" "session-auto" >/dev/null 2>&1
unset BRAIN_TOPIC BRAIN_CODE_REPO BRAIN_CODE_BRANCH BRAIN_CODE_SHA

# Best-effort mirror to origin, same as every other brain write path — no
# remote / unreachable host is a silent, non-fatal no-op.
brain_sync_push >/dev/null 2>&1

exit 0
