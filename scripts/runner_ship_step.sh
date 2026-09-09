#!/usr/bin/env bash
# runner_ship_step.sh — give the CLI runner a ship step of its own.
#
# THE PROBLEM (task-d4350b8f): measured over 4 consecutive hourly steward ticks,
# ai_management's test-ahead-of-main drift went 11 -> 11 -> 11 -> 14 while its
# `review` pile climbed 53 -> 53 -> 56 -> 57 and `pending` sat at 0 nearly every
# tick. The runner isn't short of work — it finishes tasks onto `test`, nothing
# merges, reconcile_review_tasks.sh can flip none of them (every task is stamped
# against commits that exist only on `test`), so completed work accumulates and
# the runner starves between top-ups. A human (or a steward loop) opening a
# test->main PR by hand each time is treating the symptom, not the cause.
#
# THE FIX: after the runner flips a task to `review`, it calls this script for
# the repo it just worked. When drift (origin/main..origin/test commit count)
# exceeds a threshold, OR that repo has too many tasks sitting in `review`, this
# script opens the test->main PR itself (respecting pr_guard.sh — a docs/AI-only
# diff still batches, no PR), waits for CI checks, merges when green, and then
# runs reconcile_review_tasks.sh so the review pile flips automatically. This is
# the missing half of the loop: the runner already finishes work — this makes it
# also land that work, instead of relying on a human to notice the backlog.
#
# HARD RULES (non-negotiable, mirrors AI_RULES / CLAUDE.md "ship it"):
#   - NEVER merge over a genuinely failing check. Bypass is billing/outage only,
#     and this script does NOT attempt that bypass automatically — a stuck/
#     billing-blocked PR is logged and left for a human `ship it` session
#     (which already knows the local-ci.sh + --admin fallback procedure).
#   - NEVER widen a coverage exclude or lower a threshold to go green — this
#     script has no such capability; it only waits and reads check results.
#   - Respects pr_guard.sh: a docs/AI/hook/config-only diff vs main REFUSES a
#     PR (§17.1) — this script honors that refusal and leaves the commits
#     batched on `test` rather than overriding the guard.
#   - Never pushes to main directly, never force-pushes, never touches history —
#     the only git-history-affecting action is `gh pr merge --merge` on a PR
#     whose checks are confirmed green.
#
# USAGE:
#   ./scripts/runner_ship_step.sh --path <host-repo-dir> [--repo <name>]
#   ./scripts/runner_ship_step.sh --path . --dry-run
#   ./scripts/runner_ship_step.sh --path . --no-fetch
#   ./scripts/runner_ship_step.sh --path . --throttle-min 30 --marker /tmp/ship.stamp
#
# TUNABLES (env):
#   SHIP_DRIFT_THRESHOLD   commits ahead of main that trigger a ship (default 5)
#   SHIP_REVIEW_THRESHOLD  tasks sitting in `review` for the repo that trigger a
#                          ship even below the drift threshold (default 8)
#   SHIP_WAIT_TIMEOUT_MIN  max minutes to wait for checks before giving up
#                          without merging (default 20)
#   SHIP_POLL_SEC          seconds between check polls (default 30)
#   GATEWAY_MCP            gateway MCP endpoint (default http://localhost:3100/mcp)
#
# Exit codes: 0 = ran to completion (shipped, or correctly decided not to —
#   both are success). Never exits non-zero for "nothing to do"; callers should
#   treat this script as best-effort/non-fatal, same as reconcile_review_tasks.sh.
set -uo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
GATEWAY_MCP="${GATEWAY_MCP:-http://localhost:3100/mcp}"
. "$SELF_DIR/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

SHIP_DRIFT_THRESHOLD="${SHIP_DRIFT_THRESHOLD:-5}"
SHIP_REVIEW_THRESHOLD="${SHIP_REVIEW_THRESHOLD:-8}"
SHIP_WAIT_TIMEOUT_MIN="${SHIP_WAIT_TIMEOUT_MIN:-20}"
SHIP_POLL_SEC="${SHIP_POLL_SEC:-30}"

log() { echo "[ship-step $(date -u +%H:%M:%S)Z] $*"; }

# ── pure helpers (unit-testable via SHIP_STEP_LIB_ONLY=1) ──────────────────

