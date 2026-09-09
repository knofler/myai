#!/usr/bin/env bash
# rotate_state.sh — Two-tier state rotation for STATE.md and AI_AGENT_HANDOFF.md.
#
# Why: Without rotation, state files grow unbounded (append-only per session).
# At >25k tokens, the Read tool refuses to load them in one call and every
# session pays full prompt-cache miss cost re-reading months of stale archive.
# This script keeps the hot tier small and tail-archives older content to
# `state/archive/YYYY-MM.md` files that are grep-searchable and (eventually)
# embedding-indexed for RAG retrieval — see plan/AI_AUTOMATION_PLAN.md Phase B.
#
# Usage:
#   ./scripts/rotate_state.sh           # rotate if thresholds exceeded
#   ./scripts/rotate_state.sh --check   # report only, no changes
#   ./scripts/rotate_state.sh --force   # always rotate the oldest session
#
# Thresholds (defaults — override via env):
#   STATE_MAX_SESSIONS=3   keep this many session blocks in STATE.md
#   STATE_MAX_BYTES=20000  rotate if STATE.md exceeds this size
#   HANDOFF_MAX_BYTES=10000  rotate handoff archive section if exceeded
#
# Idempotent — safe to call from wrap-up and agent-mode hooks.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE="$REPO_DIR/state/STATE.md"
HANDOFF="$REPO_DIR/state/AI_AGENT_HANDOFF.md"
ARCHIVE_DIR="$REPO_DIR/state/archive"

# Per-repo threshold override. The fleet defaults below are tuned for a
# MANAGED repo, whose handoff should stay thin because the brain is the
# primary continuity record (BRAIN-PRIMARY / TOKEN-OPT 3). ai_management is
# the exception the operator called out on 2026-08-28 ("let handoff get
# bigger for this one"): it is the fat master control plane, and its handoff
# deliberately carries the whole fleet's cross-machine narrative — trimming
# that to a managed repo's budget would throw away the thing other Macs boot
# from when the gateway is unreachable.
#
# Precedence: real env var > config/state_rotation.conf > fleet default.
ROTATION_CONF="$REPO_DIR/config/state_rotation.conf"
if [ -f "$ROTATION_CONF" ]; then
    while IFS='=' read -r _k _v; do
        case "$_k" in ''|'#'*) continue ;; esac
        _v="${_v%%#*}"; _v="$(printf '%s' "$_v" | tr -d ' \t')"
        [ -z "$_v" ] && continue
        case "$_k" in
            STATE_MAX_SESSIONS|STATE_MAX_BYTES|STATE_MAX_RECHECKS|HANDOFF_MAX_BYTES)
                # Only fill in what the environment did not already set.
                eval ": \${$_k:=$_v}" 2>/dev/null
                ;;
        esac
    done < "$ROTATION_CONF"
fi

STATE_MAX_SESSIONS="${STATE_MAX_SESSIONS:-3}"
STATE_MAX_BYTES="${STATE_MAX_BYTES:-20000}"
# Keep this many runner "### Re-check:" write-ups hot in STATE.md; archive the
# rest. These are the fleet queue's "already shipped / no code change needed"
# re-verify records — low-value, ~5KB each, and they inflate STATE.md past
# STATE_MAX_BYTES without ever adding a `### Session:` block, so the size
# trigger fires while session keep-N finds nothing to rotate (the size-only
# dead-end this pass fixes).
STATE_MAX_RECHECKS="${STATE_MAX_RECHECKS:-2}"
HANDOFF_MAX_BYTES="${HANDOFF_MAX_BYTES:-10000}"

MODE="rotate"
case "${1:-}" in
    --check) MODE="check" ;;
    --force) MODE="force" ;;
esac

mkdir -p "$ARCHIVE_DIR"

report() {
    local label="$1" path="$2"
    if [ -f "$path" ]; then
        local size_b sessions
        size_b=$(wc -c < "$path" | tr -d ' \n')
        sessions=$(awk '/^### Session:/{c++} END{print c+0}' "$path" 2>/dev/null)
        echo "  $label: ${size_b}B, ${sessions} session block(s) — $(basename "$path")"
    else
        echo "  $label: missing"
    fi
}

echo "=== state rotation status ==="
report "STATE.md  " "$STATE"
report "HANDOFF.md" "$HANDOFF"
echo "  thresholds: max ${STATE_MAX_SESSIONS} sessions, ${STATE_MAX_RECHECKS} re-checks, ${STATE_MAX_BYTES}B STATE, ${HANDOFF_MAX_BYTES}B handoff"
echo ""

if [ "$MODE" = "check" ]; then
    exit 0
fi

