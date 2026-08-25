#!/usr/bin/env bash
# runner_pool.sh — sourceable bounded WORKER POOL for cli_task_runner.sh
# (RUNNER intra-runner parallel task execution, task-85196c45).
#
# Today one launchd fire works ONE task; extra parallelism only ramps at one
# new task per 10-minute fire. This pool lets a SINGLE fire run up to
# POOL_WORKERS tasks concurrently: the pool spawns cli_task_runner.sh child
# processes (RUNNER_POOL_CHILD=1 so they never recurse), each of which keeps
# the ENTIRE existing correctness stack unchanged — atomic /tmp slot claim
# (MAX_CONCURRENT machine cap), fleet-wide runner_lease_* slots, credit-pacing
# ledgers, atomic gateway tasks_claim (no double-pick), per-task git-worktree
# isolation, and the per-task resource watchdog. The pool is pure THROUGHPUT
# scaffolding on top of those correctness/fairness layers — it never claims a
# task, slot, or lease itself.
#
# Scale-up is CONFIRMATION-GATED (backpressure by design): worker k+1 is only
# spawned after worker k has logged the runner's post-claim marker
# ("task marked WORKING — session starting"). A worker that exits or stalls
# before that marker means the queue is drained or a gate (off-hours, pacing,
# lease busy, backoff, cooldown) is holding — so the pool STOPS scaling
# instead of hammering a closed gate N times. Before each additional spawn it
# also re-checks host headroom (free machine slots, busy-backoff marker,
# free-RAM floor for one more MAX_TASK_RAM_MB-capped task, optional load cap).
# Worker 1 always spawns — the pool can never do worse than today's
# single-task fire.
#
# Config (env or config/runner_budget.conf — all optional):
#   POOL_WORKERS          max concurrent tasks per fire (default 1 = pool OFF;
#                         cli_task_runner.sh only engages the pool when >1;
#                         always clamped to MAX_CONCURRENT)
#   POOL_CLAIM_WAIT_SEC   max wait for a worker's claim confirmation before
#                         deciding not to scale further (default 90)
#   POOL_POLL_SEC         confirmation/completion poll interval (default 2)
#   POOL_MIN_FREE_RAM_MB  free-RAM headroom required before spawning an
#                         ADDITIONAL worker (default: MAX_TASK_RAM_MB, i.e.
#                         room for one more fully-capped task; 0 = off)
#   POOL_MAX_LOAD         integer 1-min load-average ceiling gating additional
#                         workers (default 0 = off)
#   POOL_RUNNER_CMD       test hook: child command to spawn instead of the
#                         real cli_task_runner.sh
#
# Each worker's stdout is captured to $LOG_ROOT/pool-<ts>-w<k>.log and replayed
# into the fire's own stdout when that worker finishes, so runner.out (the
# runner_health.sh parse source) stays complete and non-interleaved.
#
# bash 3.2-safe — no mapfile, no `wait -n`, no associative arrays.

POOL_WORKERS=${POOL_WORKERS:-1}
POOL_CLAIM_WAIT_SEC=${POOL_CLAIM_WAIT_SEC:-90}
POOL_POLL_SEC=${POOL_POLL_SEC:-2}
POOL_MIN_FREE_RAM_MB=${POOL_MIN_FREE_RAM_MB:-${MAX_TASK_RAM_MB:-1536}}
POOL_MAX_LOAD=${POOL_MAX_LOAD:-0}
POOL_RUNNER_CMD=${POOL_RUNNER_CMD:-}
# Post-claim "a session is actually running" marker — must match the log line
# cli_task_runner.sh emits right before the headless session starts.
POOL_CLAIM_MARKER=${POOL_CLAIM_MARKER:-"session starting"}

# Reuse the runner's log() when sourced into it; standalone (tests) fall back.
pool_log() {
    if declare -F log >/dev/null 2>&1; then log "pool: $*"; else echo "[runner-pool] $*"; fi
}

