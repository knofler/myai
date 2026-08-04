#!/usr/bin/env bash
# agentic_fallback.sh — sourceable helper: the runner's non-Claude AGENTIC
# fallback lane (DeepSeek / Kimi via their OpenAI-compatible APIs).
#
# task-4f813e39 / plan/ADR_AGENTIC_FALLBACK_LANE.md: when the Claude
# subscription's 5h session window is exhausted, ALL Claude models (incl. free
# Fable) are blocked and the runner can only release tasks and idle. DeepSeek/
# Kimi are separately billed and unaffected — this lane gives them a REAL
# edit→test→commit→push execution path (scripts/lib/openai_agent.py drives the
# tool loop; this file owns the rails around it), same contract as the Ollama
# local tier (ollama_local_tier.sh):
#   - rc 0 ONLY on a genuine push to origin/test (caller falls back otherwise)
#   - test branch only, never main, one rebase retry, never force-push
#   - its OWN USD day-ledger + cap (~/.ai-cli-runner/agentic/) — these bill
#     real API dollars, so the lane is opt-in (AGENTIC_FALLBACK=off default)
#     and completely separate from the Claude pacing ledger
#   - keys via env / .env named-key extraction only (never blanket-source .env)
# Not executed directly — sourced by cli_task_runner.sh (and the test suite).

AGENTIC_FALLBACK=${AGENTIC_FALLBACK:-off}
AGENTIC_FALLBACK_MODELS=${AGENTIC_FALLBACK_MODELS:-deepseek-chat}
AGENTIC_FALLBACK_DAILY_USD_CAP=${AGENTIC_FALLBACK_DAILY_USD_CAP:-2.00}
AGENTIC_MAX_ITERS=${AGENTIC_MAX_ITERS:-24}
AGENTIC_CMD_TIMEOUT_SEC=${AGENTIC_CMD_TIMEOUT_SEC:-300}
AGENTIC_LEDGER_DIR=${AGENTIC_LEDGER_DIR:-${RUNNER_STATE_DIR:-$HOME/.ai-cli-runner}/agentic}
AGENTIC_QUALITY_FILE=${AGENTIC_QUALITY_FILE:-$AGENTIC_LEDGER_DIR/outcomes.log}
AGENTIC_QUALITY_WINDOW=${AGENTIC_QUALITY_WINDOW:-20}

# ── OPT-IN QUEUE-DEPTH OVERFLOW TRIGGER (ADR follow-up, task-3e57fd93) ──────
# plan/ADR_AGENTIC_FALLBACK_LANE.md's Follow-ups list called this out:
# "optional promotion from fallback-only to a scheduled overflow lane". Today
# the lane above only engages AFTER the whole Claude chain has already died on
# the account-limit signature (agentic_fallback_ready/agentic_fallback_run) —
# it never fires while Claude still has headroom, even if the P2/P3 backlog is
# deep. This is a SECOND, independent trigger: an operator opts a repo/machine
# into proactively draining a deep low-priority backlog through the same paid
# lane, on a schedule of their choosing (e.g. only during an off-hours cron
# window), instead of waiting for a Claude cap. Deliberately a SEPARATE master
# switch from AGENTIC_FALLBACK — either trigger can run alone, together, or
# neither; enabling one never implies the other. Shares every safety rail with
# the crisis trigger (same $/day ledger + cap, same worktree/watchdog/git
# rails in _agentic_run_inner, same default-off posture) via
# agentic_lane_common_ready below — the only NEW gates are priority-band
# eligibility and a measured pending-queue-depth floor.
AGENTIC_OVERFLOW=${AGENTIC_OVERFLOW:-off}
AGENTIC_OVERFLOW_PRIORITIES=${AGENTIC_OVERFLOW_PRIORITIES:-"P2 P3"}
AGENTIC_OVERFLOW_MIN_QUEUE_DEPTH=${AGENTIC_OVERFLOW_MIN_QUEUE_DEPTH:-8}

