#!/usr/bin/env bash
# setup_config_drift_schedule.sh — install/remove the daily timer that runs
# scripts/check_config_drift.sh independent of any Claude session.
#
# THE GAP: check_config_drift.sh (task cb95d521) can diff every managed
# repo's .claude/settings.json / hooks/** / AI/config/*.txt against this
# master's canonical copies and correctly tell content drift apart from a
# missing file (health_check.sh's job) — but nothing ever calls it. It only
# ran when an operator remembered to run it by hand. This closes that gap the
# same way setup_gateway_mongo_backup_schedule.sh / setup_overage_sweep_schedule.sh
# closed the identical scheduling gap for their own checks: a host-level
# launchd (macOS) / cron (Linux) timer, independent of the gateway (DEPLOY
# GUARD — this never touches the shared myai gateway/dashboard/mongo stack).
#
# Mirrors setup_gateway_mongo_backup_schedule.sh's launchd/cron shape exactly
# (StartInterval on macOS — TCC blocks plain cron from the home directory by
# default; a marker-tagged crontab line on Linux). Default cadence is once a
# day: repo configs drift slowly (a manual hand-edit), so hourly would just be
# noise — daily is enough to catch it before it causes a fleet-wide
# inconsistency.
#
#   ./scripts/setup_config_drift_schedule.sh                    # install: DAILY (24h)
#   ./scripts/setup_config_drift_schedule.sh --every-hours 12   # custom cadence (divisor of 24)
#   ./scripts/setup_config_drift_schedule.sh --status           # installed? last run + drift count?
#   ./scripts/setup_config_drift_schedule.sh --uninstall        # remove
#
# NEVER installed automatically (same posture as the mongo backup / overage
# sweep schedules — a machine must not grow a surprise job) — the operator
# runs this once, explicitly. Install is idempotent: re-running rewrites the
# job in place with the new cadence.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CHECK="$SCRIPT_DIR/check_config_drift.sh"
LOG_DIR="$HOME/.ai-cli-runner"

LABEL="com.myai.config-drift-check"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CRON_TAG="# myai-config-drift-check"

EVERY_HOURS=24
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

show_last_run() {
    "$CHECK" --status
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
    local line="$expr /bin/bash $CHECK >> $LOG_DIR/config-drift-check.out 2>> $LOG_DIR/config-drift-check.err $CRON_TAG"
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; echo "$line"; } | crontab -
    echo "Installed cron config-drift-check job — fires every ${EVERY_HOURS}h."
    echo "  $line"
}

linux_uninstall() {
    command -v crontab >/dev/null 2>&1 || { echo "crontab not found — nothing to remove."; exit 0; }
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; } | crontab -
    echo "Removed the myai-config-drift-check cron line (other crontab entries untouched)."
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
    echo "Windows detected — schedule check_config_drift.sh from WSL2 (cron) instead." >&2
    exit 1
    ;;
esac

# ── macOS: user LaunchAgent (same pattern as the mongo backup schedule) ─────
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
        <string>$CHECK</string>
    </array>
    <key>StartInterval</key><integer>$INTERVAL</integer>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>$LOG_DIR/config-drift-check.out</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/config-drift-check.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
PLIST_EOF
echo "</plist>" >> "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Installed $LABEL — runs check_config_drift.sh every ${EVERY_HOURS}h."
echo "Watch: tail -f $LOG_DIR/config-drift-check.out   ·   status: $0 --status"
