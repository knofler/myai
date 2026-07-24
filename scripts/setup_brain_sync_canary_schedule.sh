#!/usr/bin/env bash
# setup_brain_sync_canary_schedule.sh — install/remove the hourly schedule that
# fires brain_sync_canary.sh on this machine, independent of any Claude session.
#
# WHY hourly, independent of `wrap up`: a gateway restart or remote desync mid-
# session can break the brain link long before the session ends — `wrap up`'s
# own brain_sync_verify call would be the first (and only) time anyone finds
# out. This closes that gap with its own clock.
#
# macOS: user LaunchAgent (StartInterval). Linux: systemd user timer, falling
# back to crontab when the user systemd manager is unavailable — same fallback
# order as setup_cli_runner_schedule.sh / setup_cli_runner_linux.sh.
#
#   ./scripts/setup_brain_sync_canary_schedule.sh                  # install: hourly
#   ./scripts/setup_brain_sync_canary_schedule.sh --every-minutes 30  # custom cadence
#   ./scripts/setup_brain_sync_canary_schedule.sh --status         # show install + last result
#   ./scripts/setup_brain_sync_canary_schedule.sh --uninstall      # remove
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CANARY="$SCRIPT_DIR/brain_sync_canary.sh"
LOG_DIR="$HOME/.ai-cli-runner"
EVERY_MINUTES=60
ACTION=install

while [ $# -gt 0 ]; do
    case "$1" in
        --every-minutes) shift; EVERY_MINUTES="${1:?--every-minutes needs a value}" ;;
        --status)        ACTION=status ;;
        --uninstall)     ACTION=uninstall ;;
        -h|--help)       grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
    esac
    shift
done

mkdir -p "$LOG_DIR"

if [ "$(uname -s)" = "Darwin" ]; then
    LABEL="com.myai.brain-sync-canary"
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

    case "$ACTION" in
    status)
        if launchctl list "$LABEL" >/dev/null 2>&1; then
            echo "INSTALLED: $LABEL"
            launchctl list "$LABEL" | grep -E '"(PID|LastExitStatus)"' || true
        else
            echo "NOT installed."
        fi
        "$CANARY" --status
        exit 0
        ;;
    uninstall)
        launchctl unload "$PLIST" 2>/dev/null || true
        rm -f "$PLIST"
        echo "Uninstalled $LABEL."
        exit 0
        ;;
    esac

    INTERVAL=$(( EVERY_MINUTES * 60 ))
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
        <string>$CANARY</string>
    </array>
    <key>StartInterval</key><integer>$INTERVAL</integer>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>$LOG_DIR/brain-canary.out</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/brain-canary.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
PLIST_EOF
    echo "</plist>" >> "$PLIST"

    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "Installed $LABEL — fires every ${EVERY_MINUTES}m."
    echo "Watch: tail -f $LOG_DIR/brain-canary.log"
    exit 0
fi

# ── Linux: systemd user timer, falling back to crontab ──
UNIT="myai-brain-sync-canary"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CRON_MARKER="# myai-brain-sync-canary (managed by setup_brain_sync_canary_schedule.sh — do not edit)"

case "$ACTION" in
status)
    if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active "$UNIT.timer" >/dev/null 2>&1; then
        echo "INSTALLED (systemd user timer): $UNIT.timer"
        systemctl --user status "$UNIT.timer" --no-pager 2>/dev/null | head -5 || true
    elif crontab -l 2>/dev/null | grep -qF "$CRON_MARKER"; then
        echo "INSTALLED (cron):"
        crontab -l 2>/dev/null | grep -F "$CRON_MARKER" -A1 || true
    else
        echo "NOT installed."
    fi
    "$CANARY" --status
    exit 0
    ;;
uninstall)
    systemctl --user stop "$UNIT.timer" 2>/dev/null || true
    systemctl --user disable "$UNIT.timer" 2>/dev/null || true
    rm -f "$UNIT_DIR/$UNIT.service" "$UNIT_DIR/$UNIT.timer"
    systemctl --user daemon-reload 2>/dev/null || true
    if crontab -l 2>/dev/null | grep -qF "$CRON_MARKER"; then
        crontab -l 2>/dev/null | grep -vF "$CRON_MARKER" | grep -vF "$CANARY" | crontab -
    fi
    echo "Uninstalled $UNIT (both paths cleaned)."
    exit 0
    ;;
esac

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/$UNIT.service" <<SERVICE_EOF
[Unit]
Description=myAI brain sync canary

[Service]
Type=oneshot
ExecStart=/bin/bash $CANARY
SERVICE_EOF
    cat > "$UNIT_DIR/$UNIT.timer" <<TIMER_EOF
[Unit]
Description=Run myai-brain-sync-canary every ${EVERY_MINUTES}m

[Timer]
OnUnitActiveSec=${EVERY_MINUTES}min
OnStartupSec=5min
Persistent=true

[Install]
WantedBy=timers.target
TIMER_EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT.timer"
    echo "Installed systemd user timer $UNIT.timer — fires every ${EVERY_MINUTES}m."
    if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
        echo "NOTE: lingering is off — the timer only runs while you're logged in. Enable with: loginctl enable-linger $USER"
    fi
else
    # cron minute field only accepts 0-59 — express whole-hour cadences (the
    # default, 60) as an hour-field step instead of an invalid "*/60" minute.
    if [ $(( EVERY_MINUTES % 60 )) -eq 0 ]; then
        CRON_SCHEDULE="0 */$(( EVERY_MINUTES / 60 )) * * *"
    else
        CRON_SCHEDULE="*/${EVERY_MINUTES} * * * *"
    fi
    ( crontab -l 2>/dev/null | grep -vF "$CRON_MARKER" | grep -vF "$CANARY"
      echo "$CRON_MARKER"
      echo "$CRON_SCHEDULE /bin/bash $CANARY >> $LOG_DIR/brain-canary.cron.log 2>&1"
    ) | crontab -
    echo "Installed crontab entry ($CRON_SCHEDULE) — fires every ${EVERY_MINUTES}m (systemd user manager unavailable)."
fi