# ── ALL-POOLS-CAPPED CROSS-PROVIDER DEMOTION (plan/MULTI_PROVIDER_ORCHESTRATION.md
# §4b, task-4b37f17d) ────────────────────────────────────────────────────────
# A THIRD, independent trigger for the same lane — distinct from both the
# crisis trigger above (only engages AFTER a live Claude session has already
# died on the account-limit signature) and the queue-depth overflow trigger
# (engages proactively while Claude still has headroom). This one fires
# BEFORE a session is even attempted: the runner's capability×cost×
# availability router (route_task_model in cli_task_runner.sh) already tracks
# state/pool-capacity.json + the pacing ledgers and sets ROUTE_EXHAUSTED=true
# when EVERY Claude pool it checks (tech + Fable) is confirmed out of
# headroom for an already-claimed task. §4b's target design: instead of
# releasing that task back to pending until the next reset ("paused until
# Monday"), offer it to this lane first ("demoted to metered API until
# Monday") — reusing every rail below (worktree/watchdog/git, $/day cap)
# exactly like AGENTIC_OVERFLOW already does. Deliberately a SEPARATE master
# switch — an operator can run any subset of the three triggers.
AGENTIC_EXHAUSTION_DEMOTION=${AGENTIC_EXHAUSTION_DEMOTION:-off}

# Same account-limit signature the runner's close-off release path greps for
# (cli_task_runner.sh account-limit branch) — kept here so the fallback trigger
# and any future callers share one definition.
AGENTIC_LIMIT_REGEX='hit your (session|usage) limit|session limit.*resets|usage limit.*resets|out of usage credits'

# agentic_model_match <model> — rc 0 when the model id belongs to this lane.
agentic_model_match() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        deepseek-*|kimi-*|moonshot-*) return 0 ;;
        *) return 1 ;;
    esac
}

# agentic_base_url <model> — OpenAI-compatible endpoint for the model's vendor.
agentic_base_url() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        deepseek-*)          printf '%s' "${DEEPSEEK_BASE_URL:-https://api.deepseek.com/v1}" ;;
        kimi-*|moonshot-*)   printf '%s' "${MOONSHOT_BASE_URL:-https://api.moonshot.ai/v1}" ;;
        *) return 1 ;;
    esac
}

# agentic_key_env <model> — NAME of the env var carrying the vendor's API key.
agentic_key_env() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        deepseek-*)          printf 'DEEPSEEK_API_KEY' ;;
        kimi-*|moonshot-*)   printf 'MOONSHOT_API_KEY' ;;
        *) return 1 ;;
    esac
}

# agentic_api_key <model> — the key itself: environment first, else extract
# EXACTLY that one named key from the repo .env (same never-blanket-source
# hygiene as runner_budget.conf's MYAI_* import). Empty + rc 1 when absent.
agentic_api_key() {
    local var val env_file
    var="$(agentic_key_env "$1")" || return 1
    val="$(eval "printf '%s' \"\${$var:-}\"")"
    if [ -z "$val" ]; then
        env_file="${AGENTIC_ENV_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)/.env}"
        if [ -f "$env_file" ]; then
            val="$(grep -E "^${var}=" "$env_file" 2>/dev/null | head -1 | cut -d= -f2-)"
            val="${val%%#*}"
            val="${val%"${val##*[![:space:]]}"}"
            val="${val#\"}"; val="${val%\"}"
        fi
    fi
    [ -n "$val" ] || return 1
    printf '%s' "$val"
}

agentic_first_model() { set -- $AGENTIC_FALLBACK_MODELS; printf '%s' "${1:-}"; }

# agentic_pricing_stale_warning — pre-run check for the ADR's pricing-drift
# follow-up (plan/ADR_AGENTIC_FALLBACK_LANE.md Consequences: "pricing table
# refresh cadence (unit prices drift)"). Prints openai_agent.py's warning line
# when its PRICES_PER_M table (which the $/day budget cap depends on) hasn't
# been refreshed within PRICING_MAX_AGE_DAYS, empty string otherwise. Purely
# informational — never blocks a run (no live vendor pricing API exists for a
# stdlib-only lane to pull from; an operator has to do the actual refresh).
agentic_pricing_stale_warning() {
    local py out
    py="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/openai_agent.py"
    out="$(/usr/bin/python3 "$py" --check-pricing 2>/dev/null)"
    # rc 1 == stale (print the warning); rc 0 == fresh (stay silent).
    if [ $? -ne 0 ]; then
        printf '%s' "$out"
    fi
    return 0
}