# ship_drift_count <host-path> → commits ahead of origin/main on origin/test.
# 0 (not an error) when either ref is missing — caller treats that as "nothing
# to ship" rather than a hard failure.
ship_drift_count() {
    local p="$1"
    git -C "$p" rev-parse --verify -q origin/main >/dev/null 2>&1 || { echo 0; return; }
    git -C "$p" rev-parse --verify -q origin/test >/dev/null 2>&1 || { echo 0; return; }
    git -C "$p" rev-list --count origin/main..origin/test 2>/dev/null || echo 0
}

# ship_decision <drift> <drift_threshold> <review_count> <review_threshold>
# → prints the reason and returns 0 when a ship attempt is warranted; returns
# 1 (empty stdout) when neither condition is met.
ship_decision() {
    local drift="${1:-0}" dt="${2:-5}" reviewn="${3:-0}" rt="${4:-8}"
    case "$drift"   in ''|*[!0-9]*) drift=0 ;;   esac
    case "$reviewn" in ''|*[!0-9]*) reviewn=0 ;; esac
    if [ "$drift" -ge "$dt" ] 2>/dev/null; then
        printf 'drift %s commit(s) ahead of main >= threshold %s' "$drift" "$dt"
        return 0
    fi
    if [ "$reviewn" -ge "$rt" ] 2>/dev/null; then
        printf '%s task(s) sitting in review >= threshold %s' "$reviewn" "$rt"
        return 0
    fi
    return 1
}

# ship_checks_verdict <statusCheckRollup-JSON-array> → "pass" | "fail" | "pending"
# Pure classifier over `gh pr view --json statusCheckRollup`'s array: any
# non-passing conclusion (FAILURE/ERROR/CANCELLED/TIMED_OUT) → fail immediately
# (fail-fast, never wait out a check that has already failed); anything still
# QUEUED/IN_PROGRESS/PENDING (or no rollup at all yet) → pending; everything
# concluded SUCCESS/NEUTRAL/SKIPPED → pass. Empty rollup after a real PR was
# opened is treated as pending (checks haven't started reporting yet), not pass.
ship_checks_verdict() {
    printf '%s' "${1:-[]}" | /usr/bin/python3 -c '
import json, sys
try:
    rollup = json.load(sys.stdin)
except Exception:
    rollup = []
if not isinstance(rollup, list):
    rollup = []
if not rollup:
    print("pending"); sys.exit(0)
FAIL = {"FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"}
PEND = {"QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "STALE", ""}
states = []
for c in rollup:
    concl = (c.get("conclusion") or "").upper()
    status = (c.get("status") or "").upper()
    states.append(concl if concl else status)
if any(s in FAIL for s in states):
    print("fail"); sys.exit(0)
if any(s in PEND or s not in ("SUCCESS", "NEUTRAL", "SKIPPED") for s in states):
    print("pending"); sys.exit(0)
print("pass")
'
}

# ── unit-test hook (scripts/tests/test_runner_ship_step.sh) ────────────────
if [ "${SHIP_STEP_LIB_ONLY:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

# ── args ─────────────────────────────────────────────────────────────────
HOST_PATH="" REPO_NAME="" DRY_RUN=false NO_FETCH=false THROTTLE_MIN=0 MARKER=""
while [ $# -gt 0 ]; do
    case "$1" in
        --path)          shift; HOST_PATH="${1:?--path needs a value}" ;;
        --repo)          shift; REPO_NAME="${1:?--repo needs a value}" ;;
        --dry-run)       DRY_RUN=true ;;
        --no-fetch)      NO_FETCH=true ;;
        --throttle-min)  shift; THROTTLE_MIN="${1:?--throttle-min needs a value}" ;;
        --marker)        shift; MARKER="${1:?--marker needs a value}" ;;
        --drift-threshold)  shift; SHIP_DRIFT_THRESHOLD="${1:?}" ;;
        --review-threshold) shift; SHIP_REVIEW_THRESHOLD="${1:?}" ;;
        -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
    esac
    shift
done
[ -n "$HOST_PATH" ] || { echo "ERROR: --path is required" >&2; exit 1; }
git -C "$HOST_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { log "no git repo at $HOST_PATH — nothing to ship."; exit 0; }
[ -n "$REPO_NAME" ] || REPO_NAME="$(basename "$HOST_PATH")"

