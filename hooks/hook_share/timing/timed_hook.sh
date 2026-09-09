#!/usr/bin/env bash
# timed_hook.sh — shared SessionStart hook timing wrapper (OPS task-085b3748).
#
# WHY: hooks/session/ holds 25+ SessionStart hooks, several doing network or
# Docker I/O (03-docker-health, 04-atlas-connectivity, 18-machine-selfheal,
# 19-vercel-gate-guard). A slow or hanging hook silently taxes EVERY boot,
# undercutting the fast-cold-start goal in plan/TOKEN_OPTIMIZATION.md — and
# until this wrapper existed nothing measured where boot wall-clock went.
#
# WHAT: .claude/settings.json invokes each SessionStart hook THROUGH this
# wrapper:
#   "command": "./hooks/hook_share/timing/timed_hook.sh ./hooks/session/03-docker-health.sh"
# The wrapper forwards stdin (the hook JSON, which carries session_id) and all
# output untouched, preserves the hook's exit code, and appends one line
#   <boot_id> <start_ms> <dur_ms> <exit> <hook_basename>
# to a per-machine rotating log (state/.hook-timing.log.<host> — same
# local_state_path convention as .session-metrics, so Dropbox never sees a
# cross-machine write race). The LAST hook to finish in a boot (hooks run in
# parallel — entry count reaching the settings.json wrapped-hook count is the
# completion signal) prints a compact "slowest 3 hooks" warning line, but ONLY
# when the boot's wall-clock exceeds the configured budget
# (config/session-limits.json → session_hooks.budget_ms, default 20000). The
# fast path prints nothing. `myai doctor` reads the same log to expose the
# last boot's breakdown.
#
# NON-FATAL CONTRACT: timing failures (no state dir, unwritable log, missing
# perl/python3) never change the wrapped hook's behavior or exit code, and a
# failing hook still gets its duration recorded. Lives in hooks/hook_share/
# (NOT hooks/session/) so the gateway's bash-hook loader never registers the
# wrapper itself as a hook.
#
# Env overrides (used by scripts/tests/test_session_hook_timing.sh):
#   HOOK_TIMING_LOG        log file path (skips state-dir + host-suffix resolution)
#   HOOK_TIMING_BOOT_ID    boot id (skips session_id extraction from stdin JSON)
#   HOOK_TIMING_BUDGET_MS  wall-clock budget in ms (skips config read)
#   HOOK_TIMING_EXPECTED   expected hook count for this boot (skips settings.json grep)
#   HOOK_TIMING_SETTINGS   settings.json path to count wrapped hooks in
set +e

HOOK="${1:-}"
[ -n "$HOOK" ] && shift

# ── resolve repo root + the hook path (settings.json runs commands with
#    cwd = project root; fall back to script-relative for manual runs) ──────
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -n "$ROOT" ] || ROOT="$(cd "$SCRIPT_DIR/../../.." 2>/dev/null && pwd)"
[ -n "$ROOT" ] || ROOT="$(pwd)"

if [ -n "$HOOK" ] && [ ! -f "$HOOK" ] && [ -f "$ROOT/${HOOK#./}" ]; then
    HOOK="$ROOT/${HOOK#./}"
fi

# No hook / missing hook: mirror the harness's silent-skip behavior.
if [ -z "$HOOK" ] || [ ! -f "$HOOK" ]; then
    exit 0
fi
HOOK_NAME="$(basename "$HOOK")"

# ── forward-able stdin (the SessionStart JSON). Guard against a tty so a
#    manual terminal run never blocks on cat. ───────────────────────────────
INPUT=""
if [ ! -t 0 ]; then
    INPUT="$(cat 2>/dev/null)"
fi

now_ms() {
    if command -v perl >/dev/null 2>&1; then
        perl -MTime::HiRes=time -e 'printf("%d", time()*1000)' 2>/dev/null && return 0
    fi
    echo $(( $(date +%s) * 1000 ))
}

