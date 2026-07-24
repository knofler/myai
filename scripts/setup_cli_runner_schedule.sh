#!/usr/bin/env bash
# setup_cli_runner_schedule.sh — install/remove the launchd schedule that fires
# cli_task_runner.sh on this Mac. launchd (not cron) because macOS TCC blocks
# cron from the home directory by default; a user LaunchAgent runs with your normal
# file access and survives reboots.
#
#   ./scripts/setup_cli_runner_schedule.sh                   # install: every 10 MINUTES
#   ./scripts/setup_cli_runner_schedule.sh --every-minutes 10  # custom (minutes)
#   ./scripts/setup_cli_runner_schedule.sh --every-hours 3   # custom (hours, legacy)
#   ./scripts/setup_cli_runner_schedule.sh --in-minutes 5    # ALSO add a one-shot test fire in N minutes
#   ./scripts/setup_cli_runner_schedule.sh --status          # show agent + last log
#   ./scripts/setup_cli_runner_schedule.sh --uninstall       # remove
#
# Interval rationale (user directive 2026-06-15): fire every 10 MINUTES. The
# runner is slot-based (MAX_CONCURRENT, default 5) — each fire claims a slot and
# works one distinct task, so up to 5 run in parallel; when full it backs off
# 30m. This drains the queue continuously instead of 1 task per multi-hour
# window. Off-hours guard still confines autonomous runs to weekday 6pm–9am +
# weekends. bash 3.2-safe.
#
# Platform routing: this file is the ENTRY POINT on every platform. On Linux
# (incl. WSL2) it delegates (same args) to setup_cli_runner_linux.sh — systemd
# user timer with cron fallback. On native Windows shells (Git Bash/MSYS/Cygwin)
# it can't register a Windows schedule, so it points at the WSL2 path
# (recommended) or setup_cli_runner_windows.ps1 (experimental schtasks) — see
# documentation/WINDOWS_RUNNER.md. launchd below is the macOS path.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
case "$(uname -s)" in
Linux)
    exec bash "$SCRIPT_DIR/setup_cli_runner_linux.sh" "$@"
    ;;
MINGW*|MSYS*|CYGWIN*)
    echo "Windows detected — this installer can't register a Windows schedule from Git Bash." >&2
    echo "  RECOMMENDED: run this same script inside WSL2 (auto-routes to the systemd installer)." >&2
    echo "  EXPERIMENTAL native path: powershell -ExecutionPolicy Bypass -File scripts/setup_cli_runner_windows.ps1" >&2
    echo "  Full guide: documentation/WINDOWS_RUNNER.md" >&2
    exit 1
    ;;
esac

LABEL="com.myai.cli-task-runner"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNNER="$SCRIPT_DIR/cli_task_runner.sh"
LOG_DIR="$HOME/.ai-cli-runner"
EVERY_MINUTES=10
EVERY_HOURS=""
ACTION=install
TEST_MINUTES=""

while [ $# -gt 0 ]; do
    case "$1" in
        --every-minutes) shift; EVERY_MINUTES="${1:?--every-minutes needs a value}"; EVERY_HOURS="" ;;
        --every-hours) shift; EVERY_HOURS="${1:?--every-hours needs a value}" ;;
        --in-minutes)  shift; TEST_MINUTES="${1:?--in-minutes needs a value}" ;;
        --status)      ACTION=status ;;
        --uninstall)   ACTION=uninstall ;;
        -h|--help)     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
    esac
    shift
done

case "$ACTION" in
status)
    if launchctl list "$LABEL" >/dev/null 2>&1; then
        echo "INSTALLED: $LABEL"
        launchctl list "$LABEL" | grep -E '"(PID|LastExitStatus)"' || true
    else
        echo "NOT installed."
    fi
    last_log=$(ls -t "$LOG_DIR/logs" 2>/dev/null | head -1 || true)
    [ -n "$last_log" ] && echo "Last session log: $LOG_DIR/logs/$last_log"
    echo "Runner stdout: $LOG_DIR/runner.out"
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
if [ -n "$EVERY_HOURS" ]; then
    INTERVAL=$(( EVERY_HOURS * 3600 )); CADENCE="every ${EVERY_HOURS}h"
else
    INTERVAL=$(( EVERY_MINUTES * 60 )); CADENCE="every ${EVERY_MINUTES}m"
fi

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$RUNNER</string>
    </array>
    <key>StartInterval</key><integer>$INTERVAL</integer>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>$LOG_DIR/runner.out</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/runner.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>CLAUDE_CONFIG_DIR</key><string>$HOME/.claude-tech</string>
    </dict>
</dict>
PLIST_EOF
echo "</plist>" >> "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Installed $LABEL — fires ${CADENCE} (slot-based, up to ${MAX_CONCURRENT:-5} concurrent; backs off 30m when full)."
echo "Watch: tail -f $LOG_DIR/runner.out"

if [ -n "$TEST_MINUTES" ]; then
    echo "One-shot test fire in ${TEST_MINUTES}m via 'launchctl start' (detached)..."
    ( sleep $(( TEST_MINUTES * 60 )); launchctl start "$LABEL" ) >/dev/null 2>&1 &
    echo "  armed — PID $! (or fire immediately yourself: launchctl start $LABEL)"
fi