# agentic_provider_name <model> — canonical vendor label for the execution-lane
# stamp (task-b1776200: dashboard visibility for which provider actually wrote
# a shipped diff), distinct from the specific model id (e.g. "deepseek-chat").
agentic_provider_name() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        deepseek-*)          printf 'deepseek' ;;
        kimi-*|moonshot-*)   printf 'kimi' ;;
        *) printf '%s' "${1:-}" ;;
    esac
}

# agentic_execution_lane <used-model> — "claude" or "agentic-fallback": the
# task-store executionLane stamp (task-b1776200), based on which model
# actually executed. The runner calls this once USED_MODEL is settled (after
# the whole model-fallback chain, incl. the agentic-fallback retry, has run)
# so an operator reviewing a task's commit doesn't have to grep the runner log
# to tell whether Claude or the non-Claude DeepSeek/Kimi lane wrote the diff.
agentic_execution_lane() {
    if agentic_model_match "${1:-}"; then printf 'agentic-fallback'; else printf 'claude'; fi
}

# ── USD day-ledger (machine-local, like the pacing ledger — never git) ──────
agentic_ledger_file() {
    mkdir -p "$AGENTIC_LEDGER_DIR" 2>/dev/null || true
    printf '%s/%s.usd' "$AGENTIC_LEDGER_DIR" "$(TZ=Australia/Sydney date +%Y%m%d)"
}

agentic_spent_today_usd() {
    local f; f="$(agentic_ledger_file)"
    [ -f "$f" ] && awk '{s+=$1} END {printf "%.6f", s+0}' "$f" 2>/dev/null || printf '0'
}

agentic_add_spend_usd() {
    case "${1:-}" in ''|*[!0-9.]*) return 0 ;; esac
    echo "$1" >> "$(agentic_ledger_file)" 2>/dev/null || true
}

# agentic_budget_ok — rc 0 while today's spend is under the USD cap.
agentic_budget_ok() {
    awk -v spent="$(agentic_spent_today_usd)" -v cap="$AGENTIC_FALLBACK_DAILY_USD_CAP" \
        'BEGIN { exit !(spent+0 < cap+0) }'
}

# ── per-model quality tracking (plan/ADR_AGENTIC_FALLBACK_LANE.md follow-up:
# "does DeepSeek's review-rate justify the spend") ──────────────────────────
# The $/day ledger above answers "how much did this lane cost"; this ledger
# answers "was it worth it" — a rolling per-model pass-rate so the model→
# endpoint mapping can eventually be weighted toward the better performer.
#
# Keyed by PROVIDER (agentic_provider_name: "deepseek"/"kimi"), not the exact
# model id — the task store only persists executionProvider (task-b1776200),
# not the exact model that landed a fix, so that's the finest grain a
# reconcile-time confirmation (below) can ever attribute back to. In
# practice AGENTIC_FALLBACK_MODELS is one model per vendor, so this is a
# distinction without a difference for the ADR's actual question (DeepSeek
# vs Kimi).
#
# One append-only line per fallback ATTEMPT (machine-local, never git, same
# hygiene as the USD ledger): "<ISO8601-UTC> <provider> <outcome> <taskId>".
# Recorded at every _agentic_run_inner exit point (below) — every attempt
# counts, not just ones that end up as the session's USED_MODEL, so a lane
# failure that falls through to a Claude retry still shows up here. "shipped"
# is the immediate signal (a clean push landed, no guard trip); a task whose
# work later survives to `main` gets a second, stronger "confirmed" record
# from reconcile_review_tasks.sh's flip_review_task (review→done reconcile —
# the closest thing this fleet has to a human review verdict, since no task
# revert/reopen lifecycle event exists yet to source a true "reverted" tag).

# agentic_record_outcome PROVIDER OUTCOME [TASK-ID] — append one attempt
# record. OUTCOME is a free-form tag; agentic_quality_pass_rate treats
# "shipped" and "confirmed" as passes, everything else (no-fix, no-changes,
# commit-failed, push-failed, ...) as a fail. Best-effort — never fails the
# caller.
agentic_record_outcome() {
    local provider="$1" outcome="$2" task="${3:-}"
    [ -n "$provider" ] && [ -n "$outcome" ] || return 0
    mkdir -p "$AGENTIC_LEDGER_DIR" 2>/dev/null || true
    printf '%s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$provider" "$outcome" "${task:-none}" \
        >> "$AGENTIC_QUALITY_FILE" 2>/dev/null || true
}