# ── output cap (TOKEN task-2a431e9b) ────────────────────────────────────────
# Every wrapped SessionStart hook is capped to MAX_OUT lines of visible output
# so the framework's own boot chatter cannot dwarf the brain savings (see
# plan/DIRECTION_2026-09.md bet 1). A hook that wants to print more moves the
# detail behind `myai doctor`. The wrapper records the *emitted* byte count as a
# 6th log field so `scripts/boot_cost.sh` (called by wrap-up) can total
# CLAUDE.md + hook stdout — the per-session boot-cost KPI in the handoff header.
# Override the cap with HOOK_TIMING_MAX_OUTPUT_LINES (default 3).
MAX_OUT="${HOOK_TIMING_MAX_OUTPUT_LINES:-3}"
case "$MAX_OUT" in ''|*[!0-9]*) MAX_OUT=3 ;; esac
[ "$MAX_OUT" -ge 1 ] 2>/dev/null || MAX_OUT=3

# Capture the hook's combined stdout+stderr so it can be capped before the model
# ever sees it. mktemp failure degrades to a transparent (uncapped) passthrough.
OUTFILE="$(mktemp 2>/dev/null || printf '')"
trap 'rm -f "$OUTFILE" "$OUTFILE.capped" 2>/dev/null' EXIT
OUT_BYTES=0

run_hook() {
    # Run in the background + wait so a harness SIGTERM (per-hook timeout)
    # interrupts the wait and the trap can still record a timeout entry.
    if [ -n "$OUTFILE" ]; then
        if [ -n "$INPUT" ]; then
            printf '%s' "$INPUT" | "$HOOK" "$@" > "$OUTFILE" 2>&1 &
        else
            "$HOOK" "$@" < /dev/null > "$OUTFILE" 2>&1 &
        fi
    else
        if [ -n "$INPUT" ]; then
            printf '%s' "$INPUT" | "$HOOK" "$@" &
        else
            "$HOOK" "$@" < /dev/null &
        fi
    fi
    CHILD_PID=$!
    wait "$CHILD_PID"
}

# emit_capped — print at most MAX_OUT lines of the captured hook output, then
# set OUT_BYTES to the bytes actually emitted. When the hook produced more, the
# last of the MAX_OUT lines is a truncation note pointing at `myai doctor`, so
# the visible line count is never exceeded. Idempotent + non-fatal: a missing or
# empty capture (mktemp failed / hook streamed directly) is a no-op.
emit_capped() {
    OUT_BYTES=0
    [ -n "$OUTFILE" ] && [ -s "$OUTFILE" ] || return 0
    local nlines rest capped
    nlines="$(awk 'END{print NR}' "$OUTFILE" 2>/dev/null)"
    case "$nlines" in ''|*[!0-9]*) nlines=0 ;; esac
    if [ "$nlines" -le "$MAX_OUT" ]; then
        cat "$OUTFILE"
        OUT_BYTES="$(wc -c < "$OUTFILE" 2>/dev/null | tr -d '[:space:]')"
    else
        rest=$(( nlines - (MAX_OUT - 1) ))
        capped="$OUTFILE.capped"
        { head -n "$((MAX_OUT - 1))" "$OUTFILE"
          printf '  … +%s more line(s) hidden — run "myai doctor"\n' "$rest"; } > "$capped" 2>/dev/null
        cat "$capped" 2>/dev/null
        OUT_BYTES="$(wc -c < "$capped" 2>/dev/null | tr -d '[:space:]')"
        rm -f "$capped" 2>/dev/null
    fi
    case "$OUT_BYTES" in ''|*[!0-9]*) OUT_BYTES=0 ;; esac
}

