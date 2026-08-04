#!/usr/bin/env bash
# api_credit_pool.sh — sourceable helper: the runner's METERED Claude-API
# RESERVE pool (task-874364a3).
#
# The operator added promo API credit to their PERSONAL Claude account
# (2026-07-25: $155). This lane lets the runner keep draining the queue during
# session-cap dead-time by re-running the SAME `claude -p` session with
# ANTHROPIC_API_KEY injected — metered API billing against that credit instead
# of the (capped) subscription pools. Policy, non-negotiable:
#   • RESERVE ONLY — drawn ONLY after every free subscription pool
#     (Max20x Fable → Claude Pro → Codex Business → Gemini, i.e. the whole
#     free Claude chain in cli_task_runner.sh) AND the opt-in DeepSeek/Kimi
#     agentic lane have declined. Never the default lane.
#   • Off out of the box: MYAI_API_CREDIT_USD unset/0 in .env = disabled.
#   • HARD spend cap on a LIFETIME ledger (the credit is a fixed pot, not a
#     daily allowance — unlike the agentic lane's day-ledger). Draws stop the
#     moment the cap is reached.
#   • Every draw is logged (one ledger line per draw: usd, UTC ts, model,
#     task id) and surfaced on the /schedule capacity panel via
#     scripts/pool_capacity_snapshot.sh.
#   • Never charged to the subscription pacing ledger (cli_task_runner.sh
#     charge block checks API_CREDIT_BILLED).
# Complements task-4f813e39 (agentic_fallback.sh) — same fallback slot, own
# billing. Not executed directly — sourced by cli_task_runner.sh,
# pool_capacity_snapshot.sh, and the test suite.

API_CREDIT_USD=${API_CREDIT_USD:-0}
API_CREDIT_HARD_CAP_USD=${API_CREDIT_HARD_CAP_USD:-$API_CREDIT_USD}
API_CREDIT_MODEL=${API_CREDIT_MODEL:-claude-sonnet-5}
# Cost estimate = output-tokens × output-rate × overhead. The runner only
# measures OUTPUT tokens (session_tokens.py transcript delta), so the overhead
# factor conservatively covers input-token cost. Tune from real /usage data.
API_CREDIT_EST_OVERHEAD=${API_CREDIT_EST_OVERHEAD:-1.5}
API_CREDIT_LEDGER_DIR=${API_CREDIT_LEDGER_DIR:-${RUNNER_STATE_DIR:-$HOME/.ai-cli-runner}/api-credit}

# api_credit_enabled — rc 0 when the operator has declared credit (> 0).
api_credit_enabled() {
    awk -v c="${API_CREDIT_USD:-0}" 'BEGIN { exit !(c+0 > 0) }' 2>/dev/null
}

# api_credit_cap_usd — the effective hard cap: the declared hard cap, floored
# at the credit itself (a cap above the pot would draw dollars that don't exist).
api_credit_cap_usd() {
    awk -v cap="${API_CREDIT_HARD_CAP_USD:-0}" -v credit="${API_CREDIT_USD:-0}" \
        'BEGIN { c = (cap+0 < credit+0) ? cap : credit; printf "%.2f", c+0 }'
}

# ── LIFETIME USD ledger (machine-local, like the pacing ledger — never git) ──
# One append-only file; each draw is one line: "<usd> <utc-ts> <model> <task-id>"
api_credit_ledger_file() {
    mkdir -p "$API_CREDIT_LEDGER_DIR" 2>/dev/null || true
    printf '%s/draws.usd' "$API_CREDIT_LEDGER_DIR"
}

api_credit_spent_usd() {
    local f; f="$(api_credit_ledger_file)"
    [ -f "$f" ] && awk '{s+=$1} END {printf "%.2f", s+0}' "$f" 2>/dev/null || printf '0.00'
}

api_credit_remaining_usd() {
    awk -v cap="$(api_credit_cap_usd)" -v spent="$(api_credit_spent_usd)" \
        'BEGIN { r = cap - spent; if (r < 0) r = 0; printf "%.2f", r }'
}

# api_credit_budget_ok — rc 0 while lifetime spend is under the effective cap.
api_credit_budget_ok() {
    awk -v spent="$(api_credit_spent_usd)" -v cap="$(api_credit_cap_usd)" \
        'BEGIN { exit !(spent+0 < cap+0) }'
}

# api_credit_record_draw <usd> <model> <task-id> — log one draw. Recorded
# REGARDLESS of run outcome (a failed run still billed tokens; under-counting
# would defeat the hard cap) — same rule as the agentic lane.
api_credit_record_draw() {
    local usd="${1:-}" model="${2:-unknown}" task="${3:-unknown}"
    case "$usd" in ''|*[!0-9.]*) return 0 ;; esac
    printf '%s %s %s %s\n' "$usd" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$model" "$task" \
        >> "$(api_credit_ledger_file)" 2>/dev/null || true
}

# api_credit_key — the ANTHROPIC_API_KEY for metered billing: environment
# first, else extract EXACTLY that one named key from the repo .env (same
# never-blanket-source hygiene as runner_budget.conf / agentic_fallback.sh).
api_credit_key() {
    local val env_file
    val="${ANTHROPIC_API_KEY:-}"
    if [ -z "$val" ]; then
        env_file="${API_CREDIT_ENV_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)/.env}"
        if [ -f "$env_file" ]; then
            val="$(grep -E '^ANTHROPIC_API_KEY=' "$env_file" 2>/dev/null | head -1 | cut -d= -f2-)"
            val="${val%%#*}"
            val="${val%"${val##*[![:space:]]}"}"
            val="${val#\"}"; val="${val%\"}"
        fi
    fi
    [ -n "$val" ] || return 1
    printf '%s' "$val"
}

# api_credit_out_rate <model> — output USD per MTok (Anthropic API list prices,
# claude-api skill cache 2026-06-24). Unknown model → Opus rate (conservative).
api_credit_out_rate() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        claude-fable-5|claude-mythos-5)        printf '50' ;;
        claude-opus-5|claude-opus-4-*)         printf '25' ;;
        claude-sonnet-5|claude-sonnet-4-*)     printf '15' ;;
        claude-haiku-*)                        printf '5'  ;;
        *)                                     printf '25' ;;
    esac
}

# api_credit_est_usd <model> <output_tokens> — estimated draw for a session.
api_credit_est_usd() {
    local model="${1:-}" tok="${2:-0}"
    case "$tok" in ''|*[!0-9]*) tok=0 ;; esac
    awk -v t="$tok" -v r="$(api_credit_out_rate "$model")" -v o="${API_CREDIT_EST_OVERHEAD:-1.5}" \
        'BEGIN { printf "%.4f", t * r / 1000000 * o }'
}

# api_credit_ready — rc 0 when the reserve may engage: credit declared, a key
# resolvable, and lifetime spend under the hard cap. Prints the human reason
# it is NOT ready on rc 1 (for the runner log).
api_credit_ready() {
    if ! api_credit_enabled; then echo "reserve off (MYAI_API_CREDIT_USD unset/0 in .env)"; return 1; fi
    if ! api_credit_key >/dev/null 2>&1; then echo "no ANTHROPIC_API_KEY (env or .env)"; return 1; fi
    if ! api_credit_budget_ok; then echo "hard cap reached (\$$(api_credit_spent_usd) of \$$(api_credit_cap_usd))"; return 1; fi
    return 0
}