# agentic_quality_pass_rate PROVIDER — rolling pass-rate ("0.00"-"1.00") over
# the last AGENTIC_QUALITY_WINDOW recorded outcomes for that provider. Empty
# string (not "0.00") when the provider has no recorded outcomes yet, so
# callers can distinguish "never ran" from "ran and always failed".
agentic_quality_pass_rate() {
    local provider="$1"
    [ -n "$provider" ] && [ -f "$AGENTIC_QUALITY_FILE" ] || return 0
    awk -v provider="$provider" -v window="$AGENTIC_QUALITY_WINDOW" '
        $2 == provider { n++; lines[n] = $3 }
        END {
            if (n == 0) exit 0
            start = (n > window) ? n - window + 1 : 1
            total = 0; pass = 0
            for (i = start; i <= n; i++) {
                total++
                if (lines[i] == "shipped" || lines[i] == "confirmed") pass++
            }
            if (total > 0) printf "%.2f", pass / total
        }
    ' "$AGENTIC_QUALITY_FILE"
}

# agentic_quality_rollup — one human-readable "pass-rate=X (n=Y, window=Z)"
# line per provider with recorded outcomes, sorted by provider name. Used by
# the runner log / operator reports; purely informational, never blocks a run.
agentic_quality_rollup() {
    if [ ! -f "$AGENTIC_QUALITY_FILE" ] || [ ! -s "$AGENTIC_QUALITY_FILE" ]; then
        echo "[agentic] no outcome data recorded yet"
        return 0
    fi
    local provider rate total
    awk '{print $2}' "$AGENTIC_QUALITY_FILE" | sort -u | while IFS= read -r provider; do
        [ -n "$provider" ] || continue
        rate="$(agentic_quality_pass_rate "$provider")"
        total="$(awk -v p="$provider" '$2==p{c++} END{print c+0}' "$AGENTIC_QUALITY_FILE")"
        printf '[agentic] %-10s pass-rate=%s (n=%s, window=%s)\n' "$provider" "${rate:-n/a}" "$total" "$AGENTIC_QUALITY_WINDOW"
    done
}

# agentic_quality_json — the same per-provider rolling pass-rate as
# agentic_quality_rollup, machine-readable: a JSON array of
# {provider, passRate, n, window, recent} objects (recent = oldest→newest 1/0
# pass/fail bits for the outcomes counted in that rate, for a dashboard
# sparkline). "[]" when no outcomes are recorded yet. Consumed by
# pool_capacity_snapshot.sh to bridge this into state/pool-capacity.json's
# agentic-fallback pool entry (task-80ba3a74) — 28a7231 added the pass-rate
# tracking itself but the only consumer before this was the log-text rollup
# above, so an operator had to grep logs/claude_log.md for the number instead
# of seeing it next to the $ spend already on the dashboard.
agentic_quality_json() {
    if [ ! -f "$AGENTIC_QUALITY_FILE" ] || [ ! -s "$AGENTIC_QUALITY_FILE" ]; then
        printf '[]'
        return 0
    fi
    awk -v window="$AGENTIC_QUALITY_WINDOW" '
        {
            provider = $2
            n[provider]++
            lines[provider, n[provider]] = $3
            if (!seen[provider]++) order[++pc] = provider
        }
        END {
            printf "["
            for (i = 1; i <= pc; i++) {
                p = order[i]
                total = n[p]
                start = (total > window) ? total - window + 1 : 1
                cnt = 0; pass = 0; recent = ""
                for (j = start; j <= total; j++) {
                    bit = (lines[p, j] == "shipped" || lines[p, j] == "confirmed") ? 1 : 0
                    cnt++; pass += bit
                    recent = recent (recent == "" ? "" : ",") bit
                }
                rate = (cnt > 0) ? sprintf("%.2f", pass / cnt) : "null"
                esc = p
                gsub(/\\/, "\\\\", esc); gsub(/"/, "\\\"", esc)
                if (i > 1) printf ","
                printf "{\"provider\":\"%s\",\"passRate\":%s,\"n\":%d,\"window\":%d,\"recent\":[%s]}", esc, rate, cnt, window, recent
            }
            printf "]"
        }
    ' "$AGENTIC_QUALITY_FILE"
}

