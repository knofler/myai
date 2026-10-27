#!/usr/bin/env bash
# =============================================================================
# runner_pr_gate.sh — protect in-flight CI runs on open test->main PRs.
#
# Directives & Context:
#   When an open PR from test -> main has CI checks running (e.g. 21-minute
#   Playwright smoke suites, coverage gates, etc.), pushing to `origin test`
#   cancels the active workflow runs and restarts them from scratch.
#   Under autonomous runner activity, a flurry of chore commits pushed to `test`
#   can repeatedly abort CI and indefinitely block PR merges.
#
# Policy (operator / swarm-master mandate 2026-10-04):
#   - NO push to test while a test->main PR has checks pending or in_progress.
#   - Defer and retry later.
#   - NEVER block a human operator's manual push — only gate runner and agent lanes.
#
# Usage:
#   source scripts/lib/runner_pr_gate.sh
#   runner_test_pr_has_inflight_checks [repo_dir]
#   runner_should_defer_push [repo_dir]
#
# CLI:
#   scripts/lib/runner_pr_gate.sh --check [repo_dir]
#   scripts/lib/runner_pr_gate.sh --guard-push [repo_dir]
# =============================================================================

RUNNER_PR_GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# runner_is_agent_lane — returns 0 if running in an automated runner / agent context,
# returns 1 if running as an interactive human operator.
runner_is_agent_lane() {
    # 1. Explicit runner / agent environment variables
    [ "${RUNNER_ACTIVE:-0}" = "1" ] && return 0
    [ "${RUNNER_POOL_CHILD:-0}" = "1" ] && return 0
    [ "${CI_TASK_RUNNER:-0}" = "1" ] && return 0
    [ "${IS_AGENT_LANE:-0}" = "1" ] && return 0
    [ "${NON_INTERACTIVE_AGENT:-0}" = "1" ] && return 0
    [ "${MYAI_RUNNER_FIRE:-0}" = "1" ] && return 0

    # 2. A session on the runner's or the swarm master's configured profile
    #    (role resolver — swarm_roles.sh; never a spelled profile name)
    if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
        case "$CLAUDE_CONFIG_DIR" in *claude-runner*) return 0 ;; esac
        # shellcheck source=scripts/lib/swarm_roles.sh
        if command -v role_runner_profile >/dev/null 2>&1 \
           || . "$RUNNER_PR_GATE_DIR/swarm_roles.sh" 2>/dev/null; then
            local cfg="${CLAUDE_CONFIG_DIR%/}" rp mp
            rp="$(role_runner_profile)"; mp="$(role_master_profile)"
            if [ "$cfg" = "${rp%/}" ] || [ "$cfg" = "${mp%/}" ]; then return 0; fi
        fi
    fi

    # 3. Path inspection: if running inside a runner worktree (.worktrees/)
    local cwd
    cwd="$(pwd -P 2>/dev/null || pwd)"
    case "$cwd" in
        */.worktrees/*|*/ci-workspaces/*) return 0 ;;
    esac

    # Otherwise assume human operator
    return 1
}

# runner_test_pr_has_inflight_checks [repo_dir]
# Returns 0 if an open PR from test to main has checks pending or in_progress.
# Prints diagnosis to stdout if in-flight checks exist.
# Returns 1 if clean (no open PR, all checks completed, or gh unavailable).
runner_test_pr_has_inflight_checks() {
    local dir="${1:-.}"
    if [ ! -d "$dir" ]; then
        return 1
    fi

    command -v gh >/dev/null 2>&1 || return 1
    command -v python3 >/dev/null 2>&1 || return 1

    local pr_json
    pr_json="$(git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 && \
        (cd "$dir" && gh pr list --head test --base main --state open --limit 10 --json number,title,statusCheckRollup 2>/dev/null) || echo "[]")"

    [ -z "$pr_json" ] && pr_json="[]"

    local result
    result="$(python3 -c '
import sys, json

try:
    prs = json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)

if not prs or not isinstance(prs, list):
    sys.exit(1)

for pr in prs:
    num = pr.get("number")
    title = pr.get("title", "")
    rollup = pr.get("statusCheckRollup") or []
    in_flight = []
    for c in rollup:
        tname = c.get("__typename")
        if tname == "CheckRun":
            status = str(c.get("status", "")).upper()
            conclusion = str(c.get("conclusion", "")).upper()
            if status != "COMPLETED" or status in ("IN_PROGRESS", "QUEUED", "PENDING", "WAITING"):
                in_flight.append(c.get("name", "unnamed check"))
        elif tname == "StatusContext":
            state = str(c.get("state", "")).upper()
            if state in ("PENDING", "EXPECTED"):
                in_flight.append(c.get("context", "unnamed context"))

    if in_flight:
        names = ", ".join(in_flight[:3])
        print(f"PR #{num} ({title}): {len(in_flight)} check(s) in-flight: {names}")
        sys.exit(0)

sys.exit(1)
' <<< "$pr_json" 2>/dev/null)"

    local rc=$?
    if [ $rc -eq 0 ] && [ -n "$result" ]; then
        printf '%s\n' "$result"
        return 0
    fi
    return 1
}

# runner_should_defer_push [repo_dir]
# Decides whether a push targeting `test` should be deferred.
# Rule: Never defer for human operators; defer for runner/agent lanes if checks in-flight.
runner_should_defer_push() {
    local dir="${1:-.}"

    # Always allow human operator manual pushes
    if ! runner_is_agent_lane; then
        return 1
    fi

    local inflight_info
    if inflight_info="$(runner_test_pr_has_inflight_checks "$dir")"; then
        echo "[runner-pr-gate] in-flight checks active on test->main PR: $inflight_info"
        return 0
    fi

    return 1
}

# CLI execution handler
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    set -euo pipefail
    action="${1:---check}"
    target_dir="${2:-.}"

    case "$action" in
        --check)
            if info="$(runner_test_pr_has_inflight_checks "$target_dir")"; then
                echo "IN_FLIGHT: $info"
                exit 0
            else
                echo "CLEAN: no in-flight checks on test->main PR"
                exit 1
            fi
            ;;
        --guard-push)
            if runner_should_defer_push "$target_dir"; then
                echo "DEFER: push to test blocked for automated lane to protect active PR CI" >&2
                exit 2
            else
                echo "ALLOWED: push permitted"
                exit 0
            fi
            ;;
        *)
            echo "Usage: $0 [--check | --guard-push] [repo_dir]" >&2
            exit 1
            ;;
    esac
fi
