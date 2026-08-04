#!/usr/bin/env bash
# pool_capacity_snapshot.sh — bridge the runner's budget config + pacing ledger
# into a JSON capacity artifact the gateway/dashboard can read.
#
# WHY: the gateway/dashboard run in Docker and mount the repo (RO at AI_ROOT);
# they cannot see ~/.ai-cli-runner/pacing, which lives on the host outside the
# repo. Same bridge pattern as runner_health.sh: this host-side script derives
# the weekly token budget from config/runner_budget.conf (which itself imports
# the operator's MYAI_* plan vars from .env), reads this week's spend from the
# pacing ledger, and writes state/pool-capacity.json INTO the repo. The
# gateway's pool-capacity alerter (runtime/src/monitoring/pool-capacity-alerter.ts)
# and the /schedule capacity view read it off the mount.
#
# Week key matches the runner's pace_week() exactly (ISO year-week, Sydney) —
# the ledger resets Monday 00:00 Australia/Sydney.
#
# Usage:
#   ./scripts/pool_capacity_snapshot.sh                    # → state/pool-capacity.json
#   POOL_CAPACITY_OUT=/tmp/pc.json ./scripts/pool_capacity_snapshot.sh
#   PACE_LEDGER=/path/to/pacing ./scripts/pool_capacity_snapshot.sh
#
# Safe to run repeatedly (idempotent — atomically rewrites the artifact).
# Never fails a caller: no declared budget → writes the artifact with
# weeklyBudgetTokens 0 (the alerter treats that as "gate off") and exits 0.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OUT="${POOL_CAPACITY_OUT:-$REPO_ROOT/state/pool-capacity.json}"
LEDGER="${PACE_LEDGER:-${RUNNER_STATE_DIR:-$HOME/.ai-cli-runner}/pacing}"

mkdir -p "$(dirname "$OUT")"

# Derive AUTO_WEEKLY_TOKEN_BUDGET the same way the runner does — source the
# committed budget conf, which imports the operator's MYAI_* vars from .env.
# shellcheck disable=SC1091
. "$REPO_ROOT/config/runner_budget.conf" 2>/dev/null || true

week="$(TZ=Australia/Sydney date +%G-W%V)"   # == cli_task_runner.sh pace_week()
day="$(TZ=Australia/Sydney date +%Y%m%d)"    # == pace_day()

read_int() { local v; v="$(cat "$1" 2>/dev/null | tr -cd '0-9')"; echo "${v:-0}"; }

spent_week="$(read_int "$LEDGER/tok-$week")"
spent_day="$(read_int "$LEDGER/tok-$day")"

budget_week="${AUTO_WEEKLY_TOKEN_BUDGET:-0}"
case "$budget_week" in ''|*[!0-9]*) budget_week=0 ;; esac
budget_day="${AUTO_DAILY_TOKEN_BUDGET:-0}"
case "$budget_day" in ''|*[!0-9]*) budget_day=0 ;; esac
if [ "$budget_day" -eq 0 ] && [ "$budget_week" -gt 0 ]; then
  budget_day=$(( budget_week / 7 ))
fi

remaining_week=$(( budget_week - spent_week ))
[ "$remaining_week" -lt 0 ] && remaining_week=0
if [ "$budget_week" -gt 0 ]; then
  pct_week="$(awk "BEGIN{printf \"%.1f\", ${spent_week}*100/${budget_week}}")"
else
  pct_week="0"
fi

# ── claude-tech session% (AVAILABILITY dimension for the runner's
# capability×cost×availability router — route_task_model in cli_task_runner.sh
# reads this alongside pctUsedWeekly to decide when tech is "hot"). ──────────
sess_today="$(read_int "$LEDGER/sess-$day")"
sess_daily_cap="${AUTO_DAILY_SESSIONS:-0}"
case "$sess_daily_cap" in ''|*[!0-9]*) sess_daily_cap=0 ;; esac
if [ "$sess_daily_cap" -gt 0 ]; then
  pct_session="$(awk "BEGIN{printf \"%.1f\", ${sess_today}*100/${sess_daily_cap}}")"
else
  pct_session="0"
fi