# ── throttle (mirrors reconcile_review_tasks.sh — the runner calls this once
#    per review-flip, but PR checks take minutes, so avoid re-firing every fire) ──
if [ "$THROTTLE_MIN" -gt 0 ] && [ -n "$MARKER" ] && [ -f "$MARKER" ]; then
    age=$(( $(date +%s) - $(stat -c %Y "$MARKER" 2>/dev/null || stat -f %m "$MARKER" 2>/dev/null || echo 0) ))
    if [ "$age" -lt $(( THROTTLE_MIN * 60 )) ]; then
        log "throttled — last ship-step for $REPO_NAME $((age/60))m ago (< ${THROTTLE_MIN}m); skipping."
        exit 0
    fi
fi

$NO_FETCH || git -C "$HOST_PATH" fetch origin --quiet 2>/dev/null || true

DRIFT="$(ship_drift_count "$HOST_PATH")"

mcp() { # mcp <tool> <json-args>
    local body raw
    body="{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
    raw="$(curl -sf -m 15 -X POST "$GATEWAY_MCP" -H 'content-type: application/json' \
        -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" -d "$body" 2>/dev/null || true)"
    [ -n "$raw" ] || return 1
    printf '%s' "$raw" | /usr/bin/python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["content"][0]["text"])' 2>/dev/null
}

REVIEW_JSON="$(mcp tasks_list "{\"status\":\"review\",\"repo\":\"$REPO_NAME\",\"limit\":500}" || echo '{}')"
REVIEW_COUNT="$(printf '%s' "$REVIEW_JSON" | /usr/bin/python3 -c '
import sys, json
try:
    print(len(json.loads(sys.stdin.read() or "{}").get("tasks", [])))
except Exception:
    print(0)' 2>/dev/null)"
[ -n "$REVIEW_COUNT" ] || REVIEW_COUNT=0

REASON="$(ship_decision "$DRIFT" "$SHIP_DRIFT_THRESHOLD" "$REVIEW_COUNT" "$SHIP_REVIEW_THRESHOLD")"
if [ -z "$REASON" ]; then
    log "[$REPO_NAME] no ship needed — drift $DRIFT/$SHIP_DRIFT_THRESHOLD, review $REVIEW_COUNT/$SHIP_REVIEW_THRESHOLD."
    exit 0
fi
log "[$REPO_NAME] SHIP CONDITION MET: $REASON"

# ── pr_guard: never open a PR for a docs/AI/hook/config-only diff (§17.1) ──
PR_GUARD="$SELF_DIR/pr_guard.sh"
if [ -x "$PR_GUARD" ]; then
    GUARD_OUT="$(cd "$HOST_PATH" && "$PR_GUARD" origin/main origin/test 2>&1)"
    GUARD_RC=$?
    if [ "$GUARD_RC" -eq 2 ]; then
        log "[$REPO_NAME] pr_guard REFUSED (docs/AI/hook/config-only diff) — batching on test, not opening a PR."
        echo "$GUARD_OUT" | sed 's/^/  /'
        [ -n "$MARKER" ] && : >"$MARKER"
        exit 0
    fi
    log "[$REPO_NAME] pr_guard: $(echo "$GUARD_OUT" | tail -1)"
fi

if $DRY_RUN; then
    log "[$REPO_NAME] DRY-RUN — would open/verify test->main PR, wait for checks, merge when green, then reconcile."
    exit 0
fi

command -v gh >/dev/null 2>&1 || { log "[$REPO_NAME] gh CLI not available — cannot open/merge PRs. Skipping (a human 'ship it' session can still do this)."; exit 0; }

