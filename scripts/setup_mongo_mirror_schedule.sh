#!/usr/bin/env bash
# setup_mongo_mirror_schedule.sh — install/remove the schedule that refreshes
# the LOCAL mongo mirror (scripts/mongo_mirror.sh, Atlas → local) on a cadence,
# so the warm local copy of memory + registry never goes stale. Mirrors the
# CLI runner's launchd pattern (setup_cli_runner_schedule.sh): launchd (not
# cron) on macOS because TCC blocks cron from the home directory by default; a
# user LaunchAgent runs with your normal file access and survives reboots. On
# Linux it installs an idempotent, marker-tagged crontab line instead.
#
#   ./scripts/setup_mongo_mirror_schedule.sh                    # install: HOURLY
#   ./scripts/setup_mongo_mirror_schedule.sh --every-minutes 30 # custom (minutes)
#   ./scripts/setup_mongo_mirror_schedule.sh --every-hours 3    # custom (hours)
#   ./scripts/setup_mongo_mirror_schedule.sh --status           # installed? last run?
#   ./scripts/setup_mongo_mirror_schedule.sh --uninstall        # remove
#
# Also reachable as `myai mirror --install-schedule` / `--schedule-status` /
# `--uninstall-schedule` (mongo_mirror.sh forwards here).
#
# NEVER installed automatically (documentation/MONGO_MIRROR.md: a machine must
# not grow a surprise job) — the operator runs this once, explicitly. Install
# is idempotent: re-running rewrites the job in place with the new cadence.
# Each mirror run records its outcome in $MYAI_HOME/mongo-mirror.last, which
# `myai doctor` surfaces as the "mongo mirror schedule" check. bash 3.2-safe.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
MIRROR="$SCRIPT_DIR/mongo_mirror.sh"
MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
LOG_DIR="$MYAI_HOME/logs"
LAST_RUN_FILE="$MYAI_HOME/mongo-mirror.last"

LABEL="com.myai.mongo-mirror"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CRON_TAG="# myai-mongo-mirror"

EVERY_MINUTES=60
EVERY_HOURS=""
ACTION=install

while [ $# -gt 0 ]; do
    case "$1" in
        --every-minutes) shift; EVERY_MINUTES="${1:?--every-minutes needs a value}"; EVERY_HOURS="" ;;
        --every-hours) shift; EVERY_HOURS="${1:?--every-hours needs a value}" ;;
        --status)      ACTION=status ;;
        --uninstall)   ACTION=uninstall ;;
        -h|--help)     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
    esac
    shift
done

[ -n "$EVERY_HOURS" ] && EVERY_MINUTES=$(( EVERY_HOURS * 60 ))

show_last_run() {
    if [ -f "$LAST_RUN_FILE" ]; then
        echo "Last run ($LAST_RUN_FILE):"
        sed 's/^/  /' "$LAST_RUN_FILE"
    else
        echo "No mirror run recorded yet ($LAST_RUN_FILE missing)."
    fi
    echo "Logs: $LOG_DIR/mongo-mirror.out / mongo-mirror.err"
}

# ── Linux: idempotent, marker-tagged crontab line ─────────────────────────────
# The tag lets install replace ONLY our line (preserving the rest of the
# crontab) and uninstall remove ONLY ours — never clobbering operator entries.
cron_schedule_expr() {
    local m="$1"
    if [ "$m" -lt 60 ]; then
        printf '*/%s * * * *' "$m"
    elif [ $(( m % 60 )) -eq 0 ]; then
        local h=$(( m / 60 ))
        if [ "$h" -eq 1 ]; then printf '0 * * * *'; else printf '0 */%s * * *' "$h"; fi
    else
        echo "ERROR: cron can't express a ${m}-minute interval — use minutes <60 or whole hours" >&2
        return 1
    fi
}

linux_install() {
    command -v crontab >/dev/null 2>&1 || { echo "ERROR: crontab not found — install cron (or use the systemd pattern from setup_cli_runner_linux.sh)" >&2; exit 1; }
    local expr; expr="$(cron_schedule_expr "$EVERY_MINUTES")"
    mkdir -p "$LOG_DIR"
    local line="$expr /bin/bash $MIRROR >> $LOG_DIR/mongo-mirror.out 2>> $LOG_DIR/mongo-mirror.err $CRON_TAG"
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; echo "$line"; } | crontab -
    echo "Installed cron mirror job — fires every ${EVERY_MINUTES}m."
    echo "  $line"
}

linux_uninstall() {
    command -v crontab >/dev/null 2>&1 || { echo "crontab not found — nothing to remove."; exit 0; }
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; } | crontab -
    echo "Removed the myai-mongo-mirror cron line (other crontab entries untouched)."
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
    echo "Windows detected — schedule the mirror from WSL2 (cron) instead; see documentation/MONGO_MIRROR.md." >&2
    exit 1
    ;;
esac

# ── macOS: user LaunchAgent (same pattern as the CLI runner) ──────────────────
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
INTERVAL=$(( EVERY_MINUTES * 60 ))

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$MIRROR</string>
    </array>
    <key>StartInterval</key><integer>$INTERVAL</integer>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>$LOG_DIR/mongo-mirror.out</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/mongo-mirror.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
PLIST_EOF
echo "</plist>" >> "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Installed $LABEL — refreshes the local mongo mirror every ${EVERY_MINUTES}m."
echo "Watch: tail -f $LOG_DIR/mongo-mirror.out   ·   status: myai mirror --schedule-status"
