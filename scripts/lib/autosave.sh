#!/usr/bin/env bash
# scripts/lib/autosave.sh — pure staleness math for the auto-save enforcement hooks.
#
# Mechanical enforcement of AI_RULES §15 (checkpoint-as-you-go). The decision
# logic lives here as a side-effect-free function so it can be exercised by
# hermetic unit tests (scripts/tests/test_autosave.sh) with no filesystem, git,
# or clock dependency. The hooks (post-tool/06, stop/04) source this file and
# feed it values they read from disk.
#
# bash 3.2 safe: integer arithmetic only, no arrays, no bashisms beyond [ ].

# autosave_verdict NOW HANDOFF_MTIME WEIGHTED_SINCE LAST_WARNED_EPOCH \
#                  STALE_SECONDS MIN_WEIGHTED THROTTLE_SECONDS
#
# Echoes exactly one verdict token:
#   OK             — handoff is current enough (not stale, OR not enough work since)
#   OVERDUE_SILENT — overdue, but the throttle window has not elapsed → stay quiet
#   OVERDUE_EMIT   — overdue AND throttle elapsed → emit the CHECKPOINT-OVERDUE box
#
# "Overdue" == handoff mtime older than STALE_SECONDS *AND* at least MIN_WEIGHTED
# weighted tool calls accrued since the last handoff write. Both conditions must
# hold: an old handoff on an idle session is not overdue (nothing to lose), and a
# burst of work right after a fresh handoff is not overdue (just saved).
autosave_verdict() {
  now="${1:-0}"; hmtime="${2:-0}"; wsince="${3:-0}"; lastwarn="${4:-0}"
  stale="${5:-1800}"; minw="${6:-40}"; throttle="${7:-300}"

  # Non-numeric guards → treat as safe (OK) rather than misfire.
  case "$now$hmtime$wsince$lastwarn$stale$minw$throttle" in
    *[!0-9]*) echo "OK"; return 0 ;;
  esac

  age=$(( now - hmtime ))

  if [ "$age" -lt "$stale" ] || [ "$wsince" -lt "$minw" ]; then
    echo "OK"; return 0
  fi

  since_warn=$(( now - lastwarn ))
  if [ "$since_warn" -ge "$throttle" ]; then
    echo "OVERDUE_EMIT"
  else
    echo "OVERDUE_SILENT"
  fi
  return 0
}

# autosave_stop_stale NOW HANDOFF_MTIME STALE_SECONDS  → echoes STALE | FRESH
# Session-close check: staleness alone (the caller layers a dirty-tree gate on
# top so a truly idle session stays quiet).
autosave_stop_stale() {
  now="${1:-0}"; hmtime="${2:-0}"; stale="${3:-1800}"
  case "$now$hmtime$stale" in
    *[!0-9]*) echo "FRESH"; return 0 ;;
  esac
  if [ "$(( now - hmtime ))" -ge "$stale" ]; then echo "STALE"; else echo "FRESH"; fi
  return 0
}
