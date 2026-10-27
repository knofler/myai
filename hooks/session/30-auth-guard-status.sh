#!/bin/bash
set +e
# Hook: Runner Auth-Guard Fleet Visibility
# Event: SessionStart (runs on every session boot)
#
# scripts/lib/runner_auth_guard.sh (sourced by scripts/cli_task_runner.sh) arms
# a per-profile marker under ~/.ai-cli-runner/auth-guard/<profile>.expired the
# moment a headless run dies on an expired CLI login — routing the release to
# pending WITHOUT burning a task retry, instead of dead-lettering real work on
# a machine condition (task-069e3321: 7 tasks dead-lettered Sep 7-10 on "OAuth
# session expired" while that directory sat empty the whole time — nobody on
# the fleet had any signal the guard had (or hadn't) engaged). The marker itself
# was invisible until an operator noticed tasks dead-lettering by hand. Surface
# it loudly on every session boot instead, on every machine, not just the one
# that hit the expired login.

AUTH_GUARD_DIR="${AUTH_GUARD_DIR:-${RUNNER_STATE_DIR:-$HOME/.ai-cli-runner}/auth-guard}"

[ -d "$AUTH_GUARD_DIR" ] || exit 0

FOUND=0
for m in "$AUTH_GUARD_DIR"/*.expired; do
  [ -f "$m" ] || continue
  FOUND=1
  ARMED_AT=$(grep '^armed=' "$m" 2>/dev/null | cut -d= -f2-)
  PROFILE_DIR=$(grep '^profile_dir=' "$m" 2>/dev/null | cut -d= -f2-)
  FIX=$(grep '^fix=' "$m" 2>/dev/null | cut -d= -f2-)
  [ -z "$FIX" ] && FIX="CLAUDE_CONFIG_DIR=${PROFILE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}} claude login"
  echo "runner: auth-guard ARMED since ${ARMED_AT:-unknown} — fix: $FIX"
done

if [ "$FOUND" -eq 0 ]; then
  echo "runner: auth-guard clear (no expired-login marker)"
fi

exit 0
