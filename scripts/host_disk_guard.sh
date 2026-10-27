#!/usr/bin/env bash
# host_disk_guard.sh — keep THIS Mac's disk from silently filling up.
#
# INCIDENT 2026-10-18 (office-mac): the Data volume hit 99% (878 of 926 GB) while
# every file on it — even `sudo du` — added up to only ~234 GB. The missing
# ~600 GB was a DELETED file still held open: an orphaned iOS-Simulator
# `SimRenderServer` (parent launchd, up 16 days, no Simulator running) kept
# writing a screen recording to /private/tmp/<uuid>.mp4.sb-… — 592 GB. A deleted
# file's space only comes back when the holding process exits, so nothing that
# looks at files can see it. `lsof +L1` can. Killing the helper freed 592 GB.
#
# What it does (silent when healthy; safe to run every session):
#   1. DELETED-BUT-OPEN files ≥ HOST_DISK_HELD_GB (default 5):
#        • holder in HOST_DISK_AUTOKILL (default "SimRenderServer") AND orphaned
#          (parent pid 1) AND its app not running (no "Simulator") → killed,
#          space reclaimed, reported;
#        • any other holder → NEVER killed: reported with pid, command, size,
#          path and the exact command that frees it.
#   2. Free space < HOST_DISK_WARN_FREE_GB (default 50): Docker build cache +
#      dangling images pruned; < HOST_DISK_CRIT_FREE_GB (default 20): unused
#      images too. Docker VOLUMES are never touched (they hold Mongo data). Only
#      when the daemon answers within 5 s (a hung Docker never blocks this).
#   3. Still under the warn line → loud report + macOS notification.
# Log: ~/.myai/logs/host-disk-guard.log. Always exits 0 (a guard never fails a
# session or the boot). Wired into scripts/machine_selfheal.sh (every session
# start + the daily 08:00 boot). RUNBOOK mode "Host disk full, du finds nothing".
#
# Usage: host_disk_guard.sh [--check]   (--check: report only — kill/prune nothing)
# Tests: scripts/tests/test_host_disk_guard.sh (HOST_DISK_GUARD_LIB_ONLY=1).
set -u

HDG_HELD_GB="${HOST_DISK_HELD_GB:-5}"
HDG_WARN_GB="${HOST_DISK_WARN_FREE_GB:-50}"
HDG_CRIT_GB="${HOST_DISK_CRIT_FREE_GB:-20}"
HDG_AUTOKILL="${HOST_DISK_AUTOKILL:-SimRenderServer}"
HDG_LOG="${HOST_DISK_GUARD_LOG:-${MYAI_HOME:-$HOME/.myai}/logs/host-disk-guard.log}"
HDG_CHECK_ONLY=0

# ── touchpoints (overridable in tests) ───────────────────────────────────────
_hdg_volume()    { if [ -d /System/Volumes/Data ]; then echo /System/Volumes/Data; else echo /; fi; }
_hdg_free_kb()   { df -k "$(_hdg_volume)" 2>/dev/null | awk 'NR==2 { print $4 }'; }
_hdg_lsof()      { lsof +L1 2>/dev/null; }
_hdg_ppid()      { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; }
# Full executable name: lsof truncates COMMAND to 9 chars ("SimRender"), which
# never matched the allow-list entry "SimRenderServer" (caught by the test).
_hdg_comm()      { basename "$(ps -o comm= -p "$1" 2>/dev/null)" 2>/dev/null; }
_hdg_app_running() { pgrep -x "$1" >/dev/null 2>&1; }
_hdg_kill()      { kill "$1" 2>/dev/null; sleep 2; kill -0 "$1" 2>/dev/null && kill -9 "$1" 2>/dev/null; return 0; }
_hdg_notify()    { command -v osascript >/dev/null 2>&1 && osascript -e "display notification \"$1\" with title \"myAI — disk\"" >/dev/null 2>&1; return 0; }
_hdg_docker_ok() {
  command -v docker >/dev/null 2>&1 || return 1
  ( docker info >/dev/null 2>&1 ) & local p=$! i=0
  while kill -0 "$p" 2>/dev/null; do i=$((i + 1)); [ "$i" -ge 10 ] && { kill -9 "$p" 2>/dev/null; return 1; }; sleep 0.5; done
  wait "$p"
}
_hdg_docker()    { docker "$@" 2>&1 | tail -1; }

_hdg_log() { mkdir -p "$(dirname "$HDG_LOG")" 2>/dev/null; printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$HDG_LOG" 2>/dev/null; return 0; }
_hdg_gb()  { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1073741824 }'; }
_hdg_free_gb() { local kb; kb="$(_hdg_free_kb)"; case "$kb" in ''|*[!0-9]*) echo "" ;; *) awk -v k="$kb" 'BEGIN { printf "%.0f", k / 1048576 }' ;; esac; }

