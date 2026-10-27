#!/usr/bin/env bash
# runner_auth_guard.sh — an expired CLI login is a MACHINE condition, not a task failure.
#
# 2026-09-09: one Mac's runner-profile OAuth session expired. Every
# headless task the runner claimed there died with "Failed to authenticate: OAuth
# session expired and could not be refreshed" — and each death went through the
# normal failure path: tasks_fail bumped the task's retry ledger (3 strikes →
# dead_letter), the escalation ledger accrued a "failure", and the next 10-minute
# fire claimed the next task and did it again. Nothing was wrong with the tasks;
# the machine simply could not log in, and the fix (an interactive `claude login`
# on that Mac) was never surfaced.
#
# This library gives the runner three things, all hermetic and unit-tested:
#   • auth_guard_failure_in_log <log>  — recognise the auth-failure signature
#   • auth_guard_arm <profile_dir> [sig] / auth_guard_skip_reason <profile_dir>
#       — a per-profile marker so subsequent fires SKIP claiming on this machine
#         for AUTH_GUARD_RETRY_MIN minutes (default 60), then let ONE probe task
#         through; a still-failing probe re-arms, a success clears
#   • auth_guard_clear <profile_dir>   — called on any successful session
# The runner releases the affected task back to `pending` WITHOUT consuming a
# retry, skips the escalation ledger, and notifies the operator with the exact
# fix command — so an expired login can never dead-letter work again.
#
# State lives under AUTH_GUARD_DIR (default ~/.ai-cli-runner/auth-guard, one
# marker per profile: <profile>.expired). Sourced by scripts/cli_task_runner.sh.

AUTH_GUARD_RETRY_MIN=${AUTH_GUARD_RETRY_MIN:-60}
# The CLI's own wording for a dead login (OAuth and API-key flavours). Extend here,
# never inline at the call site, so the test suite pins every phrase we act on.
AUTH_GUARD_PATTERN=${AUTH_GUARD_PATTERN:-'Failed to authenticate|OAuth session expired|Not logged in|Please run /login|Invalid authentication credentials|authentication_error'}

auth_guard_dir() {
    local d="${AUTH_GUARD_DIR:-${RUNNER_STATE_DIR:-$HOME/.ai-cli-runner}/auth-guard}"
    mkdir -p "$d" 2>/dev/null || true
    printf '%s' "$d"
}

# auth_guard_profile <profile_dir> — ~/.claude-<x> → claude-<x> (the CLAUDE_CONFIG_DIR basename, dot stripped)
auth_guard_profile() {
    local b; b="$(basename "${1:-$HOME/.claude}")"
    printf '%s' "${b#.}"
}

auth_guard_marker() { printf '%s/%s.expired' "$(auth_guard_dir)" "$(auth_guard_profile "$1")"; }

auth_guard_fix_cmd() { printf 'CLAUDE_CONFIG_DIR=%s claude login' "${1:-$HOME/.claude}"; }

# rc 0 when the session log carries an auth-failure signature.
auth_guard_failure_in_log() { [ -f "${1:-}" ] && grep -qE "$AUTH_GUARD_PATTERN" "$1" 2>/dev/null; }

# The first matched phrase (for notes/notifications), or empty.
auth_guard_signature() { grep -oE "$AUTH_GUARD_PATTERN" "${1:-/dev/null}" 2>/dev/null | head -1; }

# auth_guard_arm <profile_dir> [signature] — (re)write the marker; mtime = now.
auth_guard_arm() {
    local dir="${1:-$HOME/.claude}" m; m="$(auth_guard_marker "$dir")"
    {
        printf 'armed=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        printf 'host=%s\n' "$(hostname -s 2>/dev/null || echo runner)"
        printf 'profile_dir=%s\n' "$dir"
        printf 'signature=%s\n' "${2:-}"
        printf 'fix=%s\n' "$(auth_guard_fix_cmd "$dir")"
    } > "$m"
    printf '%s' "$m"
}

auth_guard_clear() { rm -f "$(auth_guard_marker "${1:-$HOME/.claude}")" 2>/dev/null || true; }

# Seconds since the marker was armed; -1 when not armed.
auth_guard_age_sec() {
    local m mt; m="$(auth_guard_marker "${1:-$HOME/.claude}")"
    [ -f "$m" ] || { printf '%s' -1; return 0; }
    # GNU stat first (`-c %Y` = mtime epoch); BSD/macOS stat has no -c, so fall
    # back to `-f %m`. NOT the other way round: on Linux `stat -f %m` SUCCEEDS
    # and prints the filesystem's mount point ("/"), which silently broke the
    # age math on the CI runner (test_runner_auth_guard 17/21 there, 21/21 on macOS).
    if mt="$(stat -c %Y "$m" 2>/dev/null)" && [ "$mt" -ge 0 ] 2>/dev/null; then :
    else mt="$(stat -f %m "$m" 2>/dev/null || echo 0)"; fi
    printf '%s' $(( $(date +%s) - mt ))
}

# auth_guard_skip_reason <profile_dir> — rc 0 + reason while the marker is younger
# than AUTH_GUARD_RETRY_MIN (skip claiming); rc 1 once it has aged out (let one
# probe task through — its outcome re-arms or clears) or when not armed.
auth_guard_skip_reason() {
    local dir="${1:-$HOME/.claude}" age
    age="$(auth_guard_age_sec "$dir")"
    [ "$age" -ge 0 ] 2>/dev/null || return 1
    if [ "$age" -lt $(( AUTH_GUARD_RETRY_MIN * 60 )) ]; then
        printf 'auth expired on this machine for profile %s (%ss ago) — skipping autonomous run for %s min so tasks are not burned; fix: %s' \
            "$(auth_guard_profile "$dir")" "$age" "$AUTH_GUARD_RETRY_MIN" "$(auth_guard_fix_cmd "$dir")"
        return 0
    fi
    return 1
}