# ── resolve the timing log (skip timing entirely if nothing is writable) ───
LOG_FILE="${HOOK_TIMING_LOG:-}"
if [ -z "$LOG_FILE" ]; then
    STATE_DIR=""
    if [ -d "$ROOT/state" ]; then
        STATE_DIR="$ROOT/state"
    elif [ -d "$ROOT/AI/state" ]; then
        STATE_DIR="$ROOT/AI/state"
    fi
    if [ -n "$STATE_DIR" ]; then
        # Per-machine suffix (same convention as .session-metrics — see
        # scripts/lib/local_state.sh for the Dropbox write-race root cause).
        local_state_path() { printf '%s' "$1"; }
        LSL="$ROOT/scripts/lib/local_state.sh"
        [ -f "$LSL" ] || LSL="$ROOT/AI/scripts/lib/local_state.sh"
        # shellcheck source=/dev/null
        [ -f "$LSL" ] && . "$LSL"
        LOG_FILE="$(local_state_path "$STATE_DIR/.hook-timing.log")"
    fi
fi

if [ -z "$LOG_FILE" ]; then
    # No place to record timing — still cap the hook's output, just skip the log.
    run_hook "$@"
    RC=$?
    emit_capped
    exit "$RC"
fi

# ── boot id: session_id from the hook JSON groups all hooks of one boot ────
BOOT_ID="${HOOK_TIMING_BOOT_ID:-}"
if [ -z "$BOOT_ID" ] && [ -n "$INPUT" ]; then
    BOOT_ID="$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 | tr -cd 'A-Za-z0-9_.-')"
fi
[ -n "$BOOT_ID" ] || BOOT_ID="manual-$(date +%s)-$$"

record_entry() {
    # $1 = exit code. Never let a timing write affect the hook outcome.
    END_MS="$(now_ms)"
    DUR_MS=$((END_MS - START_MS))
    [ "$DUR_MS" -ge 0 ] 2>/dev/null || DUR_MS=0
    # 6th field = bytes of visible (capped) hook output — the boot-cost input.
    { printf '%s %s %s %s %s %s\n' "$BOOT_ID" "$START_MS" "$DUR_MS" "$1" "$HOOK_NAME" "${OUT_BYTES:-0}" >> "$LOG_FILE"; } 2>/dev/null
}

# shellcheck disable=SC2329  # invoked indirectly via `trap on_term TERM INT`
on_term() {
    # Harness timeout kill: emit whatever the hook printed (capped), record what
    # we know (124 = timed out) and die.
    [ -n "${CHILD_PID:-}" ] && kill "$CHILD_PID" 2>/dev/null
    emit_capped
    record_entry 124
    exit 143
}
trap on_term TERM INT

CHILD_PID=""
START_MS="$(now_ms)"
run_hook "$@"
RC=$?
trap - TERM INT
emit_capped
record_entry "$RC"

# ── completion check: am I the last hook of this boot? ─────────────────────
EXPECTED="${HOOK_TIMING_EXPECTED:-}"
if [ -z "$EXPECTED" ]; then
    SETTINGS="${HOOK_TIMING_SETTINGS:-$ROOT/.claude/settings.json}"
    EXPECTED="$(grep -c 'timed_hook.sh' "$SETTINGS" 2>/dev/null)"
fi
case "$EXPECTED" in ''|*[!0-9]*) EXPECTED=0 ;; esac

GOT="$(grep -c "^$BOOT_ID " "$LOG_FILE" 2>/dev/null)"
case "$GOT" in ''|*[!0-9]*) GOT=0 ;; esac

if [ "$EXPECTED" -gt 0 ] && [ "$GOT" -ge "$EXPECTED" ]; then
    # Report exactly once per boot: atomic noclobber marker wins the race
    # between simultaneous finishers.
    MARK="$LOG_FILE.reported.$BOOT_ID"
    if ( set -C; : > "$MARK" ) 2>/dev/null; then
        BUDGET_MS="${HOOK_TIMING_BUDGET_MS:-}"
        CONF_MAX="" CONF_KEEP=""
        CONF="$ROOT/config/session-limits.json"
        [ -f "$CONF" ] || CONF="$ROOT/AI/config/session-limits.json"
        if [ -f "$CONF" ] && command -v python3 >/dev/null 2>&1; then
            # One python3 spawn, three values: "budget max keep".
            CONF_VALS="$(python3 -c 'import json,sys
