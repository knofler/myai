#!/usr/bin/env bash
# setup_offsite_restore_drill_schedule.sh — install/remove the scheduled job
# that runs scripts/offsite_restore_drill.sh (ADR-038: prove the offsite
# objects are actually restorable). Mirrors the other setup_*_schedule.sh
# launchd (macOS) / crontab (Linux) pattern exactly, same TCC rationale.
#
#   ./scripts/setup_offsite_restore_drill_schedule.sh                 # install: WEEKLY (7 days)
#   ./scripts/setup_offsite_restore_drill_schedule.sh --every-days 14 # custom cadence (7/14/28 on Linux cron)
#   ./scripts/setup_offsite_restore_drill_schedule.sh --status        # installed? last drill result?
#   ./scripts/setup_offsite_restore_drill_schedule.sh --uninstall     # remove
#
# Operator action ONLY — never installed automatically. Safe to install before
# any bucket exists: the drill is inert (exit 0) until OFFSITE_S3_BUCKET is
# configured, and SKIPs (exit 0) while the bucket is still empty. Install is
# idempotent: re-running rewrites the job in place.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
DRILL="$SCRIPT_DIR/offsite_restore_drill.sh"
MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
LOG_DIR="$MYAI_HOME/logs"
LAST_RUN_FILE="${OFFSITE_RESTORE_DRILL_LAST:-$MYAI_HOME/offsite-restore-drill.last}"

LABEL="com.myai.offsite-restore-drill"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CRON_TAG="# myai-offsite-restore-drill"

EVERY_DAYS=7
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
        echo "No offsite restore drill recorded yet ($LAST_RUN_FILE missing)."
    fi
    echo "Logs: $LOG_DIR/offsite-restore-drill.out / offsite-restore-drill.err"
}

# ── Linux: idempotent, marker-tagged crontab line ─────────────────────────────
# Cron has no native N-day interval: 7 maps to a real weekly line (Monday),
# anything else must be a divisor of 28 and fires on day-of-month steps — the
# closest cron gets to an even N-day cadence without drifting.
cron_schedule_expr() {
    local d="$1"
    if [ "$d" -eq 7 ]; then printf '45 3 * * 1';
    elif [ "$d" -le 28 ] && [ $(( 28 % d )) -eq 0 ]; then printf '45 3 */%s * *' "$d";
    else
        echo "ERROR: cron can't express a ${d}-day interval cleanly — use 7, 14, or 28" >&2
        return 1
    fi
}

linux_install() {
    command -v crontab >/dev/null 2>&1 || { echo "ERROR: crontab not found — install cron" >&2; exit 1; }
    local expr; expr="$(cron_schedule_expr "$EVERY_DAYS")"
    mkdir -p "$LOG_DIR"
    local line="$expr /bin/bash $DRILL >> $LOG_DIR/offsite-restore-drill.out 2>> $LOG_DIR/offsite-restore-drill.err $CRON_TAG"
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; echo "$line"; } | crontab -
    echo "Installed cron offsite-restore-drill job — fires every ${EVERY_DAYS}d."
    echo "  $line"
}

linux_uninstall() {
    command -v crontab >/dev/null 2>&1 || { echo "crontab not found — nothing to remove."; exit 0; }
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; } | crontab -
    echo "Removed the myai-offsite-restore-drill cron line (other crontab entries untouched)."
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
    echo "Windows detected — schedule the drill from WSL2 (cron) instead; see architecture/ADR-038-offsite-brain-config-backup.md." >&2
    exit 1
    ;;
esac

# ── macOS: user LaunchAgent (same pattern as the other schedules) ─────────────
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
    <key>StandardOutPath</key><string>$LOG_DIR/offsite-restore-drill.out</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/offsite-restore-drill.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
PLIST_EOF
echo "</plist>" >> "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Installed $LABEL — drills the newest offsite object every ${EVERY_DAYS}d."
echo "(Inert no-op until OFFSITE_S3_BUCKET is configured — see scripts/lib/offsite.sh.)"
echo "Watch: tail -f $LOG_DIR/offsite-restore-drill.out   ·   status: $0 --status"
