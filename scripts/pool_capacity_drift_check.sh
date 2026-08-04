#!/usr/bin/env bash
# pool_capacity_drift_check.sh — periodic ground-truth self-check for
# state/pool-capacity.json (task-0824a68e).
#
# WHY: the capability×cost×availability router (task-21dc2746) and the
# API-credit reserve (task-874364a3) both make routing decisions off
# state/pool-capacity.json, which pool_capacity_snapshot.sh writes from an
# INCREMENTAL ledger (scripts/lib/session_tokens.py snapshot/delta). Nothing
# previously cross-checked that ledger against reality — a bug in the
# snapshot writer (a missed transcript, a lost snapshot marker across a
# runner restart, a CLAUDE_CONFIG_DIR mismatch) could silently mis-route work
# for days before a human noticed. This re-derives claude-tech's daily/weekly
# spent-token figures directly from the Claude Code transcripts
# (scripts/lib/pool_capacity_drift.py — sums message.usage.output_tokens for
# the current Sydney day/week window, no offset bookkeeping) and LOGS drift
# beyond tolerance. It never rewrites pool-capacity.json or the pacing
# ledger — auto-"fixing" a bookkeeping bug from a second, possibly-also-buggy
# computation would be worse than a human eyeballing the log.
#
# ALERTING (task-05526048): beyond the log, every run also writes a JSON
# bridge artifact (state/pool-capacity-drift-status.json by default) — same
# bridge pattern as pool_capacity_snapshot.sh / docker_vm_disk_snapshot.sh.
# runtime/src/monitoring/pool-capacity-drift-alerter.ts reads it off the repo
# mount and pushes a Telegram + dashboard-bell alert on DRIFT, so a persistent
# ledger bug reaches the operator instead of requiring someone to tail this
# log by hand.
#
# Usage:
#   ./scripts/pool_capacity_drift_check.sh
#   POOL_CAPACITY_OUT=/tmp/pc.json CLAUDE_CONFIG_DIR=/tmp/cfg ./scripts/pool_capacity_drift_check.sh
#
# Env:
#   POOL_CAPACITY_OUT               snapshot artifact to check (default state/pool-capacity.json)
#   CLAUDE_CONFIG_DIR               transcript root (default $HOME/.claude-tech — the runner's scheduled profile)
#   POOL_CAPACITY_DRIFT_LOG         append-only drift log (default ~/.ai-cli-runner/pool-capacity-drift.log)
#   POOL_CAPACITY_DRIFT_STATUS_OUT  JSON alert-bridge artifact (default state/pool-capacity-drift-status.json)
#   DRIFT_TOLERANCE_PCT             relative tolerance, percent of actual usage (default 10)
#   DRIFT_TOLERANCE_TOKENS          absolute floor below which drift is noise (default 5000 — comfortably
#                                   bigger than one concurrent in-flight session's not-yet-charged tokens)
#
# Never fails its caller (always exits 0) — this is a monitoring self-check,
# not a gate. Every run (OK and DRIFT) is appended to the log, so the log also
# proves the check is alive, not just silent because nothing ever ran.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PY="${PYTHON_BIN:-python3}"

OUT="${POOL_CAPACITY_OUT:-$REPO_ROOT/state/pool-capacity.json}"
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude-tech}"
LOG="${POOL_CAPACITY_DRIFT_LOG:-${RUNNER_STATE_DIR:-$HOME/.ai-cli-runner}/pool-capacity-drift.log}"
TOL_PCT="${DRIFT_TOLERANCE_PCT:-10}"
TOL_FLOOR="${DRIFT_TOLERANCE_TOKENS:-5000}"
export POOL_CAPACITY_DRIFT_STATUS_OUT="${POOL_CAPACITY_DRIFT_STATUS_OUT:-$REPO_ROOT/state/pool-capacity-drift-status.json}"

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

RESULT="$("$PY" "$SCRIPT_DIR/lib/pool_capacity_drift.py" "$OUT" "$CFG" "$TOL_PCT" "$TOL_FLOOR" 2>&1)"
RC=$?

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
while IFS= read -r line; do
    [ -n "$line" ] && printf '%s %s\n' "$TS" "$line" >> "$LOG" 2>/dev/null || true
done <<< "$RESULT"

echo "$RESULT"
if [ "$RC" -eq 1 ]; then
    echo "pool_capacity_drift_check: DRIFT detected beyond tolerance (${TOL_PCT}% / ${TOL_FLOOR} tok) — see $LOG"
fi
exit 0