# ── session-close observability (task-eac0704e) ─────────────────────────────
# Before this, the lane's day-ledger + cap lived ONLY at
# ~/.ai-cli-runner/agentic/ (agentic_ledger_file) — machine-local, never git,
# same hygiene as the Claude pacing ledger. That's correct for the ledger
# ITSELF (real API dollars, must never round-trip through a synced repo), but
# it meant the only way to see today's DeepSeek/Kimi spend was to read the raw
# ledger file on the machine that ran it — no dashboard row, no log line
# anywhere a session-close summary or the /schedule capacity panel could pick
# up. pool_capacity_snapshot.sh (task-f5897132) already bridges the $/day
# ledger into state/pool-capacity.json for the dashboard; this is the log-line
# counterpart for `logs/claude_log.md` / operator session summaries — same
# ledger-read (agentic_spent_today_usd) + rollup (agentic_quality_rollup) this
# file already exposes, just formatted as one appendable block instead of
# requiring a caller to know both functions exist.

# agentic_session_close_line — one $/day-ledger summary line + the per-provider
# quality rollup underneath, meant to be appended to logs/claude_log.md (or
# echoed into a session-close summary) alongside whatever else that close
# already reports on spend. Silent about outcomes when the lane never ran
# today (spend stays "0" — agentic_spent_today_usd's normal empty-ledger
# behavior) so a session that never touched the lane doesn't manufacture a
# misleading zero-spend line; callers wanting an unconditional line can call
# agentic_spent_today_usd/agentic_quality_rollup directly.
agentic_session_close_line() {
    local spent cap pct
    spent="$(agentic_spent_today_usd)"
    cap="$AGENTIC_FALLBACK_DAILY_USD_CAP"
    pct="$(awk -v s="$spent" -v c="$cap" 'BEGIN { if (c+0 > 0) printf "%.1f", s*100/c; else print "0" }')"
    printf '[agentic] day-ledger %s: $%s of $%s cap spent (%s%%)\n' "$(TZ=Australia/Sydney date +%Y-%m-%d)" "$spent" "$cap" "$pct"
    agentic_quality_rollup
}

# agentic_lane_common_ready — the readiness checks shared by BOTH triggers
# (crisis fallback + queue-depth overflow): a valid lane model configured, its
# key resolvable, and today's spend under the shared $/day cap. Master-switch
# and eligibility gating (AGENTIC_FALLBACK for the crisis trigger;
# AGENTIC_OVERFLOW + priority/depth for the overflow trigger) stay in the
# caller so the two triggers remain independently toggleable. Prints the
# human reason it is NOT ready on rc 1 (for the runner log), same convention
# as every other gate in this file.
agentic_lane_common_ready() {
    local m
    m="$(agentic_first_model)"
    if [ -z "$m" ] || ! agentic_model_match "$m"; then echo "no valid lane model configured ('$m')"; return 1; fi
    if ! agentic_api_key "$m" >/dev/null 2>&1; then echo "no API key for $m ($(agentic_key_env "$m") unset)"; return 1; fi
    if ! agentic_budget_ok; then echo "daily USD cap reached (\$$(agentic_spent_today_usd) of \$$AGENTIC_FALLBACK_DAILY_USD_CAP)"; return 1; fi
    return 0
}

# agentic_fallback_ready — rc 0 when the CRISIS trigger may engage: opt-in
# switch ON plus the shared common-readiness checks above. Prints the human
# reason it is NOT ready on rc 1 (for the runner log).
agentic_fallback_ready() {
    if [ "$AGENTIC_FALLBACK" != "on" ]; then echo "lane disabled (AGENTIC_FALLBACK=off)"; return 1; fi
    agentic_lane_common_ready
}

# agentic_overflow_priority_match <priority> — rc 0 when the task's priority
# falls inside the configured overflow band (AGENTIC_OVERFLOW_PRIORITIES,
# default "P2 P3" — this trigger exists to drain LOW-priority backlog
# proactively; P0/P1 always stay on Claude regardless of queue depth).
agentic_overflow_priority_match() {
    local p="${1:-}" want
    [ -n "$p" ] || return 1
    for want in $AGENTIC_OVERFLOW_PRIORITIES; do
        [ "$p" = "$want" ] && return 0
    done
    return 1
}

