#!/usr/bin/env bash
# keep_awake.sh — hold a power assertion for the life of the fleet's remote
# sessions, so an idle machine does not kill them.
#
# WHY: remote-control sessions are live websockets to claude.ai. When the Mac
# sleeps, every TCP connection drops and the remote link dies even though the
# process is only suspended. Two separate things cause that sleep:
#
#   1. IDLE sleep      — this script fixes it (caffeinate -ims holds
#                        PreventSystemSleep + PreventUserIdleSystemSleep).
#   2. LID CLOSE       — clamshell sleep is a DIFFERENT path. caffeinate does
#                        NOT beat it. It needs, once, as root:
#                            sudo pmset -a disablesleep 1     # revert: 0
#                        or clamshell proper: AC power + external display.
#
# WHAT THIS DELIBERATELY DOES *NOT* HOLD — display sleep (2026-09-12 incident).
# The flags used to be `-dimsu`. `-d` asserts PreventUserIdleDisplaySleep, and
# macOS only starts the screen-lock countdown ("require password after the
# screen saver begins") once the display sleeps or the saver starts. So `-d`
# silently stopped the operator's Mac from EVER locking — it ran orphaned
# (nohup + disown, "asserting forever") for 15h before anyone noticed, because
# nothing ever released it. A dropped websocket needs SYSTEM sleep prevented,
# not display sleep: the screen can go black and lock while every session stays
# up. `-u` (declare the user active) is gone for the same reason — worse, on a
# machine reachable from a phone. What is left is the minimum that keeps the
# sessions alive:
#     -i  prevent idle SYSTEM sleep      -m  prevent disk idle sleep
#     -s  prevent system sleep on AC
# NEVER add -d or -u back. If sessions still die, the cause is lid close (see
# above), not display sleep.
#
# An assertion must not outlive the sessions it exists for: `remote_fleet.sh
# stop` calls `--release` once the last doorway on this machine is gone.
#
# Usage:  keep_awake.sh             hold the assertion (idempotent)
#         keep_awake.sh --release   drop it (and any legacy -dimsu holder)
#         keep_awake.sh --status    report what is held, exit 0 if held
set -uo pipefail

MARKER="caffeinate -ims"
LEGACY="caffeinate -dimsu"   # pre-2026-09-12 holder: also blocked display sleep

holder_pids() { pgrep -f "$1" 2>/dev/null; }

case "${1:-}" in
  --release)
    released=0
    for pat in "$MARKER" "$LEGACY"; do
      pids="$(holder_pids "$pat")"
      [ -n "$pids" ] || continue
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
      released=1
      echo "keep-awake: released ($pat)"
    done
    [ "$released" = 1 ] || echo "keep-awake: nothing held — nothing to release"
    exit 0
    ;;
  --status)
    if [ -n "$(holder_pids "$MARKER")" ]; then
      echo "keep-awake: held ($MARKER)"; exit 0
    fi
    if [ -n "$(holder_pids "$LEGACY")" ]; then
      echo "keep-awake: ⚠ held by the LEGACY $LEGACY — it also blocks DISPLAY sleep, so this Mac will never lock. Clear it: $(basename "$0") --release"
      exit 0
    fi
    echo "keep-awake: not held"; exit 1
    ;;
esac

# Self-heal a machine still carrying the display-blocking legacy holder.
legacy_pids="$(holder_pids "$LEGACY")"
if [ -n "$legacy_pids" ]; then
  # shellcheck disable=SC2086
  kill $legacy_pids 2>/dev/null || true
  echo "keep-awake: cleared legacy '$LEGACY' (it blocked display sleep, so the Mac could never lock)"
fi

if [ -n "$(holder_pids "$MARKER")" ]; then
  echo "keep-awake: already holding a sleep assertion"
else
  nohup caffeinate -ims >/dev/null 2>&1 &
  disown 2>/dev/null || true
  echo "keep-awake: holding PreventSystemSleep ($MARKER) — display sleep and screen lock left alone"
fi

# Report the lid-close gap honestly rather than implying full coverage.
if command -v pmset >/dev/null 2>&1; then
  if pmset -g 2>/dev/null | grep -q "SleepDisabled.*1"; then
    echo "keep-awake: lid-close sleep is disabled — closed-lid sessions will survive"
  else
    echo "keep-awake: ⚠ lid close will STILL sleep this Mac and kill remote sessions."
    echo "keep-awake:   fix once:  sudo pmset -a disablesleep 1   (revert: 0)"
  fi
fi
