#!/usr/bin/env bash
# swarm_master_config.sh — the per-DEVICE swarm master config (operator rule
# 2026-10-22: every device always has EXACTLY ONE swarm master, chosen at
# install, for any agent or profile).
#
# File: ~/.myai/swarm/master.<host> — per host, NEVER shared and never under
# Dropbox (each Mac writes its own; a synced file would make the office Mac's
# answer the home Mac's). Plain key=value lines:
#   agent=claude            claude | agy | codex | cursor | gemini | …
#   profile=/Users/x/.claude-alpha    the agent's config dir (claude) or "" (others)
#   lane=alpha              the session lane this master runs as (session_profile)
#   repo=ai_management      the repo the master's session runs in
#   order=alpha beta …      OPTIONAL coordination order — written only by the
#                           upgrade migration for hosts that already had one
#   setAt=2026-10-22T00:40:00Z
#
# Order (smc_order): $SWARM_ORDER when set; else the configured master's lane,
# then the config's `order=`, then every live session lane in the master repo
# ordered by session start (oldest first). No lane name is hard-coded here.
#
# Functions take no gateway round-trip. bash 3.2-safe; safe under
# `set -euo pipefail`. Stubbable touchpoints: smc_host, _smc_etime,
# _smc_candidates.

# shellcheck disable=SC2034  # SMC_* are read by callers
SMC_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

smc_host() { hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || true; }
smc_dir()  { printf '%s' "${SWARM_DIR:-$HOME/.myai/swarm}"; }
smc_file() { printf '%s/master.%s' "$(smc_dir)" "$(smc_host)"; }

# smc_path_ok <path> → 1 when the path sits under Dropbox (a synced file is
# shared between Macs — exactly what a per-device master must never be).
smc_path_ok() {
  case "$1" in */Dropbox/*|*/Dropbox|*"/Library/CloudStorage/Dropbox"*) return 1 ;; esac
  return 0
}

smc_exists() { [ -s "$(smc_file)" ]; }

# smc_get <key> → value (empty when absent / no config).
smc_get() {
  local f; f="$(smc_file)"
  [ -f "$f" ] || return 0
  sed -n "s/^$1=//p" "$f" 2>/dev/null | head -1
}

# smc_lane_for <agent> <profile-dir> → the session lane that agent+profile runs
# as — the same derivation session_profile uses (~/.claude-<x> → x, bare
# ~/.claude → default; a non-Claude agent's lane is its own name).
smc_lane_for() {
  local agent="$1" prof="${2:-}"
  case "$agent" in
    claude)
      case "$prof" in
        */.claude-*) printf '%s' "${prof##*/.claude-}" | tr '[:upper:]' '[:lower:]' ;;
        *) printf 'default' ;;
      esac ;;
    *) printf '%s' "$agent" | tr '[:upper:]' '[:lower:]' ;;
  esac
}

# smc_write <agent> <profile> <repo> [order] → 0 written; 1 refused (Dropbox
# path / bad agent). Atomic (tmp + mv).
smc_write() {
  local agent="$1" prof="${2:-}" repo="${3:-}" order="${4:-}" f dir tmp lane
  case "$agent" in ''|*[!a-zA-Z0-9_.-]*) echo "swarm master: invalid agent '$agent'" >&2; return 1 ;; esac
  f="$(smc_file)"; dir="$(smc_dir)"
  if ! smc_path_ok "$f"; then
    echo "swarm master: refusing to write $f — it is under Dropbox; the master config is per device (set SWARM_DIR outside Dropbox)" >&2
    return 1
  fi
  mkdir -p "$dir" 2>/dev/null || return 1
  lane="$(smc_lane_for "$agent" "$prof")"
  [ -n "$repo" ] || repo="${SWARM_REPO:-ai_management}"
  tmp="$f.tmp.$$"
  {
    printf 'agent=%s\n' "$agent"
    printf 'profile=%s\n' "$prof"
    printf 'lane=%s\n' "$lane"
    printf 'repo=%s\n' "$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')"
    if [ -n "$order" ]; then printf 'order=%s\n' "$order"; fi
    printf 'setAt=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$tmp" && mv -f "$tmp" "$f"
}

smc_master_lane()  { smc_get lane; }
smc_master_agent() { smc_get agent; }
smc_master_repo()  { local r; r="$(smc_get repo)"; printf '%s' "${r:-${SWARM_REPO:-ai_management}}" | tr '[:upper:]' '[:lower:]'; }

# _smc_candidates → lanes_candidates '*' rows (pid tty cfg cwd lane). Stubbed in tests.
_smc_candidates() {
  command -v lanes_candidates >/dev/null 2>&1 || return 0
  lanes_candidates '*' 2>/dev/null || true
}
# _smc_etime <pid> → seconds since that process started (0 when unknown).
_smc_etime() {
  ps -o etime= -p "$1" 2>/dev/null | awk '{
    n = split($1, a, /[-:]/); s = 0
    if ($1 ~ /-/) { s = a[1] * 86400; i = 2 } else { i = 1 }
    m = n - i + 1
    if (m == 3) s += a[i] * 3600 + a[i+1] * 60 + a[i+2]
    else if (m == 2) s += a[i] * 60 + a[i+1]
    else s += a[i]
    print s }' 2>/dev/null || echo 0
}
_smc_repo_of() {
  if command -v _lanes_repo_of >/dev/null 2>&1; then _lanes_repo_of "$1"; else basename "$1" | tr '[:upper:]' '[:lower:]'; fi
}

