#!/usr/bin/env bash
# setup_mongo_sync_schedule.sh — install/remove the schedule that runs
# mongo_sync.sh (ADR-022 local-first mongo mode: PRIMARY → SECONDARY
# convergence) on a cadence, PLUS an independent staleness canary
# (mongo_sync_staleness.sh) that raises a notification-engine alert the
# moment convergence stops actually happening. ADR-022's own scheduling
# section said to "run mongo_sync.sh on a cron/launchd timer" but nothing
# shipped that timer — convergence depended on an operator remembering to
# run it by hand. This closes that gap.
#
# Mirrors the CLI runner's launchd pattern (setup_cli_runner_schedule.sh) and
# is the direct sibling of setup_mongo_mirror_schedule.sh: launchd (not cron)
# on macOS because TCC blocks cron from the home directory by default; a user
# LaunchAgent runs with your normal file access and survives reboots. On
# Linux it installs idempotent, marker-tagged crontab lines instead.
#
# Installs TWO independent jobs (both, on every install — the staleness
# canary is only useful if it can outlive the sync job silently breaking):
#   1. mongo_sync.sh itself, on --every-minutes/--every-hours (default hourly,
#      same cadence mongo_mirror.sh already defaults to).
#   2. mongo_sync_staleness.sh, on the SAME cadence — lightweight (no docker,
#      no network required to detect staleness), so it keeps alerting even
#      while the sync job itself is failing every run (mongo down, docker not
#      running, disk full, etc).
#
#   ./scripts/setup_mongo_sync_schedule.sh                    # install: HOURLY (both jobs)
#   ./scripts/setup_mongo_sync_schedule.sh --every-minutes 30 # custom (minutes)
#   ./scripts/setup_mongo_sync_schedule.sh --every-hours 3    # custom (hours)
#   ./scripts/setup_mongo_sync_schedule.sh --status           # installed? last run/check?
#   ./scripts/setup_mongo_sync_schedule.sh --uninstall        # remove both
#
# Also reachable as `mongo_sync.sh schedule install|status|uninstall` (CLI:
# `myai sync schedule`) — mongo_sync.sh forwards here, same passthrough shape
# mongo_mirror.sh already uses for --install-schedule/--schedule-status.
#
# NEVER installed automatically (documentation/MONGO_MIRROR.md: a machine
# must not grow a surprise job) — the operator runs this once, explicitly.
# Install is idempotent: re-running rewrites both jobs in place with the new
# cadence. bash 3.2-safe.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SYNC="$SCRIPT_DIR/mongo_sync.sh"
STALENESS="$SCRIPT_DIR/mongo_sync_staleness.sh"
MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
LOG_DIR="$MYAI_HOME/logs"
SYNC_LAST_RUN_FILE="${MONGO_SYNC_LOG:-}"
[ -n "$SYNC_LAST_RUN_FILE" ] || SYNC_LAST_RUN_FILE="$(cd "$SCRIPT_DIR/.." && pwd)/state/.mongo_sync_last"
STALENESS_STATE_FILE="${MONGO_SYNC_STALENESS_STATE:-$MYAI_HOME/mongo-sync-staleness.state}"

SYNC_LABEL="com.myai.mongo-sync"
SYNC_PLIST="$HOME/Library/LaunchAgents/$SYNC_LABEL.plist"
SYNC_CRON_TAG="# myai-mongo-sync"

STALE_LABEL="com.myai.mongo-sync-staleness"
STALE_PLIST="$HOME/Library/LaunchAgents/$STALE_LABEL.plist"
STALE_CRON_TAG="# myai-mongo-sync-staleness"

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
    if [ -f "$SYNC_LAST_RUN_FILE" ]; then
        echo "Last sync ($SYNC_LAST_RUN_FILE):"
        sed 's/^/  /' "$SYNC_LAST_RUN_FILE"
    else
        echo "No sync run recorded yet ($SYNC_LAST_RUN_FILE missing)."
    fi
    if [ -f "$STALENESS_STATE_FILE" ]; then
        echo "Last staleness check ($STALENESS_STATE_FILE):"
        sed 's/^/  /' "$STALENESS_STATE_FILE"
    else
        echo "No staleness check recorded yet ($STALENESS_STATE_FILE missing)."
    fi
    echo "Logs: $LOG_DIR/mongo-sync.{out,err}  ·  $LOG_DIR/mongo-sync-staleness.{out,err}"
}

