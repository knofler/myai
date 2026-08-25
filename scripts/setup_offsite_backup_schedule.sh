#!/usr/bin/env bash
# setup_offsite_backup_schedule.sh — install/remove the scheduled job that runs
# scripts/offsite_backup.sh (ADR-038: encrypted brain + config push to
# S3-compatible object storage). Mirrors setup_hosted_brain_backup_schedule.sh's
# launchd (macOS) / crontab (Linux) pattern exactly, same TCC rationale:
# launchd runs with normal file access where plain cron is blocked from the
# home directory on macOS.
#
#   ./scripts/setup_offsite_backup_schedule.sh                    # install: DAILY (24h)
#   ./scripts/setup_offsite_backup_schedule.sh --every-hours 12   # custom cadence
#   ./scripts/setup_offsite_backup_schedule.sh --status           # installed? last run?
#   ./scripts/setup_offsite_backup_schedule.sh --uninstall        # remove
#
# Operator action ONLY — never installed automatically. Safe to install before
# any bucket exists: offsite_backup.sh is inert (exit 0, no-op) until
# OFFSITE_S3_BUCKET is configured. Install is idempotent: re-running rewrites
# the job in place.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BACKUP="$SCRIPT_DIR/offsite_backup.sh"
MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
LOG_DIR="$MYAI_HOME/logs"
LAST_RUN_FILE="$MYAI_HOME/offsite-backup.last"

LABEL="com.myai.offsite-backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CRON_TAG="# myai-offsite-backup"

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

show_last_run() {
    if [ -f "$LAST_RUN_FILE" ]; then
        echo "Last run ($LAST_RUN_FILE):"
        sed 's/^/  /' "$LAST_RUN_FILE"
    else
        echo "No offsite backup run recorded yet ($LAST_RUN_FILE missing)."
    fi
    echo "Logs: $LOG_DIR/offsite-backup.out / offsite-backup.err"
}

# ── Linux: idempotent, marker-tagged crontab line ─────────────────────────────
cron_schedule_expr() {
    local h="$1"
    if [ "$h" -eq 24 ]; then printf '30 3 * * *';
    elif [ "$h" -lt 24 ] && [ $(( 24 % h )) -eq 0 ]; then printf '30 */%s * * *' "$h";
    else
        echo "ERROR: cron can't express a ${h}-hour interval cleanly — use a divisor of 24" >&2
        return 1
    fi
}

linux_install() {
    command -v crontab >/dev/null 2>&1 || { echo "ERROR: crontab not found — install cron" >&2; exit 1; }
    local expr; expr="$(cron_schedule_expr "$EVERY_HOURS")"
    mkdir -p "$LOG_DIR"
    local line="$expr /bin/bash $BACKUP >> $LOG_DIR/offsite-backup.out 2>> $LOG_DIR/offsite-backup.err $CRON_TAG"
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; echo "$line"; } | crontab -
    echo "Installed cron offsite-backup job — fires every ${EVERY_HOURS}h."
    echo "  $line"
}

linux_uninstall() {
    command -v crontab >/dev/null 2>&1 || { echo "crontab not found — nothing to remove."; exit 0; }
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; } | crontab -
    echo "Removed the myai-offsite-backup cron line (other crontab entries untouched)."
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
    echo "Windows detected — schedule the backup from WSL2 (cron) instead; see architecture/ADR-038-offsite-brain-config-backup.md." >&2
    exit 1
    ;;
esac

# ── macOS: user LaunchAgent (same pattern as the hosted-brain schedule) ───────
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
        <string>$BACKUP</string>
    </array>
    <key>StartInterval</key><integer>$INTERVAL</integer>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>$LOG_DIR/offsite-backup.out</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/offsite-backup.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
PLIST_EOF
echo "</plist>" >> "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Installed $LABEL — pushes the encrypted brain + config offsite every ${EVERY_HOURS}h."
echo "(Inert no-op until OFFSITE_S3_BUCKET is configured — see scripts/lib/offsite.sh.)"
echo "Watch: tail -f $LOG_DIR/offsite-backup.out   ·   status: $0 --status"