# smc_live_lanes_by_start [repo] → live session lanes in <repo> (default the
# master repo), oldest session first, one per line, "default" excluded.
smc_live_lanes_by_start() {
  local repo="${1:-$(smc_master_repo)}" pid _t _c cwd lane
  _smc_candidates | while IFS="$(printf '\t')" read -r pid _t _c cwd lane; do
    [ -n "$lane" ] && [ "$lane" != default ] || continue
    [ "$(_smc_repo_of "$cwd")" = "$repo" ] || continue
    printf '%s\t%s\n' "$(_smc_etime "$pid")" "$lane"
  done | sort -t "$(printf '\t')" -k1,1nr | cut -f2 | awk '!seen[$0]++'
}

# smc_order → the coordination order, space-separated, no duplicates.
smc_order() {
  if [ -n "${SWARM_ORDER:-}" ]; then printf '%s' "$SWARM_ORDER"; return 0; fi
  { smc_master_lane; printf '\n'
    smc_get order | tr ' ' '\n'
    smc_live_lanes_by_start
  } | awk 'NF && !seen[$0]++' | paste -sd' ' - 2>/dev/null || true
}

# smc_detect → one "agent<TAB>profile<TAB>lane" line per agent/profile found on
# this device: every Claude config dir (~/.claude, ~/.claude-*), then each other
# agent CLI on PATH. Order is stable (Claude profiles A→Z, then agents).
smc_detect() {
  local d a home="${SMC_HOME:-$HOME}"
  for d in "$home/.claude" "$home"/.claude-*; do
    [ -d "$d" ] || continue
    case "$d" in *.json|*.sh|*.bak*|*.tmp*) continue ;; esac
    printf 'claude\t%s\t%s\n' "$d" "$(smc_lane_for claude "$d")"
  done
  for a in ${SMC_AGENTS-agy codex cursor-agent gemini qwen}; do
    if command -v "$a" >/dev/null 2>&1 || [ -x "$home/.local/bin/$a" ]; then
      case "$a" in cursor-agent) printf 'cursor\t\tcursor\n' ;; *) printf '%s\t\t%s\n' "$a" "$a" ;; esac
    fi
  done
}

# smc_is_master_session [lane] [repo] → 0 when THIS session (lane =
# session_profile, cwd repo) is the configured master. Runner fires never are.
smc_is_master_session() {
  local lane="${1:-}" repo="${2:-}" want
  [ "${MYAI_RUNNER_FIRE:-0}" = 1 ] && return 1
  want="$(smc_master_lane)"; [ -n "$want" ] || return 1
  if [ -z "$lane" ] && command -v session_profile >/dev/null 2>&1; then lane="$(session_profile)"; fi
  [ "$lane" = "$want" ] || return 1
  if [ -z "$repo" ]; then
    repo="$(_smc_repo_of "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
  fi
  [ "$repo" = "$(smc_master_repo)" ]
}

# smc_swarm_active → 0 while a swarm runs on this host (the active marker
# ~/.myai/swarm/active.<host>, written by `swarm master take`).
smc_swarm_active() { [ -f "$(smc_dir)/active.$(smc_host)" ]; }

# smc_master_address → "<host>/<lane><TAB><agent>" of this host's master: the
# configured one, else the recorded coordinator (agent unknown → "session").
# rc 1 when neither exists.
smc_master_address() {
  local lane cf holder
  lane="$(smc_master_lane)"
  if [ -n "$lane" ]; then
    printf '%s/%s\t%s\n' "$(smc_host)" "$lane" "$(smc_master_agent)"
    return 0
  fi
  cf="$(smc_dir)/coordinator.$(smc_host).current"
  holder="$(head -1 "$cf" 2>/dev/null || true)"
  lane="$(printf '%s' "$holder" | cut -d/ -f2)"
  [ -n "$lane" ] || return 1
  printf '%s/%s\tsession\n' "$(smc_host)" "$lane"
}

# smc_worker_reminder → the WORKER rule text (operator rule 2026-10-22, brain
# atom 9e22a437: workers never task the operator) on stdout; rc 1 when it does
# not apply: no active swarm, a runner fire, or THIS session is the master
# (the configured one, or with no config the recorded coordinator).
smc_worker_reminder() {
  local addr master agent
  [ "${MYAI_RUNNER_FIRE:-0}" = 1 ] && return 1
  smc_swarm_active || return 1
  if smc_exists; then
    smc_is_master_session && return 1
  elif command -v session_is_coordinator >/dev/null 2>&1 && session_is_coordinator; then
    return 1
  fi
  if addr="$(smc_master_address)"; then
    master="$(printf '%s' "$addr" | cut -f1)"; agent="$(printf '%s' "$addr" | cut -f2)"
  else
    master="$(smc_host)/coordinator"; agent="unknown agent"
  fi
  printf 'You are a WORKER in the %s swarm. The swarm master is %s (%s). Never ask the operator to do or decide anything, and do not end replies with questions or to-dos for the operator. Send questions, blockers, offers and next steps to the master with mail_send kind=request (to: %s), then carry on with whatever you are not blocked on; send results with kind=result. Only the master talks to the operator.\n' \
    "$(smc_host)" "$master" "$agent" "$master"
}
