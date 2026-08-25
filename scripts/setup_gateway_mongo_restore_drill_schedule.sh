#!/usr/bin/env bash
# setup_gateway_mongo_restore_drill_schedule.sh — install/remove the scheduled
# job that runs scripts/gateway_mongo_restore_drill.sh (ADR-037 §4).
# Mirrors setup_hosted_brain_restore_drill_schedule.sh's launchd (macOS) / crontab
# (Linux) cron-registration pattern exactly, same TCC rationale: launchd runs
# with normal file access where plain cron is blocked from the home directory
# on macOS.
#
#   ./scripts/setup_gateway_mongo_restore_drill_schedule.sh                  # install: quarterly (default)
#   ./scripts/setup_gateway_mongo_restore_drill_schedule.sh --every-days 28  # custom cadence (must divide 28 on Linux cron)
#   ./scripts/setup_gateway_mongo_restore_drill_schedule.sh --status         # installed? last drill result?
#   ./scripts/setup_gateway_mongo_restore_drill_schedule.sh --uninstall      # remove
#
# Gateway host operator action ONLY — never installed automatically, same
# discipline as the backup schedule. Install is idempotent: re-running
# rewrites the job in place.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
DRILL="$SCRIPT_DIR/gateway_mongo_restore_drill.sh"
MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
LOG_DIR="$MYAI_HOME/logs"
LAST_RUN_FILE="${GATEWAY_MONGO_RESTORE_DRILL_LAST:-$MYAI_HOME/gateway-mongo-restore-drill.last}"

LABEL="com.myai.gateway-mongo-restore-drill"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CRON_TAG="# myai-gateway-mongo-restore-drill"

EVERY_DAYS=90
ACTION=install

while [ $# -gt 0 ]; do
    case "$1" in
        --every-days) shift; EVERY_DAYS="${1:?--every-days needs a value}" ;;
        --status)     ACTION=status ;;
        --uninstall)  ACTION=uninstall ;;
        -h|--help)    grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
    esac
    shift
done

show_last_run() {
    if [ -f "$LAST_RUN_FILE" ]; then
        echo "Last drill ($LAST_RUN_FILE):"
        sed 's/^/  /' "$LAST_RUN_FILE"
    else
        echo "No restore drill recorded yet ($LAST_RUN_FILE missing)."
    fi
    echo "Logs: $LOG_DIR/gateway-mongo-restore-drill.out / gateway-mongo-restore-drill.err"
}

# ── Linux: idempotent, marker-tagged crontab line ─────────────────────────────
# Default (90 days) maps to a real calendar-quarterly expression (day 1 of
# Jan/Apr/Jul/Oct) rather than an approximate "every N days" — cron has no
# native N-day interval, so anything other than the default must cleanly
# divide 28 (fires on that day-of-month every month; the closest cron can get
# to an even N-day cadence without drifting across months of different length).
cron_schedule_expr() {
    local d="$1"
    if [ "$d" -eq 90 ]; then printf '0 4 1 1,4,7,10 *';
    elif [ "$d" -lt 28 ] && [ $(( 28 % d )) -eq 0 ]; then printf '0 4 */%s * *' "$d";
    else
        echo "ERROR: cron can't express a ${d}-day interval cleanly — use the default (90, calendar-quarterly), a divisor of 28, or install on macOS (launchd supports arbitrary day intervals)" >&2
        return 1
    fi
}

linux_install() {
    command -v crontab >/dev/null 2>&1 || { echo "ERROR: crontab not found — install cron" >&2; exit 1; }
    local expr; expr="$(cron_schedule_expr "$EVERY_DAYS")"
    mkdir -p "$LOG_DIR"
    local line="$expr /bin/bash $DRILL >> $LOG_DIR/gateway-mongo-restore-drill.out 2>> $LOG_DIR/gateway-mongo-restore-drill.err $CRON_TAG"
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; echo "$line"; } | crontab -
    echo "Installed cron gateway-mongo-restore-drill job — fires every ${EVERY_DAYS}d."
    echo "  $line"
}

linux_uninstall() {
    command -v crontab >/dev/null 2>&1 || { echo "crontab not found — nothing to remove."; exit 0; }
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; } | crontab -
    echo "Removed the myai-gateway-mongo-restore-drill cron line (other crontab entries untouched)."
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
    echo "Windows detected — schedule the drill from WSL2 (cron) instead; see architecture/ADR-037-hosted-gateway-mongo-backup-dr.md." >&2
    exit 1
    ;;
esac

# ── macOS: user LaunchAgent (same pattern as the backup schedule) ───────────
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
INTERVAL=$(( EVERY_DAYS * 86400 ))

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$DRILL</string>
    </array>
    <key>StartInterval</key><integer>$INTERVAL</integer>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>$LOG_DIR/gateway-mongo-restore-drill.out</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/gateway-mongo-restore-drill.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
PLIST_EOF
echo "</plist>" >> "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Installed $LABEL — drills the newest gateway Mongo backup every ${EVERY_DAYS}d."
echo "Watch: tail -f $LOG_DIR/gateway-mongo-restore-drill.out   ·   status: $0 --status"
