#!/usr/bin/env bash
# myai_runner.sh — `myai runner` subcommand: install / start / stop / status /
# logs the per-machine off-hours CLI runner from the terminal — parity with
# scripts/setup_cli_runner_schedule.sh as a first-class myai verb, plus the
# start/stop/logs verbs that installer never had. Distinct from `myai status` /
# `myai logs` (gateway/stack health) — this manages the local launchd/systemd
# worker that fires cli_task_runner.sh.
#
#   myai runner install [--every-minutes N | --every-hours N] [--in-minutes N]
#                                          # write + enable the schedule (mac: launchd, linux: systemd/cron)
#   myai runner uninstall                 # remove the schedule entirely
#   myai runner start                     # (re)enable an already-installed schedule
#   myai runner stop                      # disable the schedule, keep it installed
#   myai runner status                    # installed? active? next fire? last log
#   myai runner logs [-f|--follow] [-n|--lines N]
#                                          # tail the latest per-task session log
#                                          # (falls back to the runner's own stdout)
#
# install/uninstall/status delegate to setup_cli_runner_schedule.sh (which
# itself routes mac → launchd, linux → setup_cli_runner_linux.sh) so the
# plist/unit-generation logic has exactly one source of truth. start/stop/logs
# are implemented here since the installers never had them. bash 3.2-safe.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
INSTALLER="$SCRIPT_DIR/setup_cli_runner_schedule.sh"
LOG_DIR="$HOME/.ai-cli-runner"

# Same identifiers the installers use — must match exactly so start/stop/status
# operate on the artifacts `install` actually created.
LABEL="com.myai.cli-task-runner"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT="myai-cli-runner"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CRON_MARKER="# myai-cli-runner (managed by setup_cli_runner_linux.sh — do not edit)"

usage() { grep '^#' "$0" | sed 's/^# \{0,1\}//'; }

# Portable mtime-as-epoch (GNU stat -c first, BSD stat -f fallback — see
# scripts/runner_log_rotate.sh for why GNU-first is deliberate).
mtime_epoch() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

latest_job_log() { ls -t "$LOG_DIR/logs" 2>/dev/null | head -1 || true; }

ACTION="${1:-}"
[ $# -gt 0 ] && shift || true

case "$ACTION" in
install)
    exec bash "$INSTALLER" "$@"
    ;;
uninstall)
    exec bash "$INSTALLER" --uninstall
    ;;
status)
    bash "$INSTALLER" --status
    # launchd exposes no next-fire query for a StartInterval job — approximate
    # it from the plist's interval + the last recorded fire. systemd's own
    # --status already prints NEXT/LEFT via `systemctl --user list-timers`.
    if [ "$(uname -s)" = "Darwin" ] && [ -f "$PLIST" ]; then
        interval=$(plutil -extract StartInterval raw "$PLIST" 2>/dev/null || true)
        last_log=$(latest_job_log)
        if [ -n "$last_log" ]; then
            last_epoch=$(mtime_epoch "$LOG_DIR/logs/$last_log")
        else
            last_epoch=$(mtime_epoch "$LOG_DIR/runner.out")
        fi
        if [ -n "$interval" ] && [ "${last_epoch:-0}" -gt 0 ] 2>/dev/null; then
            next_epoch=$(( last_epoch + interval ))
            next_human=$(date -r "$next_epoch" 2>/dev/null || date -d "@$next_epoch" 2>/dev/null || echo "epoch $next_epoch")
            echo "Next fire (approx): $next_human — every ${interval}s from the last fire (launchd has no exact next-fire query for StartInterval jobs)"
        else
            echo "Next fire: unknown — no prior fire recorded yet (first fire lands within ${interval:-600}s of the last load)"
        fi
    fi
    exit 0
    ;;
start)
    case "$(uname -s)" in
    Darwin)
        [ -f "$PLIST" ] || { echo "ERROR: not installed — run 'myai runner install' first." >&2; exit 1; }
        launchctl unload "$PLIST" 2>/dev/null || true
        launchctl load "$PLIST"
        echo "Started $LABEL (loaded)."
        ;;
    Linux)
        if command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files "$UNIT.timer" 2>/dev/null | grep -q "$UNIT.timer"; then
            systemctl --user enable --now "$UNIT.timer"
            echo "Started $UNIT.timer (enabled)."
        elif command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF "$CRON_MARKER"; then
            echo "Cron-backed runner has no start/stop state — it fires on schedule whenever installed. Nothing to do."
        else
            echo "ERROR: not installed — run 'myai runner install' first." >&2
            exit 1
        fi
        ;;
    *)
        echo "ERROR: unsupported OS for 'myai runner start': $(uname -s)" >&2
        exit 1
        ;;
    esac
    ;;
stop)
    case "$(uname -s)" in
    Darwin)
        [ -f "$PLIST" ] || { echo "ERROR: not installed — nothing to stop." >&2; exit 1; }
        launchctl unload "$PLIST" 2>/dev/null || true
        echo "Stopped $LABEL (unloaded — plist kept; 'myai runner start' re-enables, 'myai runner uninstall' removes it)."
        ;;
    Linux)
        if command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files "$UNIT.timer" 2>/dev/null | grep -q "$UNIT.timer"; then
            systemctl --user disable --now "$UNIT.timer"
            echo "Stopped $UNIT.timer (disabled — unit files kept; 'myai runner start' re-enables, 'myai runner uninstall' removes them)."
        elif command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF "$CRON_MARKER"; then
            echo "ERROR: cron-backed runner has no stop state (no enable/disable) — use 'myai runner uninstall' to remove it entirely." >&2
            exit 1
        else
            echo "ERROR: not installed — nothing to stop." >&2
            exit 1
        fi
        ;;
    *)
        echo "ERROR: unsupported OS for 'myai runner stop': $(uname -s)" >&2
        exit 1
        ;;
    esac
    ;;
logs)
    FOLLOW=false
    LINES=100
    while [ $# -gt 0 ]; do
        case "$1" in
            -f|--follow) FOLLOW=true ;;
            -n|--lines)  shift; LINES="${1:?--lines needs a value}" ;;
            -h|--help)   usage; exit 0 ;;
            *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
        esac
        shift
    done
    latest=$(latest_job_log)
    if [ -n "$latest" ]; then
        TARGET="$LOG_DIR/logs/$latest"
    elif [ -f "$LOG_DIR/runner.out" ]; then
        TARGET="$LOG_DIR/runner.out"
    else
        echo "No runner logs yet at $LOG_DIR (install the runner and wait for its first fire)." >&2
        exit 1
    fi
    echo "==> $TARGET"
    if [ "$FOLLOW" = true ]; then
        tail -n "$LINES" -f "$TARGET"
    else
        tail -n "$LINES" "$TARGET"
    fi
    ;;
-h|--help|help|"")
    usage
    exit 0
    ;;
*)
    echo "ERROR: unknown runner action '$ACTION' (expected: install | uninstall | start | stop | status | logs)" >&2
    usage
    exit 1
    ;;
esac
