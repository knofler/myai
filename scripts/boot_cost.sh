#!/usr/bin/env bash
# boot_cost.sh — the per-session BOOT-COST KPI (TOKEN task-2a431e9b).
#
# "myAI's one honest KPI is tokens a session needs to be useful"
# (plan/DIRECTION_2026-09.md bet 1). The framework's own boot overhead —
# CLAUDE.md the harness injects every session, plus everything the SessionStart
# hooks print — used to cost more than the brain saved. This script totals that
# overhead in BYTES so the number is visible and trends over time:
#
#     boot cost = bytes(CLAUDE.md)  +  bytes(hook stdout, last boot)
#
# `myai wrapup` calls it and emits the `boot cost:` line the agent writes into
# the handoff header (next to `Brain:`), so every wrap-up records the KPI.
#
# The hook-stdout half comes from the 6th field of the per-machine hook-timing
# log (state/.hook-timing.log.<host>) that hooks/hook_share/timing/timed_hook.sh
# records — the bytes each hook ACTUALLY emitted after the ≤3-line cap. No
# timing log (fresh checkout, timing disabled) → hooks half is 0, still prints.
#
# Usage:
#   boot_cost.sh            # -> "boot cost: 57340 B (CLAUDE.md 56108 + hooks 1232)"
#   boot_cost.sh --bytes    # -> just the total integer (for tests/scripts)
set -uo pipefail

MODE="line"
[ "${1:-}" = "--bytes" ] && MODE="bytes"

ROOT="${BOOT_COST_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# ── CLAUDE.md bytes (the harness injects it verbatim every session) ──────────
CLAUDE_MD="$ROOT/CLAUDE.md"
CLAUDE_BYTES=0
if [ -f "$CLAUDE_MD" ]; then
  CLAUDE_BYTES="$(wc -c < "$CLAUDE_MD" 2>/dev/null | tr -d '[:space:]')"
fi
case "$CLAUDE_BYTES" in ''|*[!0-9]*) CLAUDE_BYTES=0 ;; esac

# ── hook stdout bytes: sum the 6th field of the LAST boot in the timing log ──
# Log line: <boot_id> <start_ms> <dur_ms> <exit> <hook_name> <out_bytes>
LOG_FILE="${BOOT_COST_TIMING_LOG:-}"
if [ -z "$LOG_FILE" ]; then
  # Newest .hook-timing.log* under state/ or AI/state/ (per-machine suffix),
  # skipping the wrapper's .reported./.tmp. sidecars. Picked by mtime with a
  # glob + GNU-first stat (AI_RULES §4) — no `ls | grep` (SC2010).
  newest=0
  for d in "$ROOT/state" "$ROOT/AI/state"; do
    [ -d "$d" ] || continue
    for f in "$d"/.hook-timing.log*; do
      [ -f "$f" ] || continue
      case "$f" in *.reported.*|*.tmp.*) continue ;; esac
      mt="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null)"
      case "$mt" in ''|*[!0-9]*) continue ;; esac
      if [ "$mt" -gt "$newest" ]; then newest="$mt"; LOG_FILE="$f"; fi
    done
  done
fi

HOOK_BYTES=0
if [ -n "$LOG_FILE" ] && [ -f "$LOG_FILE" ]; then
  HOOK_BYTES="$(awk '
    NF>=6 && $6 ~ /^[0-9]+$/ { last=$1; b[$1]+=$6 }
    END { if (last!="") print b[last]+0; else print 0 }
  ' "$LOG_FILE" 2>/dev/null)"
fi
case "$HOOK_BYTES" in ''|*[!0-9]*) HOOK_BYTES=0 ;; esac

TOTAL=$(( CLAUDE_BYTES + HOOK_BYTES ))

if [ "$MODE" = "bytes" ]; then
  printf '%s\n' "$TOTAL"
else
  printf 'boot cost: %s B (CLAUDE.md %s + hooks %s)\n' "$TOTAL" "$CLAUDE_BYTES" "$HOOK_BYTES"
fi