# held_files → "pid<TAB>bytes<TAB>command<TAB>path" for every deleted-but-open
# regular file at or above the threshold (lsof +L1: link count 0 = deleted).
hdg_held_files() {
  local min; min="$(awk -v g="$HDG_HELD_GB" 'BEGIN { printf "%.0f", g * 1073741824 }')"
  _hdg_lsof | awk -v min="$min" 'NR > 1 && $7 ~ /^[0-9]+$/ && $7 + 0 >= min + 0 {
      path = ""; for (i = 10; i <= NF; i++) path = path (i > 10 ? " " : "") $i
      print $2 "\t" $7 "\t" $1 "\t" path }' | sort -t "$(printf '\t')" -k1,1 -u
}

# _hdg_autokill_ok <command> <pid> → 0 when this holder may be killed unasked.
_hdg_autokill_ok() {
  local cmd pid="$2" allowed=0 a
  cmd="$(_hdg_comm "$pid")"; [ -n "$cmd" ] || cmd="$1"
  for a in $HDG_AUTOKILL; do [ "$cmd" = "$a" ] && allowed=1; done
  [ "$allowed" = 1 ] || return 1
  [ "$(_hdg_ppid "$pid")" = 1 ] || return 1          # orphaned only
  case "$cmd" in SimRender*) _hdg_app_running Simulator && return 1 ;; esac
  return 0
}

hdg_main() {
  local free before pid bytes cmd path acted="" warned=""
  [ "${1:-}" = --check ] && HDG_CHECK_ONLY=1
  before="$(_hdg_free_gb)"

  # 1. deleted-but-open files
  while IFS="$(printf '\t')" read -r pid bytes cmd path; do
    [ -n "$pid" ] || continue
    if [ "$HDG_CHECK_ONLY" = 0 ] && _hdg_autokill_ok "$cmd" "$pid"; then
      _hdg_kill "$pid"
      acted="$acted$(printf '\n  reclaimed %s GB — ended orphaned %s (pid %s) holding deleted %s' "$(_hdg_gb "$bytes")" "$cmd" "$pid" "$path")"
      _hdg_log "killed orphan $cmd pid=$pid held=$(_hdg_gb "$bytes")GB path=$path"
    else
      warned="$warned$(printf '\n  ⚠ %s (pid %s) holds a DELETED %s GB file: %s\n    the space returns only when it exits — quit it, or: kill %s' "$cmd" "$pid" "$(_hdg_gb "$bytes")" "$path" "$pid")"
      _hdg_log "held $cmd pid=$pid held=$(_hdg_gb "$bytes")GB path=$path (reported, not killed)"
    fi
  done <<EOF
$(hdg_held_files)
EOF

  # 2. low free space → Docker caches (never volumes)
  free="$(_hdg_free_gb)"
  if [ -n "$free" ] && [ "$free" -lt "$HDG_WARN_GB" ] && [ "$HDG_CHECK_ONLY" = 0 ] && _hdg_docker_ok; then
    acted="$acted$(printf '\n  docker build cache pruned: %s' "$(_hdg_docker builder prune -af)")"
    acted="$acted$(printf '\n  docker dangling images pruned: %s' "$(_hdg_docker image prune -f)")"
    if [ "$free" -lt "$HDG_CRIT_GB" ]; then
      acted="$acted$(printf '\n  docker unused images pruned (critical): %s' "$(_hdg_docker image prune -af)")"
    fi
    _hdg_log "low disk ${free}GB free → docker prune"
    free="$(_hdg_free_gb)"
  fi

  # 3. report
  if [ -n "$acted" ]; then
    printf 'host-disk-guard: %s GB → %s GB free%s\n' "${before:-?}" "${free:-?}" "$acted"
    _hdg_notify "Freed disk space: now ${free:-?} GB free"
  fi
  [ -n "$warned" ] && printf 'host-disk-guard: deleted files still hold disk space%s\n' "$warned"
  if [ -n "$free" ] && [ "$free" -lt "$HDG_WARN_GB" ]; then
    printf 'host-disk-guard: 🔴 only %s GB free on %s (warn < %s GB) — see documentation/RUNBOOK.md "Host disk full, du finds nothing"\n' "$free" "$(_hdg_volume)" "$HDG_WARN_GB"
    _hdg_notify "Only ${free} GB free — check the disk"
  fi
  return 0
}

if [ "${HOST_DISK_GUARD_LIB_ONLY:-0}" != 1 ]; then
  hdg_main "$@"
  exit 0
fi