# pool_free_ram_mb — best-effort free/reclaimable RAM in MB; empty on failure
# (callers treat empty as "unknown → don't gate on it").
pool_free_ram_mb() {
    if [ -r /proc/meminfo ]; then
        awk '/^MemAvailable:/ { printf "%d", $2 / 1024; exit }' /proc/meminfo 2>/dev/null
    else
        # macOS: (free + inactive + purgeable) pages × page size
        vm_stat 2>/dev/null | awk '
            /page size of/     { ps = $8 }
            /^Pages free/      { f = $NF }
            /^Pages inactive/  { i = $NF }
            /^Pages purgeable/ { p = $NF }
            END {
                if (f == "" && i == "" && p == "") exit
                gsub(/\./, "", f); gsub(/\./, "", i); gsub(/\./, "", p)
                if (ps == "" || ps == 0) ps = 16384
                printf "%d", (f + i + p) * ps / 1048576
            }'
    fi
}

# pool_load_int — 1-minute load average truncated to an integer; empty on failure.
pool_load_int() {
    uptime 2>/dev/null | awk -F'load average[s]*: *' 'NF > 1 { split($2, a, /[, ]/); printf "%d", a[1] }'
}

# pool_active_slots — /tmp slot dirs currently held on this machine (each real
# runner child claims one atomically; other concurrent fires count too).
pool_active_slots() {
    find "${SLOT_ROOT:-/tmp/cli-task-runner.slots}" -maxdepth 1 -type d -name 'slot-*' 2>/dev/null | wc -l | tr -d ' '
}

# pool_backpressure_reason — gate for ADDITIONAL workers (worker 2+). Echoes a
# human reason and returns 0 when the pool must STOP scaling; returns 1 when
# there is headroom for one more worker.
pool_backpressure_reason() {
    local bk now active free_mb load
    # A fresh busy-backoff marker means a sibling/prior fire already found the
    # machine slots or fleet lease at capacity — don't pile on.
    if [ -f "${BACKOFF_FILE:-/tmp/cli-task-runner.backoff}" ]; then
        bk=$(cat "${BACKOFF_FILE:-/tmp/cli-task-runner.backoff}" 2>/dev/null || echo 0)
        now=$(date +%s)
        if [ "$now" -lt "$bk" ] 2>/dev/null; then
            echo "busy-backoff marker active ($(( (bk - now + 59) / 60 ))m left)"
            return 0
        fi
    fi
    # Machine slot budget (MAX_CONCURRENT) — counts EVERY concurrent fire's
    # claimed slots, not just this pool's children.
    active=$(pool_active_slots)
    if [ "${active:-0}" -ge "${MAX_CONCURRENT:-5}" ] 2>/dev/null; then
        echo "all ${MAX_CONCURRENT:-5} machine slots busy ($active active)"
        return 0
    fi
    # Free-RAM floor: room for one more fully-capped task under the 2GB policy.
    if [ "${POOL_MIN_FREE_RAM_MB:-0}" -gt 0 ] 2>/dev/null; then
        free_mb=$(pool_free_ram_mb)
        if [ -n "$free_mb" ] && [ "$free_mb" -lt "$POOL_MIN_FREE_RAM_MB" ] 2>/dev/null; then
            echo "free RAM ${free_mb}MB below the ${POOL_MIN_FREE_RAM_MB}MB headroom needed for another capped task"
            return 0
        fi
    fi
    # Optional whole-host load ceiling.
    if [ "${POOL_MAX_LOAD:-0}" -gt 0 ] 2>/dev/null; then
        load=$(pool_load_int)
        if [ -n "$load" ] && [ "$load" -ge "$POOL_MAX_LOAD" ] 2>/dev/null; then
            echo "1-min load $load >= POOL_MAX_LOAD=$POOL_MAX_LOAD"
            return 0
        fi
    fi
    return 1
}

