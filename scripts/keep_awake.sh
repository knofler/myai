#!/usr/bin/env bash
# keep_awake.sh — hold a strong power assertion for the life of the fleet's
# remote sessions, so a closed lid / idle machine does not kill them.
#
# WHY: remote-control sessions are live websockets to claude.ai. When the Mac
# sleeps, every TCP connection drops and the remote link dies even though the
# process is only suspended. Two separate things cause that sleep:
#
#   1. IDLE sleep      — this script fixes it (caffeinate -dimsu holds
#                        PreventSystemSleep + PreventUserIdleSystemSleep).
#   2. LID CLOSE       — clamshell sleep is a DIFFERENT path. caffeinate does
#                        NOT beat it. It needs, once, as root:
#                            sudo pmset -a disablesleep 1     # revert: 0
#                        or clamshell proper: AC power + external display.
#
# Idempotent: a second run detects the existing assertion and exits 0.
set -uo pipefail

MARKER="caffeinate -dimsu"

if pgrep -f "$MARKER" >/dev/null 2>&1; then
  echo "keep-awake: already holding a sleep assertion"
else
  nohup caffeinate -dimsu >/dev/null 2>&1 &
  disown 2>/dev/null || true
  echo "keep-awake: holding PreventSystemSleep (caffeinate -dimsu)"
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