# agentic_overflow_ready <queue_depth> <priority> — rc 0 when the OVERFLOW
# trigger may engage for THIS task right now: master switch ON, the task's
# priority is in the overflow band, the measured pending-backlog depth at
# that priority band is at/above AGENTIC_OVERFLOW_MIN_QUEUE_DEPTH, and the
# lane itself has room (agentic_lane_common_ready — same key + $/day cap gate
# as the crisis trigger). QUEUE_DEPTH is supplied by the caller (the runner
# measures it via tasks_list — a gateway/network concern this stdlib-only lib
# deliberately stays out of). Prints the human reason it is NOT ready on
# rc 1, same convention as agentic_fallback_ready.
agentic_overflow_ready() {
    local depth="${1:-0}" priority="${2:-}"
    if [ "$AGENTIC_OVERFLOW" != "on" ]; then echo "overflow lane disabled (AGENTIC_OVERFLOW=off)"; return 1; fi
    if ! agentic_overflow_priority_match "$priority"; then
        echo "priority '$priority' outside overflow band ($AGENTIC_OVERFLOW_PRIORITIES)"; return 1
    fi
    case "$depth" in ''|*[!0-9]*) depth=0 ;; esac
    if [ "$depth" -lt "$AGENTIC_OVERFLOW_MIN_QUEUE_DEPTH" ] 2>/dev/null; then
        echo "queue depth ($depth) below floor ($AGENTIC_OVERFLOW_MIN_QUEUE_DEPTH)"; return 1
    fi
    agentic_lane_common_ready
}

# agentic_exhaustion_ready — rc 0 when the ALL-POOLS-CAPPED cross-provider
# demotion trigger (above) may engage: opt-in switch ON plus the shared
# common-readiness checks (agentic_lane_common_ready — same key + $/day cap
# gate as the other two triggers). Prints the human reason it is NOT ready on
# rc 1, same convention as agentic_fallback_ready / agentic_overflow_ready.
agentic_exhaustion_ready() {
    if [ "$AGENTIC_EXHAUSTION_DEMOTION" != "on" ]; then echo "demotion lane disabled (AGENTIC_EXHAUSTION_DEMOTION=off)"; return 1; fi
    agentic_lane_common_ready
}