# ----------------------------------------------------------------------------
# Runner "### Re-check:" archival
# ----------------------------------------------------------------------------
# The fleet queue re-dispatches already-shipped work; the runner records each
# as a "### Re-check:" block ("already shipped / no code change needed", ~5KB
# of verification prose) under "## 1. Recently Implemented". These blocks push
# STATE.md past STATE_MAX_BYTES but never add a `### Session:` block, so the
# byte trigger fires while session keep-N has nothing to rotate — the size-only
# dead-end. This pass keeps the newest $1 re-check blocks hot and routes the
# rest to state/archive/rechecks-YYYY-MM.md (grep-searchable, out of the hot
# file). A "### Re-check:" block runs from its header to the next markdown
# heading (any level) or EOF.
#
# Idempotent: a second run sees <= keep blocks and no-ops. Returns 0 if it
# archived anything, 1 otherwise.
archive_rechecks() {
    local keep="$1" total ym recheck_archive tmp_kept tmp_arch archived
    total=$(grep -c "^### Re-check:" "$STATE" 2>/dev/null || true)
    total="${total:-0}"
    if [ "$total" -le "$keep" ]; then
        return 1
    fi

    ym=$(date +%Y-%m)
    recheck_archive="$ARCHIVE_DIR/rechecks-${ym}.md"
    tmp_kept=$(mktemp)
    tmp_arch=$(mktemp)

    # Split STATE.md: the (keep+1)-th re-check block onward goes to tmp_arch,
    # everything else to tmp_kept. Any heading line ends the current block.
    awk -v keep="$keep" -v kept="$tmp_kept" -v arch="$tmp_arch" '
        BEGIN { rc = 0; mode = "keep" }
        /^### Re-check:/ {
            rc++
            mode = (rc > keep) ? "archive" : "keep"
            if (mode == "archive") print > arch; else print > kept
            next
        }
        /^#+ / { mode = "keep"; print > kept; next }
        { if (mode == "archive") print > arch; else print > kept }
    ' "$STATE"

    archived=$(grep -c "^### Re-check:" "$tmp_arch" 2>/dev/null || true)
    archived="${archived:-0}"
    if [ "$archived" -eq 0 ]; then
        rm -f "$tmp_kept" "$tmp_arch"
        return 1
    fi

    if [ ! -f "$recheck_archive" ]; then
        cat > "$recheck_archive" <<EOF
# Re-check Archive: $ym

> Runner re-verify write-ups rotated out of state/STATE.md by scripts/rotate_state.sh.
> Each is an "already shipped / no code change needed" record — kept for grep,
> out of the hot state file. STATE.md keeps only the newest few.

---

EOF
    fi
    cat "$tmp_arch" >> "$recheck_archive"
    echo "" >> "$recheck_archive"

    mv "$tmp_kept" "$STATE"
    rm -f "$tmp_arch"

    echo "  Archived $archived runner re-check block(s) → $recheck_archive (kept newest $keep)"
    return 0
}

# ----------------------------------------------------------------------------
# STATE.md rotation
# ----------------------------------------------------------------------------
# Find session block boundaries. A "session block" starts at a line matching
# `^### Session:` and ends just before the next `^### Session:` or the next
# top-level `^## ` heading (which is the state-section boundary like
# "## 2. Architectural Decisions").