# ── Linux: idempotent, marker-tagged crontab lines ─────────────────────────
# Tags let install replace ONLY our lines (preserving the rest of the
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
    local sync_line="$expr /bin/bash $SYNC >> $LOG_DIR/mongo-sync.out 2>> $LOG_DIR/mongo-sync.err $SYNC_CRON_TAG"
    local stale_line="$expr /bin/bash $STALENESS >> $LOG_DIR/mongo-sync-staleness.out 2>> $LOG_DIR/mongo-sync-staleness.err $STALE_CRON_TAG"
    { crontab -l 2>/dev/null | grep -vF "$SYNC_CRON_TAG" | grep -vF "$STALE_CRON_TAG" || true; echo "$sync_line"; echo "$stale_line"; } | crontab -
    echo "Installed cron mongo_sync + staleness jobs — fires every ${EVERY_MINUTES}m."
    echo "  $sync_line"
    echo "  $stale_line"
}

linux_uninstall() {
    command -v crontab >/dev/null 2>&1 || { echo "crontab not found — nothing to remove."; exit 0; }
    { crontab -l 2>/dev/null | grep -vF "$SYNC_CRON_TAG" | grep -vF "$STALE_CRON_TAG" || true; } | crontab -
    echo "Removed the myai-mongo-sync + myai-mongo-sync-staleness cron lines (other crontab entries untouched)."
}

linux_status() {
    local sync_line stale_line
    sync_line="$(crontab -l 2>/dev/null | grep -F "$SYNC_CRON_TAG" || true)"
    stale_line="$(crontab -l 2>/dev/null | grep -F "$STALE_CRON_TAG" || true)"
    if [ -n "$sync_line" ]; then
        echo "INSTALLED (cron, sync):"
        printf '  %s\n' "$sync_line"
    else
        echo "NOT installed (sync)."
    fi
    if [ -n "$stale_line" ]; then
        echo "INSTALLED (cron, staleness):"
        printf '  %s\n' "$stale_line"
    else
        echo "NOT installed (staleness)."
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
    echo "Windows detected — schedule mongo_sync from WSL2 (cron) instead; see documentation/MONGO_MIRROR.md." >&2
    exit 1
    ;;
esac

# ── macOS: user LaunchAgents (same pattern as the CLI runner / mirror) ────
write_plist() {
    local label="$1" plist="$2" program="$3" out="$4" err="$5" interval="$6"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$plist" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$program</string>
    </array>
    <key>StartInterval</key><integer>$interval</integer>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>$out</string>
    <key>StandardErrorPath</key><string>$err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
PLIST_EOF
    echo "</plist>" >> "$plist"
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load "$plist"
}

case "$ACTION" in
status)
    if launchctl list "$SYNC_LABEL" >/dev/null 2>&1; then
        echo "INSTALLED: $SYNC_LABEL"
        launchctl list "$SYNC_LABEL" | grep -E '"(PID|LastExitStatus)"' || true
    else
        echo "NOT installed: $SYNC_LABEL"
    fi
    if launchctl list "$STALE_LABEL" >/dev/null 2>&1; then
        echo "INSTALLED: $STALE_LABEL"
        launchctl list "$STALE_LABEL" | grep -E '"(PID|LastExitStatus)"' || true
    else
        echo "NOT installed: $STALE_LABEL"
    fi
    show_last_run
    exit 0
    ;;
uninstall)
    launchctl unload "$SYNC_PLIST" 2>/dev/null || true
    rm -f "$SYNC_PLIST"
    launchctl unload "$STALE_PLIST" 2>/dev/null || true
    rm -f "$STALE_PLIST"
    echo "Uninstalled $SYNC_LABEL and $STALE_LABEL."
    exit 0
    ;;
esac

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
INTERVAL=$(( EVERY_MINUTES * 60 ))

write_plist "$SYNC_LABEL" "$SYNC_PLIST" "$SYNC" \
    "$LOG_DIR/mongo-sync.out" "$LOG_DIR/mongo-sync.err" "$INTERVAL"
write_plist "$STALE_LABEL" "$STALE_PLIST" "$STALENESS" \
    "$LOG_DIR/mongo-sync-staleness.out" "$LOG_DIR/mongo-sync-staleness.err" "$INTERVAL"

echo "Installed $SYNC_LABEL + $STALE_LABEL — both fire every ${EVERY_MINUTES}m."
echo "Watch: tail -f $LOG_DIR/mongo-sync.out $LOG_DIR/mongo-sync-staleness.out"
echo "Status: mongo_sync.sh schedule status"