# _agentic_run_inner WORKDIR MODEL [TASK-ID] — the actual attempt (prompt on
# stdin). Ensures the 'test' branch, runs the bounded agent, records the
# spend + a per-model quality-ledger outcome, and commits+pushes only when it
# genuinely changed something.
_agentic_run_inner() {
    local workdir="$1" model="$2" task_id="${3:-}" py key_env key agent_rc agent_out spend push_ok=false provider
    py="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/openai_agent.py"
    key_env="$(agentic_key_env "$model")" || { echo "[agentic] unknown model vendor: $model"; return 1; }
    key="$(agentic_api_key "$model")" || { echo "[agentic] no API key for $model"; return 1; }
    provider="$(agentic_provider_name "$model")"

    local pricing_warn
    pricing_warn="$(agentic_pricing_stale_warning)"
    [ -n "$pricing_warn" ] && echo "[agentic] $pricing_warn"

    git -C "$workdir" fetch origin --quiet >/dev/null 2>&1 || true
    if git -C "$workdir" rev-parse -q --verify origin/test >/dev/null 2>&1; then
        git -C "$workdir" checkout -B test origin/test --quiet 2>/dev/null || git -C "$workdir" checkout -B test --quiet
    else
        git -C "$workdir" checkout -B test --quiet
    fi

    agent_out="$(mktemp -t agentic-agent.XXXXXX 2>/dev/null || echo /tmp/agentic-agent.$$)"
    env "$key_env=$key" AGENTIC_MAX_ITERS="$AGENTIC_MAX_ITERS" AGENTIC_CMD_TIMEOUT_SEC="$AGENTIC_CMD_TIMEOUT_SEC" \
        /usr/bin/python3 "$py" --workdir "$workdir" --model "$model" \
            --base-url "$(agentic_base_url "$model")" --api-key-env "$key_env" \
            --max-iters "$AGENTIC_MAX_ITERS" --cmd-timeout "$AGENTIC_CMD_TIMEOUT_SEC" \
        | tee "$agent_out"
    agent_rc=${PIPESTATUS[0]:-1}

    # Record the run's real-dollar spend REGARDLESS of outcome — a failed run
    # still billed tokens, and under-counting would defeat the cap.
    spend="$(grep -E '^\[openai-agent\] usage ' "$agent_out" | tail -1 \
        | sed 's/^\[openai-agent\] usage //' \
        | /usr/bin/python3 -c 'import sys,json;print(json.loads(sys.stdin.read() or "{}").get("cost_usd",0))' 2>/dev/null)"
    agentic_add_spend_usd "$spend"
    echo "[agentic] spend this run: \$${spend:-0} (today: \$$(agentic_spent_today_usd) of \$$AGENTIC_FALLBACK_DAILY_USD_CAP)"
    rm -f "$agent_out" 2>/dev/null || true

    if [ "$agent_rc" -ne 0 ]; then
        echo "[agentic] agent did not land a fix — falling back"
        agentic_record_outcome "$provider" "no-fix" "$task_id"
        return 1
    fi
    if [ -z "$(git -C "$workdir" status --porcelain 2>/dev/null)" ]; then
        echo "[agentic] agent reported done but left no changes — falling back"
        agentic_record_outcome "$provider" "no-changes" "$task_id"
        return 1
    fi

    git -C "$workdir" add -A
    if ! git -C "$workdir" -c user.email="runner@myai.local" -c user.name="myai-runner" \
        commit --quiet -m "fix: agentic-fallback automated task ($model)"; then
        echo "[agentic] commit failed — falling back"
        agentic_record_outcome "$provider" "commit-failed" "$task_id"
        return 1
    fi

    if git -C "$workdir" push origin test --quiet 2>/dev/null; then
        push_ok=true
    else
        git -C "$workdir" fetch origin --quiet >/dev/null 2>&1 || true
        if git -C "$workdir" rebase origin/test --quiet 2>/dev/null \
            && git -C "$workdir" push origin test --quiet 2>/dev/null; then
            push_ok=true
        fi
    fi
    if [ "$push_ok" != true ]; then
        echo "[agentic] push to origin/test failed after rebase retry — falling back"
        agentic_record_outcome "$provider" "push-failed" "$task_id"
        return 1
    fi
    echo "[agentic] pushed agentic-fallback fix to origin/test ($model)"
    agentic_record_outcome "$provider" "shipped" "$task_id"
    return 0
}

# agentic_fallback_run WORKDIR MODEL [TASK-ID] — public entry point (prompt on
# stdin). rc 0 only on a genuine push, so the caller's fallback/release logic
# stays exact. Re-checks the budget at run time (the ready-check may be
# minutes old). TASK-ID (optional) is stamped onto the quality-ledger record
# so a rollup can be traced back to the task that produced it.
#
# Shared execution path for ALL THREE triggers (crisis fallback + queue-depth
# overflow, task-3e57fd93 + all-pools-capped demotion, task-4b37f17d) — the
# master-switch check below accepts ANY of AGENTIC_FALLBACK=on /
# AGENTIC_OVERFLOW=on / AGENTIC_EXHAUSTION_DEMOTION=on so an operator can run
# any subset of the three triggers independently. Direct model-id routing (a
# task/operator pins deepseek-*/kimi-* directly, see agentic_model_match call
# sites in cli_task_runner.sh) also lands here and is still refused when ALL
# THREE switches are off — an explicit pin never bypasses the fleet-wide
# opt-in posture.
agentic_fallback_run() {
    local workdir="$1" model="$2" task_id="${3:-}"
    if [ "$AGENTIC_FALLBACK" != "on" ] && [ "${AGENTIC_OVERFLOW:-off}" != "on" ] && [ "${AGENTIC_EXHAUSTION_DEMOTION:-off}" != "on" ]; then
        echo "[agentic] lane disabled (AGENTIC_FALLBACK=off, AGENTIC_OVERFLOW=off, AGENTIC_EXHAUSTION_DEMOTION=off) — skipping"
        return 1
    fi
    if ! agentic_budget_ok; then
        echo "[agentic] daily USD cap reached (\$$(agentic_spent_today_usd) of \$$AGENTIC_FALLBACK_DAILY_USD_CAP) — skipping"
        return 1
    fi
    _agentic_run_inner "$workdir" "$model" "$task_id"
}
