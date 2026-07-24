#!/usr/bin/env bash
# setup_cli_runner_linux.sh — install/remove the Linux schedule that fires
# cli_task_runner.sh on this machine. Prefers a systemd USER timer (survives
# reboots, per-user, journald-visible); falls back to a crontab entry when
# systemd's user manager isn't available (WSL1, some containers/VPS images,
# non-systemd distros). Same 10-minute cadence + slot/backoff semantics as the
# macOS launchd installer — the slot/backoff logic lives in cli_task_runner.sh
# itself, so both platforms share it; the installer only controls the cadence.
#
#   ./scripts/setup_cli_runner_linux.sh                    # install: every 10 MINUTES
#   ./scripts/setup_cli_runner_linux.sh --every-minutes 5  # custom (minutes)
#   ./scripts/setup_cli_runner_linux.sh --every-hours 3    # custom (hours, legacy)
#   ./scripts/setup_cli_runner_linux.sh --in-minutes 5     # ALSO arm a one-shot test fire in N minutes
#   ./scripts/setup_cli_runner_linux.sh --systemd          # force the systemd path (error if unavailable)
#   ./scripts/setup_cli_runner_linux.sh --cron             # force the cron path
#   ./scripts/setup_cli_runner_linux.sh --status           # show timer/cron + last log
#   ./scripts/setup_cli_runner_linux.sh --uninstall        # remove (both paths cleaned)
#
# Interval rationale (user directive 2026-06-15): fire every 10 MINUTES. The
# runner is slot-based (MAX_CONCURRENT, default 5) — each fire claims a slot and
# works one distinct task; when full it backs off 30m. Off-hours guard still
# confines autonomous runs to weekday 6pm–9am + weekends.
#
# NOTE for headless boxes: a systemd USER timer only runs while your user
# manager is up. On a VPS you never log into, enable lingering once:
#   loginctl enable-linger $USER
# The installer prints this reminder when lingering is off.
set -euo pipefail

UNIT="myai-cli-runner"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CRON_MARKER="# myai-cli-runner (managed by setup_cli_runner_linux.sh — do not edit)"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
RUNNER="$SCRIPT_DIR/cli_task_runner.sh"
LOG_DIR="$HOME/.ai-cli-runner"
EVERY_MINUTES=10
EVERY_HOURS=""
ACTION=install
TEST_MINUTES=""
BACKEND=auto   # auto | systemd | cron

while [ $# -gt 0 ]; do
    case "$1" in
        --every-minutes) shift; EVERY_MINUTES="${1:?--every-minutes needs a value}"; EVERY_HOURS="" ;;
        --every-hours) shift; EVERY_HOURS="${1:?--every-hours needs a value}" ;;
        --in-minutes)  shift; TEST_MINUTES="${1:?--in-minutes needs a value}" ;;
        --systemd)     BACKEND=systemd ;;
        --cron)        BACKEND=cron ;;
        --status)      ACTION=status ;;
        --uninstall)   ACTION=uninstall ;;
        -h|--help)     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
    esac
    shift
done

if [ "$(uname -s)" = "Darwin" ]; then
    echo "ERROR: this is the Linux installer — on macOS use scripts/setup_cli_runner_schedule.sh (launchd)." >&2
    exit 1
fi

# systemd user manager reachable? (systemctl may exist but the user bus may not,
# e.g. WSL1, minimal containers, or ssh sessions without a user session scope)
have_systemd() {
    command -v systemctl >/dev/null 2>&1 || return 1
    systemctl --user show-environment >/dev/null 2>&1
}

resolve_backend() {
    case "$BACKEND" in
        systemd)
            have_systemd || { echo "ERROR: --systemd requested but the systemd user manager is unreachable (try: loginctl enable-linger $USER, or use --cron)." >&2; exit 1; } ;;
        cron)
            command -v crontab >/dev/null 2>&1 || { echo "ERROR: --cron requested but no crontab binary found." >&2; exit 1; } ;;
        auto)
            if have_systemd; then BACKEND=systemd
            elif command -v crontab >/dev/null 2>&1; then
                BACKEND=cron
                echo "systemd user manager unreachable — falling back to cron."
            else
                echo "ERROR: neither the systemd user manager nor crontab is available on this host." >&2
                exit 1
            fi ;;
    esac
}

cron_lines_without_ours() { crontab -l 2>/dev/null | grep -vF "$CRON_MARKER" || true; }

case "$ACTION" in
status)
    installed=0
    if command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files "$UNIT.timer" 2>/dev/null | grep -q "$UNIT.timer"; then
        installed=1
        echo "INSTALLED (systemd user timer): $UNIT.timer"
        systemctl --user is-active "$UNIT.timer" 2>/dev/null | sed 's/^/  state: /' || true
        systemctl --user list-timers "$UNIT.timer" --no-pager 2>/dev/null | sed -n '2p' | sed 's/^/  /' || true
        if command -v loginctl >/dev/null 2>&1 && ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
            echo "  NOTE: lingering is OFF — the timer stops when you log out. Fix: loginctl enable-linger $USER"
        fi
    fi
    if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF "$CRON_MARKER"; then
        installed=1
        echo "INSTALLED (crontab):"
        crontab -l 2>/dev/null | grep -F "$CRON_MARKER" | sed 's/^/  /'
    fi
    [ "$installed" -eq 0 ] && echo "NOT installed."
    last_log=$(ls -t "$LOG_DIR/logs" 2>/dev/null | head -1 || true)
    [ -n "$last_log" ] && echo "Last session log: $LOG_DIR/logs/$last_log"
    echo "Runner stdout: $LOG_DIR/runner.out"
    exit 0
    ;;