try:
    s = json.load(open(sys.argv[1])).get("session_hooks", {})
    print(int(s.get("budget_ms", 20000)), int(s.get("log_max_lines", 4000)), int(s.get("log_keep_lines", 2000)))
except Exception:
    print(20000, 4000, 2000)' "$CONF" 2>/dev/null)"
            [ -n "$BUDGET_MS" ] || BUDGET_MS="$(printf '%s' "$CONF_VALS" | awk '{print $1}')"
            CONF_MAX="$(printf '%s' "$CONF_VALS" | awk '{print $2}')"
            CONF_KEEP="$(printf '%s' "$CONF_VALS" | awk '{print $3}')"
        fi
        case "$BUDGET_MS" in ''|*[!0-9]*) BUDGET_MS=20000 ;; esac

        BOOT_LINES="$(grep "^$BOOT_ID " "$LOG_FILE" 2>/dev/null)"
        # Hooks run in parallel: wall = latest finish - earliest start.
        WALL_MS="$(printf '%s\n' "$BOOT_LINES" | awk 'NF>=5{s=$2+0;e=$2+$3;if(min==""||s<min)min=s;if(e>max)max=e}END{if(min=="")print 0;else print max-min}')"
        case "$WALL_MS" in ''|*[!0-9]*) WALL_MS=0 ;; esac

        if [ "$WALL_MS" -gt "$BUDGET_MS" ]; then
            SLOWEST="$(printf '%s\n' "$BOOT_LINES" | sort -k3,3nr | head -3 | awk 'NF>=5{printf "%s%s %sms", (n++?", ":""), $5, $3}')"
            printf 'SESSION HOOK BUDGET: %s hooks took %sms wall (budget %sms) — slowest: %s\n' "$GOT" "$WALL_MS" "$BUDGET_MS" "$SLOWEST"
            printf '  breakdown: run "myai doctor" (session hook timing) - budget: config/session-limits.json -> session_hooks.budget_ms\n'
        fi

        # Rotation + stale-marker cleanup (single-threaded here, behind the
        # report lock, so parallel wrappers can never rotate concurrently).
        MAX_LINES="${HOOK_TIMING_MAX_LINES:-${CONF_MAX:-4000}}"
        KEEP_LINES="${HOOK_TIMING_KEEP_LINES:-${CONF_KEEP:-2000}}"
        case "$MAX_LINES" in ''|*[!0-9]*) MAX_LINES=4000 ;; esac
        case "$KEEP_LINES" in ''|*[!0-9]*) KEEP_LINES=2000 ;; esac
        LINE_COUNT="$(wc -l < "$LOG_FILE" 2>/dev/null | tr -d '[:space:]')"
        case "$LINE_COUNT" in ''|*[!0-9]*) LINE_COUNT=0 ;; esac
        if [ "$LINE_COUNT" -gt "$MAX_LINES" ]; then
            TMP_ROTATE="$LOG_FILE.tmp.$$"
            if tail -n "$KEEP_LINES" "$LOG_FILE" > "$TMP_ROTATE" 2>/dev/null; then
                mv -f "$TMP_ROTATE" "$LOG_FILE" 2>/dev/null
            fi
            rm -f "$TMP_ROTATE" 2>/dev/null
        fi
        find "$(dirname "$LOG_FILE")" -maxdepth 1 -name "$(basename "$LOG_FILE").reported.*" ! -name "$(basename "$MARK")" -mmin +720 -exec rm -f {} + 2>/dev/null
    fi
fi

exit "$RC"
