#!/usr/bin/env bash
# setup_reconcile_review_schedule.sh — install/remove the recurring timer that
# runs scripts/reconcile_review_tasks.sh independent of any Claude session.
#
# THE GAP: reconcile_review_tasks.sh (task-73198ed6's predecessor, LL
# 2026-06-23) is already idempotent and fail-safe — it only ever flips a
# review/blocked task to done when it can PROVE the work is on origin/main.
# It's wired into `agent mode` start, `/fleet` (fleet_resume.sh), `wrap up`,
# and the CLI runner (throttled to once/hour) — but every one of those paths
# only fires when a human or the runner happens to be active. A repo that
# sits idle for a while (runner off, always busy claiming other tasks, nobody
# runs `/fleet`) never gets reconciled, and its phantom review/blocked pile
# grows silently until someone notices. That's exactly what happened on
# 2026-07-16: 14 phantom `review` tasks (shipped-but-never-flipped, test==main)
# had to be cleared by a manual run.
#
# This closes the gap the same way setup_config_drift_schedule.sh closed the
# identical scheduling gap for check_config_drift.sh: a host-level launchd
# (macOS) / cron (Linux) timer, independent of the gateway (DEPLOY GUARD —
# this never touches the shared myai gateway/dashboard/mongo stack; it only
# curls the ALREADY-RUNNING gateway's MCP endpoint, same as the CLI runner
# already does every fire).
#
# Default cadence is hourly — matching the CLI runner's own internal
# `--throttle-min 60` for this same script, so an idle-runner period is never
# worse than an active one. The installed job passes reconcile_review_tasks.sh
# its own `--throttle-min`/`--marker` flags (self-throttled just under the
# timer interval) so an overlapping/duplicate timer fire — e.g. right after a
# sleep/wake, a known launchd StartInterval quirk — is a safe no-op rather
# than a redundant fleet-wide git fetch.
#
#   ./scripts/setup_reconcile_review_schedule.sh                    # install: HOURLY (1h)
#   ./scripts/setup_reconcile_review_schedule.sh --every-hours 2    # custom cadence (divisor of 24)
#   ./scripts/setup_reconcile_review_schedule.sh --status           # installed? last run + counts?
#   ./scripts/setup_reconcile_review_schedule.sh --uninstall        # remove
#
# NEVER installed automatically (same posture as the config-drift / mongo
# backup / overage sweep schedules — a machine must not grow a surprise job)
# — the operator runs this once, explicitly. Install is idempotent:
# re-running rewrites the job in place with the new cadence.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
RECONCILE="$SCRIPT_DIR/reconcile_review_tasks.sh"
LOG_DIR="$HOME/.ai-cli-runner"
MARKER_FILE="$LOG_DIR/reconcile-review.marker"

LABEL="com.myai.reconcile-review-tasks"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CRON_TAG="# myai-reconcile-review-tasks"

EVERY_HOURS=1
ACTION=install

while [ $# -gt 0 ]; do
    case "$1" in
        --every-hours) shift; EVERY_HOURS="${1:?--every-hours needs a value}" ;;
        --status)      ACTION=status ;;
        --uninstall)   ACTION=uninstall ;;
        -h|--help)     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
    esac
    shift
done

case "$EVERY_HOURS" in
    ''|*[!0-9]*) echo "ERROR: --every-hours must be a positive integer" >&2; exit 1 ;;
esac
if [ "$EVERY_HOURS" -lt 1 ] || [ "$EVERY_HOURS" -gt 24 ]; then
    echo "ERROR: --every-hours must be between 1 and 24" >&2; exit 1
fi

# Self-throttle just under the timer interval (5 min slack, floor of 1) so a
# duplicate/overlapping timer fire is a safe idempotent no-op instead of a
# redundant fleet-wide fetch. --marker persists in $LOG_DIR (not /tmp) so the
# throttle survives a reboot, unlike the CLI runner's own /tmp marker.
THROTTLE_MIN=$(( EVERY_HOURS * 60 - 5 ))
[ "$THROTTLE_MIN" -lt 1 ] && THROTTLE_MIN=1

show_last_run() {
    "$RECONCILE" --status
}

# ── Linux: idempotent, marker-tagged crontab line ───────────────────────────
# Tag lets install replace ONLY our line (preserving the rest of the
# crontab) and uninstall remove ONLY ours — never clobbering operator entries.
cron_schedule_expr() {
    local h="$1"
    if [ "$h" -eq 24 ]; then printf '0 3 * * *';
    elif [ $(( 24 % h )) -eq 0 ]; then printf '0 */%s * * *' "$h";
    else
        echo "ERROR: cron can't express a ${h}-hour interval cleanly — use a divisor of 24" >&2
        return 1
    fi
}

linux_install() {
    command -v crontab >/dev/null 2>&1 || { echo "ERROR: crontab not found — install cron" >&2; exit 1; }
    local expr; expr="$(cron_schedule_expr "$EVERY_HOURS")"
    mkdir -p "$LOG_DIR"
    local line="$expr /bin/bash $RECONCILE --throttle-min $THROTTLE_MIN --marker $MARKER_FILE >> $LOG_DIR/reconcile-review.out 2>> $LOG_DIR/reconcile-review.err $CRON_TAG"
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; echo "$line"; } | crontab -
    echo "Installed cron reconcile-review-tasks job — fires every ${EVERY_HOURS}h (self-throttled to ${THROTTLE_MIN}m)."
    echo "  $line"
}

linux_uninstall() {
    command -v crontab >/dev/null 2>&1 || { echo "crontab not found — nothing to remove."; exit 0; }
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; } | crontab -
    echo "Removed the myai-reconcile-review-tasks cron line (other crontab entries untouched)."
}

linux_status() {
    local line
    line="$(crontab -l 2>/dev/null | grep -F "$CRON_TAG" || true)"
    if [ -n "$line" ]; then
        echo "INSTALLED (cron):"
        printf '  %s\n' "$line"
    else
        echo "NOT installed."
    fi
    show_last_run
}

case "$(uname -s)" in
Linux)
    case "$ACTION" in
        install)   linux_install ;;
        uninstall) linux_uninstall ;;
        status)    linux_status ;;
    esac
    exit 0
    ;;
MINGW*|MSYS*|CYGWIN*)
    echo "Windows detected — schedule reconcile_review_tasks.sh from WSL2 (cron) instead." >&2
    exit 1
    ;;
esac

# ── macOS: user LaunchAgent (same pattern as the config-drift / mongo backup schedules) ─
case "$ACTION" in
status)
    if launchctl list "$LABEL" >/dev/null 2>&1; then
        echo "INSTALLED: $LABEL"
        launchctl list "$LABEL" | grep -E '"(PID|LastExitStatus)"' || true
    else
        echo "NOT installed."
    fi
    show_last_run
    exit 0
    ;;
uninstall)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Uninstalled $LABEL."
    exit 0
    ;;
esac

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
INTERVAL=$(( EVERY_HOURS * 3600 ))

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$RECONCILE</string>
        <string>--throttle-min</string>
        <string>$THROTTLE_MIN</string>
        <string>--marker</string>
        <string>$MARKER_FILE</string>
    </array>
    <key>StartInterval</key><integer>$INTERVAL</integer>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>$LOG_DIR/reconcile-review.out</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/reconcile-review.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
PLIST_EOF
echo "</plist>" >> "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Installed $LABEL — runs reconcile_review_tasks.sh every ${EVERY_HOURS}h (self-throttled to ${THROTTLE_MIN}m)."
echo "Watch: tail -f $LOG_DIR/reconcile-review.out   ·   status: $0 --status"