# ── Fable's OWN paced weekly bucket (operator directive 2026-07-26 — REPLACES
# PR #393's blanket exemption; Fable is now paced like every other pool on its
# own ledger keys, see AUTO_*_FABLE_* in cli_task_runner.sh). ────────────────
fable_sess_today="$(read_int "$LEDGER/fable-sess-$day")"
fable_sess_week="$(read_int "$LEDGER/fable-sess-$week")"
fable_tok_week="$(read_int "$LEDGER/fable-tok-$week")"
fable_sess_cap="${AUTO_WEEKLY_FABLE_SESSIONS:-40}"
case "$fable_sess_cap" in ''|*[!0-9]*) fable_sess_cap=40 ;; esac
fable_tok_budget="${AUTO_WEEKLY_FABLE_TOKEN_BUDGET:-0}"
case "$fable_tok_budget" in ''|*[!0-9]*) fable_tok_budget=0 ;; esac
if [ "$fable_sess_cap" -gt 0 ]; then
  fable_pct="$(awk "BEGIN{printf \"%.1f\", ${fable_sess_week}*100/${fable_sess_cap}}")"
else
  fable_pct="0"
fi
fable_remaining_week=$(( fable_tok_budget - fable_tok_week ))
[ "$fable_remaining_week" -lt 0 ] && fable_remaining_week=0

generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── Metered API-credit RESERVE pool (task-874364a3) ───────────
# USD-denominated lifetime pot, not a weekly token budget — the token fields
# are emitted as 0 so the token-based alerter treats it as "gate off" and the
# /schedule capacity panel reads the *Usd fields instead. Also carries
# "period":"lifetime" + "capUsd" (task-d383b7e8) so pool-capacity-alerter.ts's
# generalized USD path proactively alerts (Telegram + dashboard bell) at 80%/
# 100% of the hard cap instead of requiring an operator to notice the number
# on the dashboard going low.
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/api_credit_pool.sh" 2>/dev/null || true
ac_enabled=false
if command -v api_credit_enabled >/dev/null 2>&1 && api_credit_enabled 2>/dev/null; then ac_enabled=true; fi
ac_credit="$(api_credit_cap_usd 2>/dev/null || echo 0.00)"
ac_spent="$(api_credit_spent_usd 2>/dev/null || echo 0.00)"
ac_remaining="$(api_credit_remaining_usd 2>/dev/null || echo 0.00)"
ac_pct="$(awk -v s="$ac_spent" -v c="$ac_credit" 'BEGIN { if (c+0 > 0) printf "%.1f", s*100/c; else printf "0" }')"

# ── Non-Claude agentic-fallback lane's OWN USD day-ledger (task-4f813e39) ───
# Real API-billed $ against DeepSeek/Kimi, separate from every Claude pool
# above and from the api-credit reserve — resets DAILY (Sydney), not weekly,
# so it carries "period":"daily" and is keyed off the top-level "day" field
# below instead of "week" (pool-capacity-alerter.ts dedups on whichever period
# the entry declares — see task-f5897132).
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/agentic_fallback.sh" 2>/dev/null || true
af_enabled=false
[ "${AGENTIC_FALLBACK:-off}" = "on" ] && af_enabled=true
af_cap="${AGENTIC_FALLBACK_DAILY_USD_CAP:-2.00}"
af_spent="$(agentic_spent_today_usd 2>/dev/null || echo 0)"
af_remaining="$(awk -v s="$af_spent" -v c="$af_cap" 'BEGIN { r = c-s; if (r < 0) r = 0; printf "%.6f", r }')"
af_pct="$(awk -v s="$af_spent" -v c="$af_cap" 'BEGIN { if (c+0 > 0) printf "%.1f", s*100/c; else printf "0" }')"
# Per-provider pass-rate rollup (task-80ba3a74) — same rolling window
# agentic_quality_rollup logs to logs/claude_log.md, JSON-shaped for the
# dashboard's agentic-fallback panel instead of log-text-only.
af_quality="$(agentic_quality_json 2>/dev/null || echo '[]')"