uninstall)
    removed=0
    if command -v systemctl >/dev/null 2>&1; then
        if systemctl --user list-unit-files "$UNIT.timer" 2>/dev/null | grep -q "$UNIT.timer"; then
            systemctl --user disable --now "$UNIT.timer" 2>/dev/null || true
            removed=1
        fi
    fi
    if [ -f "$UNIT_DIR/$UNIT.timer" ] || [ -f "$UNIT_DIR/$UNIT.service" ]; then
        rm -f "$UNIT_DIR/$UNIT.timer" "$UNIT_DIR/$UNIT.service"
        command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload 2>/dev/null || true
        removed=1
    fi
    if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF "$CRON_MARKER"; then
        # capture BEFORE piping to `crontab -` — reading and replacing the tab
        # in one pipeline races (the replace can truncate before the read)
        remaining=$(cron_lines_without_ours)
        printf '%s\n' "$remaining" | crontab -
        removed=1
    fi
    if [ "$removed" -eq 1 ]; then echo "Uninstalled $UNIT."; else echo "Nothing to uninstall."; fi
    exit 0
    ;;
esac

# ── install ───────────────────────────────────────────────────────────────────
resolve_backend
mkdir -p "$LOG_DIR"
if [ -n "$EVERY_HOURS" ]; then
    MINUTES=$(( EVERY_HOURS * 60 )); CADENCE="every ${EVERY_HOURS}h"
else
    MINUTES=$EVERY_MINUTES; CADENCE="every ${EVERY_MINUTES}m"
fi
RUN_PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [ "$BACKEND" = "systemd" ]; then
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/$UNIT.service" <<UNIT_EOF
[Unit]
Description=myAI CLI task runner — claim one slot, work one queued task

[Service]
Type=oneshot
ExecStart=/bin/bash $RUNNER
Environment=PATH=$RUN_PATH
Environment=CLAUDE_CONFIG_DIR=%h/.claude-tech
StandardOutput=append:$LOG_DIR/runner.out
StandardError=append:$LOG_DIR/runner.err
UNIT_EOF
    cat > "$UNIT_DIR/$UNIT.timer" <<TIMER_EOF
[Unit]
Description=Fire $UNIT $CADENCE (slot-based; runner backs off 30m when all slots busy)

[Timer]
OnBootSec=2min
OnUnitActiveSec=${MINUTES}min
AccuracySec=1min
Persistent=false

[Install]
WantedBy=timers.target
TIMER_EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT.timer"
    echo "Installed $UNIT.timer (systemd user) — fires ${CADENCE} (slot-based, up to ${MAX_CONCURRENT:-5} concurrent; backs off 30m when full)."
    if command -v loginctl >/dev/null 2>&1 && ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
        echo "NOTE: lingering is OFF — the timer stops when you log out. For an always-on box run: loginctl enable-linger $USER"
    fi
    echo "Watch: systemctl --user list-timers $UNIT.timer  ·  tail -f $LOG_DIR/runner.out"
else
    # cron cadence: */N works cleanly for divisors of 60; hour-multiples become
    # an hourly expression; anything else is rejected with guidance.
    if [ "$MINUTES" -lt 60 ]; then
        CRON_EXPR="*/$MINUTES * * * *"
        [ $(( 60 % MINUTES )) -ne 0 ] && echo "WARN: $MINUTES does not divide 60 — cron */$MINUTES gives an uneven gap at the top of each hour."
    elif [ $(( MINUTES % 60 )) -eq 0 ]; then
        CRON_EXPR="0 */$(( MINUTES / 60 )) * * *"
    else
        echo "ERROR: cron can't express ${MINUTES}m cleanly — pick a divisor of 60, a whole-hour multiple, or use --systemd." >&2
        exit 1
    fi
    CRON_LINE="$CRON_EXPR PATH=$RUN_PATH CLAUDE_CONFIG_DIR=\$HOME/.claude-tech /bin/bash $RUNNER >> $LOG_DIR/runner.out 2>> $LOG_DIR/runner.err $CRON_MARKER"
    # capture BEFORE piping to `crontab -` (see uninstall note — same race)
    new_tab=$(cron_lines_without_ours; echo "$CRON_LINE")
    printf '%s\n' "$new_tab" | crontab -
    echo "Installed crontab entry — fires ${CADENCE} (slot-based, up to ${MAX_CONCURRENT:-5} concurrent; backs off 30m when full)."
    echo "Watch: crontab -l  ·  tail -f $LOG_DIR/runner.out"
fi

if [ -n "$TEST_MINUTES" ]; then
    echo "One-shot test fire in ${TEST_MINUTES}m (detached)..."
    if [ "$BACKEND" = "systemd" ]; then
        ( sleep $(( TEST_MINUTES * 60 )); systemctl --user start "$UNIT.service" ) >/dev/null 2>&1 &
    else
        ( sleep $(( TEST_MINUTES * 60 )); /bin/bash "$RUNNER" >> "$LOG_DIR/runner.out" 2>> "$LOG_DIR/runner.err" ) >/dev/null 2>&1 &
    fi
    echo "  armed — PID $!"
fi