# ── find or open the test->main PR ──────────────────────────────────────
# --limit 1: GitHub allows only ONE open PR per head->base pair, and we read
# .[0] regardless — pin the request so it can never ride gh's silent 30-cap.
PR_NUM="$(cd "$HOST_PATH" && gh pr list --limit 1 --base main --head test --state open --json number --jq '.[0].number' 2>/dev/null)"
if [ -z "$PR_NUM" ] || [ "$PR_NUM" = "null" ]; then
    LOG_SUMMARY="$(git -C "$HOST_PATH" log --format='- %s' origin/main..origin/test 2>/dev/null | head -20)"
    # BODY built with printf (each dynamic value passed as its own %s argument,
    # never interpolated inside a quoted/heredoc format string) — a `cat <<EOF`
    # heredoc nested inside a `$(...)` command substitution mis-parses on this
    # fleet's bash 3.2 (macOS system bash) the instant the body text contains an
    # apostrophe, which real commit subjects in ${LOG_SUMMARY} routinely do.
    BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/ship-step-body.XXXXXX")"
    {
        printf 'Auto-opened by the runner ship step (task-d4350b8f) - test is %s commit(s) ahead of main and/or the review queue is backed up.\n\n' "$DRIFT"
        printf 'Reason: %s\n\n' "$REASON"
        printf '## Commits\n%s\n\n' "$LOG_SUMMARY"
        printf '## Test plan\n- [ ] CI checks pass on this PR\n- [ ] reconcile_review_tasks.sh flips the matching review tasks to done after merge\n\n'
        printf 'Opened autonomously by scripts/runner_ship_step.sh\n'
    } > "$BODY_FILE"
    PR_TS="$(TZ=Australia/Sydney date '+%Y-%m-%d %H:%M AEST')"
    PR_TITLE="chore: ship test -> main ($PR_TS)"
    PR_NUM="$(cd "$HOST_PATH" && gh pr create --base main --head test --title "$PR_TITLE" --body-file "$BODY_FILE" --json number --jq '.number' 2>/dev/null)"
    if [ -z "$PR_NUM" ] || [ "$PR_NUM" = "null" ]; then
        PR_NUM="$(cd "$HOST_PATH" && gh pr create --base main --head test --title "$PR_TITLE" --body-file "$BODY_FILE" 2>/dev/null | grep -oE '[0-9]+$')"
    fi
    rm -f "$BODY_FILE" 2>/dev/null || true
    if [ -z "$PR_NUM" ]; then
        log "[$REPO_NAME] gh pr create failed — leaving work on test for a human ship-it session."
        exit 0
    fi
    log "[$REPO_NAME] opened PR #$PR_NUM (test -> main)."
else
    log "[$REPO_NAME] found existing open PR #$PR_NUM (test -> main)."
fi

# ── wait for checks (never merge over a failing check; bypass is billing/
#    outage only, and this script does not attempt that bypass) ──────────
DEADLINE=$(( $(date +%s) + SHIP_WAIT_TIMEOUT_MIN * 60 ))
VERDICT="pending"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    ROLLUP="$(cd "$HOST_PATH" && gh pr view "$PR_NUM" --json statusCheckRollup --jq '.statusCheckRollup' 2>/dev/null)"
    VERDICT="$(ship_checks_verdict "${ROLLUP:-[]}")"
    case "$VERDICT" in
        pass) break ;;
        fail) break ;;
        *) sleep "$SHIP_POLL_SEC" ;;
    esac
done

case "$VERDICT" in
    pass)
        log "[$REPO_NAME] checks GREEN on PR #$PR_NUM — merging."
        if (cd "$HOST_PATH" && gh pr merge "$PR_NUM" --merge >/dev/null 2>&1); then
            log "[$REPO_NAME] merged PR #$PR_NUM. Running reconcile_review_tasks.sh to flip the review pile."
            "$SELF_DIR/reconcile_review_tasks.sh" --repo "$REPO_NAME" 2>&1 | sed 's/^/  [reconcile] /' || true
        else
            log "[$REPO_NAME] gh pr merge failed for #$PR_NUM — leaving PR open for a human to merge (never force, never bypass silently)."
        fi
        ;;
    fail)
        log "[$REPO_NAME] a REQUIRED check FAILED on PR #$PR_NUM — NOT merging. Leaving PR open for a human to fix or (billing/outage only, per CLAUDE.md) run local-ci.sh."
        ;;
    *)
        log "[$REPO_NAME] checks still pending after ${SHIP_WAIT_TIMEOUT_MIN}m on PR #$PR_NUM — NOT merging (possible billing/Actions-credit block). Leaving PR open; a human 'ship it' session can run local-ci.sh's fallback if this is the billing/outage condition."
        ;;
esac

[ -n "$MARKER" ] && : >"$MARKER"
exit 0