tmp="$(mktemp "${OUT}.XXXXXX")"
cat > "$tmp" <<EOF
{
  "generatedAt": "$generated_at",
  "week": "$week",
  "day": "$day",
  "source": "pool_capacity_snapshot.sh (runner_budget.conf + pacing ledger)",
  "pools": [
    {
      "pool": "claude-tech",
      "weeklyBudgetTokens": $budget_week,
      "weeklySpentTokens": $spent_week,
      "weeklyRemainingTokens": $remaining_week,
      "pctUsedWeekly": $pct_week,
      "dailyBudgetTokens": $budget_day,
      "dailySpentTokens": $spent_day,
      "dailySessionsUsed": $sess_today,
      "dailySessionsBudget": $sess_daily_cap,
      "pctUsedSession": $pct_session
    },
    {
      "pool": "fable",
      "kind": "paced-weekly-bucket",
      "note": "own separate bucket (never exempt — PR #393's blanket exemption removed 2026-07-26); used for reserve-headroom shifts off a hot claude-tech pool, or a deliberate expiring-credit window, never as a default",
      "weeklySessionsUsed": $fable_sess_week,
      "weeklySessionsBudget": $fable_sess_cap,
      "dailySessionsUsed": $fable_sess_today,
      "weeklyBudgetTokens": $fable_tok_budget,
      "weeklySpentTokens": $fable_tok_week,
      "weeklyRemainingTokens": $fable_remaining_week,
      "pctUsedWeekly": $fable_pct
    },
    {
      "pool": "claude-api-credit",
      "kind": "usd-reserve",
      "period": "lifetime",
      "note": "operator's personal metered Claude-API credit (task-874364a3) — a fixed lifetime pot, not a resetting budget; alerted via pool-capacity-alerter.ts's lifetime USD path (task-d383b7e8) at MYAI_POOL_ALERT_PCT / MYAI_POOL_ALERT_PCT_CRITICAL_LIFETIME (default 80/100)",
      "enabled": $ac_enabled,
      "hardCapUsd": ${ac_credit:-0},
      "capUsd": ${ac_credit:-0},
      "spentUsd": ${ac_spent:-0},
      "remainingUsd": ${ac_remaining:-0},
      "pctUsedUsd": ${ac_pct:-0},
      "weeklyBudgetTokens": 0,
      "weeklySpentTokens": 0,
      "weeklyRemainingTokens": 0,
      "pctUsedWeekly": 0
    },
    {
      "pool": "agentic-fallback",
      "kind": "usd-daily",
      "period": "daily",
      "note": "DeepSeek/Kimi non-Claude fallback lane (scripts/lib/agentic_fallback.sh) — own real-$ day-ledger, resets daily Sydney time, separate from every Claude pool above",
      "enabled": $af_enabled,
      "capUsd": ${af_cap:-0},
      "spentUsd": ${af_spent:-0},
      "remainingUsd": ${af_remaining:-0},
      "pctUsedUsd": ${af_pct:-0},
      "qualityByProvider": ${af_quality:-[]},
      "weeklyBudgetTokens": 0,
      "weeklySpentTokens": 0,
      "weeklyRemainingTokens": 0,
      "pctUsedWeekly": 0
    },
    {
      "pool": "codex",
      "kind": "unconfigured",
      "configured": false,
      "note": "L4 roadmap (plan/MULTI_PROVIDER_ORCHESTRATION.md) — no CLI_CMD wiring yet, not a routable pool",
      "weeklyBudgetTokens": 0,
      "weeklySpentTokens": 0,
      "weeklyRemainingTokens": 0,
      "pctUsedWeekly": 0
    },
    {
      "pool": "gemini",
      "kind": "unconfigured",
      "configured": false,
      "note": "L4 roadmap (plan/MULTI_PROVIDER_ORCHESTRATION.md) — no CLI_CMD wiring yet, not a routable pool",
      "weeklyBudgetTokens": 0,
      "weeklySpentTokens": 0,
      "weeklyRemainingTokens": 0,
      "pctUsedWeekly": 0
    }
  ]
}
EOF
mv "$tmp" "$OUT"

echo "pool_capacity: $week spent=$spent_week budget=$budget_week remaining=$remaining_week (${pct_week}%); api-credit reserve enabled=$ac_enabled spent=\$$ac_spent cap=\$$ac_credit remaining=\$$ac_remaining; agentic-fallback enabled=$af_enabled spent=\$$af_spent cap=\$$af_cap remaining=\$$af_remaining ($af_pct%) → $OUT"