if [ -f "$STATE" ]; then
    STATE_BYTES=$(wc -c < "$STATE" | tr -d ' ')
    STATE_SESSIONS=$(awk '/^### Session:/{c++} END{print c+0}' "$STATE")

    NEEDS_ROTATE="no"
    if [ "$MODE" = "force" ]; then NEEDS_ROTATE="yes"; fi
    if [ "$STATE_SESSIONS" -gt "$STATE_MAX_SESSIONS" ]; then NEEDS_ROTATE="yes"; fi
    if [ "$STATE_BYTES" -gt "$STATE_MAX_BYTES" ]; then NEEDS_ROTATE="yes"; fi

    if [ "$NEEDS_ROTATE" = "yes" ]; then
        echo "Rotating STATE.md ($STATE_SESSIONS sessions, ${STATE_BYTES}B)..."

        # Pass 1: archive surplus runner "### Re-check:" write-ups first. This
        # bounds STATE.md even when session keep-N has nothing to rotate — the
        # size-only dead-end that previously left the file oversized forever.
        archive_rechecks "$STATE_MAX_RECHECKS" || true

        # Pass 2: rotate the oldest surplus `### Session:` block. Recompute the
        # header line numbers AFTER re-check archival, which edits the file.
        # (bash 3.2 compatible — no mapfile)
        SESSION_LINES=()
        while IFS= read -r line; do
            SESSION_LINES+=("$line")
        done < <(grep -n "^### Session:" "$STATE" | cut -d: -f1)

        if [ "${#SESSION_LINES[@]}" -le "$STATE_MAX_SESSIONS" ]; then
            echo "  (no surplus session blocks to rotate; re-check archival bounds the size trigger)"
        else
            # Block to rotate = the (MAX+1)-th session. Index 0-based, so MAX_SESSIONS itself.
            ROTATE_START_LINE="${SESSION_LINES[$STATE_MAX_SESSIONS]}"

            # End of block = (line of next session OR line of next ^## heading) - 1.
            NEXT_LINE=""
            if [ $((STATE_MAX_SESSIONS + 1)) -lt "${#SESSION_LINES[@]}" ]; then
                NEXT_LINE="${SESSION_LINES[$((STATE_MAX_SESSIONS + 1))]}"
            fi
            # Find first ^## heading at or after ROTATE_START_LINE (state-sections boundary)
            SECTION_LINE=$(awk -v start="$ROTATE_START_LINE" 'NR > start && /^## / { print NR; exit }' "$STATE")

            ROTATE_END_LINE=""
            if [ -n "$NEXT_LINE" ] && [ -n "$SECTION_LINE" ]; then
                ROTATE_END_LINE=$(( NEXT_LINE < SECTION_LINE ? NEXT_LINE : SECTION_LINE ))
            elif [ -n "$NEXT_LINE" ]; then
                ROTATE_END_LINE="$NEXT_LINE"
            elif [ -n "$SECTION_LINE" ]; then
                ROTATE_END_LINE="$SECTION_LINE"
            else
                ROTATE_END_LINE=$(wc -l < "$STATE")
                ROTATE_END_LINE=$((ROTATE_END_LINE + 1))
            fi
            ROTATE_END_LINE=$((ROTATE_END_LINE - 1))

            # Extract the rotated content
            ROTATED=$(sed -n "${ROTATE_START_LINE},${ROTATE_END_LINE}p" "$STATE")
            ROTATED_HEADER=$(echo "$ROTATED" | head -1)

            # Parse YYYY-MM from header: "### Session: 2026-05-19 ..."
            YYYY_MM=$(echo "$ROTATED_HEADER" | grep -oE "[0-9]{4}-[0-9]{2}" | head -1)
            if [ -z "$YYYY_MM" ]; then
                echo "  ERROR: Could not parse date from '$ROTATED_HEADER' — aborting rotation."
                exit 1
            fi

            ARCHIVE_FILE="$ARCHIVE_DIR/${YYYY_MM}.md"

            # Append to month archive (create with header if new)
            if [ ! -f "$ARCHIVE_FILE" ]; then
                cat > "$ARCHIVE_FILE" <<EOF
# Session Archive: $YYYY_MM

> Rotated out of state/STATE.md by scripts/rotate_state.sh.
> Searchable via grep. Linked from state/STATE.md "Archive" pointer section.

---

EOF
            fi
            echo "$ROTATED" >> "$ARCHIVE_FILE"
            echo "" >> "$ARCHIVE_FILE"

            # Remove rotated lines from STATE.md
            TMP=$(mktemp)
            sed "${ROTATE_START_LINE},${ROTATE_END_LINE}d" "$STATE" > "$TMP"
            mv "$TMP" "$STATE"

            # Update archive pointer table — increment session count for this month
            # (best-effort: if a row already exists for this month, leave it; if not, append)
            if ! grep -q "archive/${YYYY_MM}.md" "$STATE"; then
                echo "  WARNING: Archive pointer for $YYYY_MM not found in STATE.md — please add manually."
            fi

            echo "  Rotated session '$ROTATED_HEADER' → $ARCHIVE_FILE"
        fi

        echo "  New STATE.md size: $(wc -c < "$STATE" | tr -d ' ')B"
    else
        echo "STATE.md within thresholds — no rotation needed."
    fi
fi

# ----------------------------------------------------------------------------
# HANDOFF.md rotation
# ----------------------------------------------------------------------------
# Handoff is simpler — only rotate when the file exceeds HANDOFF_MAX_BYTES.
# We move everything after the "## Archive" heading into the archive file.

if [ -f "$HANDOFF" ]; then
    HANDOFF_BYTES=$(wc -c < "$HANDOFF" | tr -d ' ')
    if [ "$HANDOFF_BYTES" -gt "$HANDOFF_MAX_BYTES" ]; then
        echo "HANDOFF.md is ${HANDOFF_BYTES}B (>${HANDOFF_MAX_BYTES}B) — auto-trimming (TOKEN-OPT 1)…"
        # Keep header + top-N recent `> ` sessions + meta lines + the ACTION
        # section; append the older session history to the month archive.
        # Safe: no-op if the ACTION section is missing or nothing to archive.
        HANDOFF_ARCHIVE="$ARCHIVE_DIR/handoff-$(date +%Y-%m).md"
        PY="$(command -v python3 || echo /usr/bin/python3)"
        "$PY" "$SCRIPT_DIR/lib/trim_handoff.py" "$HANDOFF" "$HANDOFF_ARCHIVE" "${HANDOFF_KEEP_SESSIONS:-3}" | sed 's/^/  /'
        echo "  New HANDOFF.md size: $(wc -c < "$HANDOFF" | tr -d ' ')B"
    else
        echo "HANDOFF.md within thresholds — OK."
    fi
fi

echo ""
echo "Rotation complete."
