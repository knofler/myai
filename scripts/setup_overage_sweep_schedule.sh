#!/usr/bin/env bash
# setup_overage_sweep_schedule.sh — install/remove the monthly timer that runs
# overage_sweep_cron.sh (ADR-014 usage-based overage invoicing, task-e2073713
# follow-up to task-b3e501e8). The sweep route was shipped as "the monthly
# cron entry point" but nothing ever called it — it only fired if an operator
# remembered to curl it by hand. This closes that gap the same way
# setup_mongo_sync_schedule.sh closed ADR-022's identical scheduling gap.
#
# Mirrors setup_mongo_sync_schedule.sh: launchd (not cron) on macOS because
# TCC blocks cron from the home directory by default; a user LaunchAgent runs
# with your normal file access and survives reboots. On Linux it installs an
# idempotent, marker-tagged crontab line instead.
#
# Fires on the 1st of every month (default 06:00 local) — after the month has
# fully closed, well before the route's own "month not yet complete" guard
# would matter, and at the same posture as the other calendar-boundary sweeps
# in this repo (quota-reset-sweep, sla-credit).
#
#   ./scripts/setup_overage_sweep_schedule.sh                # install: 1st of month, 06:00
#   ./scripts/setup_overage_sweep_schedule.sh --hour 3        # custom hour (0-23)
#   ./scripts/setup_overage_sweep_schedule.sh --status         # installed? last run?
#   ./scripts/setup_overage_sweep_schedule.sh --uninstall       # remove
#
# NEVER installed automatically (same posture as setup_mongo_sync_schedule.sh
# — a machine must not grow a surprise job) — the operator runs this once,
# explicitly. Install is idempotent: re-running rewrites the job in place with
# the new hour. bash 3.2-safe.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SWEEP="$SCRIPT_DIR/overage_sweep_cron.sh"
MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
LOG_DIR="$MYAI_HOME/logs"
SWEEP_LAST_RUN_FILE="${OVERAGE_SWEEP_LOG:-}"
[ -n "$SWEEP_LAST_RUN_FILE" ] || SWEEP_LAST_RUN_FILE="$(cd "$SCRIPT_DIR/.." && pwd)/state/.overage_sweep_last"

LABEL="com.myai.overage-sweep"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CRON_TAG="# myai-overage-sweep"

HOUR=6
ACTION=install

while [ $# -gt 0 ]; do
    case "$1" in
        --hour)      shift; HOUR="${1:?--hour needs a value (0-23)}" ;;
        --status)    ACTION=status ;;
        --uninstall) ACTION=uninstall ;;
        -h|--help)   grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
    esac
    shift
done

case "$HOUR" in
    ''|*[!0-9]*) echo "ERROR: --hour must be an integer 0-23" >&2; exit 1 ;;
esac
if [ "$HOUR" -lt 0 ] || [ "$HOUR" -gt 23 ]; then
    echo "ERROR: --hour must be an integer 0-23" >&2; exit 1
fi

show_last_run() {
    if [ -f "$SWEEP_LAST_RUN_FILE" ]; then
        echo "Last sweep ($SWEEP_LAST_RUN_FILE):"
        sed 's/^/  /' "$SWEEP_LAST_RUN_FILE"
    else
        echo "No sweep run recorded yet ($SWEEP_LAST_RUN_FILE missing)."
    fi
    echo "Logs: $LOG_DIR/overage-sweep.{out,err}"
}

# ── Linux: idempotent, marker-tagged crontab line ───────────────────────────
# Tag lets install replace ONLY our line (preserving the rest of the
# crontab) and uninstall remove ONLY ours — never clobbering operator entries.
linux_install() {
    command -v crontab >/dev/null 2>&1 || { echo "ERROR: crontab not found — install cron (or use the systemd pattern from setup_cli_runner_linux.sh)" >&2; exit 1; }
    mkdir -p "$LOG_DIR"
    local line="0 $HOUR 1 * * /bin/bash $SWEEP >> $LOG_DIR/overage-sweep.out 2>> $LOG_DIR/overage-sweep.err $CRON_TAG"
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; echo "$line"; } | crontab -
    echo "Installed cron overage-sweep job — fires 1st of month at ${HOUR}:00."
    echo "  $line"
}

linux_uninstall() {
    command -v crontab >/dev/null 2>&1 || { echo "crontab not found — nothing to remove."; exit 0; }
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; } | crontab -
    echo "Removed the myai-overage-sweep cron line (other crontab entries untouched)."
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
    echo "Windows detected — schedule overage_sweep_cron.sh from WSL2 (cron) instead; see documentation/MONGO_MIRROR.md for the analogous WSL2 note." >&2
    exit 1
    ;;
esac

# ── macOS: user LaunchAgent (same pattern as mongo_sync / CLI runner) ──────
write_plist() {
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SWEEP</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Day</key><integer>1</integer>
        <key>Hour</key><integer>$HOUR</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>$LOG_DIR/overage-sweep.out</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/overage-sweep.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
PLIST_EOF
    echo "</plist>" >> "$PLIST"
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
}

case "$ACTION" in
status)
    if launchctl list "$LABEL" >/dev/null 2>&1; then
        echo "INSTALLED: $LABEL"
        launchctl list "$LABEL" | grep -E '"(PID|LastExitStatus)"' || true
    else
        echo "NOT installed: $LABEL"
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
write_plist

echo "Installed $LABEL — fires 1st of month at ${HOUR}:00 local."
echo "Watch: tail -f $LOG_DIR/overage-sweep.out"
echo "Status: ./scripts/setup_overage_sweep_schedule.sh --status"