# pool_wait_claim <worker-log> <worker-pid> — block until the worker either
# logs the post-claim marker, exits, or POOL_CLAIM_WAIT_SEC passes. Echoes one
# of: confirmed | exited | timeout.
pool_wait_claim() {
    local logf="$1" pid="$2" waited=0
    while [ "$waited" -lt "${POOL_CLAIM_WAIT_SEC:-90}" ]; do
        if grep -q "$POOL_CLAIM_MARKER" "$logf" 2>/dev/null; then
            echo confirmed; return 0
        fi
        if ! kill -0 "$pid" 2>/dev/null; then
            # Exited — one last look in case the marker landed right before death.
            if grep -q "$POOL_CLAIM_MARKER" "$logf" 2>/dev/null; then
                echo confirmed
            else
                echo exited
            fi
            return 0
        fi
        sleep "${POOL_POLL_SEC:-2}"
        waited=$(( waited + ${POOL_POLL_SEC:-2} ))
    done
    echo timeout
}

# pool_run [runner-args…] — the bounded pool main loop. Returns the WORST
# child exit code (0 only when every spawned worker exited 0).
pool_run() {
    local plan="${POOL_WORKERS:-1}" runner ts logdir spawned=0 worst=0
    local i=1 reason wlog wpid verdict rc k

    # Clamp: never plan more workers than the machine's slot budget allows.
    if [ "$plan" -gt "${MAX_CONCURRENT:-5}" ] 2>/dev/null; then
        plan="${MAX_CONCURRENT:-5}"
    fi
    if ! [ "$plan" -ge 1 ] 2>/dev/null; then plan=1; fi

    runner="${POOL_RUNNER_CMD:-$(cd "$(dirname "${BASH_SOURCE:-$0}")/.." && pwd)/cli_task_runner.sh}"
    ts=$(date -u +%Y%m%d-%H%M%S)
    logdir="${LOG_ROOT:-$HOME/.ai-cli-runner/logs}"
    mkdir -p "$logdir" 2>/dev/null || true

    pool_log "worker pool ENGAGED — up to $plan concurrent task(s) this fire (POOL_WORKERS=${POOL_WORKERS:-1}, machine cap MAX_CONCURRENT=${MAX_CONCURRENT:-5})"

    POOL_PIDS=()
    POOL_LOGS=()
    while [ "$i" -le "$plan" ]; do
        # Worker 1 always spawns (never worse than a single-task fire);
        # additional workers must pass the host-headroom backpressure gate.
        if [ "$i" -gt 1 ] && reason=$(pool_backpressure_reason); then
            pool_log "backpressure before worker $i — $reason; holding at $spawned worker(s)"
            break
        fi
        wlog="$logdir/pool-$ts-w$i.log"
        : > "$wlog" 2>/dev/null || wlog="/tmp/runner-pool-$ts-w$i.log"
        RUNNER_POOL_CHILD=1 "$runner" "$@" >"$wlog" 2>&1 &
        wpid=$!
        POOL_PIDS+=("$wpid")
        POOL_LOGS+=("$wlog")
        spawned=$(( spawned + 1 ))
        pool_log "worker $i spawned (pid $wpid → $(basename "$wlog"))"
        if [ "$i" -lt "$plan" ]; then
            verdict=$(pool_wait_claim "$wlog" "$wpid")
            case "$verdict" in
                confirmed)
                    pool_log "worker $i confirmed a claimed task — scaling to worker $(( i + 1 ))" ;;
                exited)
                    pool_log "worker $i exited without starting a session (queue drained or a gate held) — no further workers this fire"
                    break ;;
                *)
                    pool_log "worker $i gave no claim confirmation within ${POOL_CLAIM_WAIT_SEC:-90}s — conservative: no further workers this fire"
                    break ;;
            esac
        fi
        i=$(( i + 1 ))
    done

    # Collect every worker; replay each captured log into this fire's stdout
    # sequentially so runner.out stays complete and non-interleaved.
    k=0
    while [ "$k" -lt "${#POOL_PIDS[@]}" ]; do
        rc=0
        wait "${POOL_PIDS[$k]}" || rc=$?
        if [ "$rc" -gt "$worst" ]; then worst=$rc; fi
        pool_log "worker $(( k + 1 )) finished (exit $rc) — session output follows"
        cat "${POOL_LOGS[$k]}" 2>/dev/null || true
        k=$(( k + 1 ))
    done
    pool_log "pool complete — $spawned worker(s) ran (planned $plan), worst exit $worst"
    return "$worst"
}
