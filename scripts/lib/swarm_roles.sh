#!/usr/bin/env bash
# swarm_roles.sh — ROLE lookups for the swarm (v1 G6, phase P1; design:
# state/reports/v1-g6-lane-rename.md, approved by the master 2026-10-22).
#
# Shipped code must never spell an operator's lane or profile names: lanes
# are user DATA, derived from profile directory names (~/.claude-<x> → x,
# bare ~/.claude → default; smc_lane_for in swarm_master_config.sh), and the
# master is CONFIGURED per host (~/.myai/swarm/master.<host>). Code asks for a
# role instead:
#
#   role_master_lane      the master's lane       (master.<host> lane=,    else `default`)
#   role_master_profile   the master's config dir (master.<host> profile=, else ~/.claude)
#   role_master_agent     the master's agent      (master.<host> agent=,   else claude)
#   role_runner_profile   the runner's config dir ($MYAI_RUNNER_PROFILE, else
#                         ${MYAI_USER_DIR:-~/.myai}/runner.conf profile=, else ~/.claude)
#   role_profiles         every Claude profile dir on this Mac, one per line
#                         (~/.claude first when present, then ~/.claude-* sorted)
#   role_profile_names    the NAMED profiles (~/.claude-<n>) a setup script
#                         manages: $MYAI_PROFILES, else the ~/.claude-* dirs on
#                         disk; empty → only ~/.claude
#   role_valid_names n…   the names that are valid profile names ([a-z0-9_-])
#   role_lane_of <dir>    the lane a Claude profile dir runs as
#   role_is_master <lane> 0 when <lane> is the master's lane
#   role_worker_lanes     every profile lane except the master's, one per line
#
# The fallbacks are the fresh-install defaults the master ruled (a single
# ~/.claude profile, lane `default`). On an existing host the config files
# carry the real names, so every answer equals what that host uses today.
# P1 adds the resolver only; call sites move onto it in P2–P5.
#
# bash 3.2-safe; safe under `set -euo pipefail`; no network.

ROLES_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=scripts/lib/swarm_master_config.sh
. "$ROLES_HERE/swarm_master_config.sh"

role_master_lane() {
  local v; v="$(smc_get lane)"
  printf '%s' "${v:-default}"
}

role_master_profile() {
  local v; v="$(smc_get profile)"
  printf '%s' "${v:-$HOME/.claude}"
}

role_master_agent() {
  local v; v="$(smc_get agent)"
  printf '%s' "${v:-claude}"
}

# role_runner_conf → path of the per-user runner config. Always the USER's
# ~/.myai (or $MYAI_USER_DIR), never $MYAI_HOME: a host may point MYAI_HOME at
# the framework checkout, and runner.conf written there lands in a shared,
# Dropbox-synced repo (2026-10-27, home Mac).
role_runner_conf() { printf '%s/runner.conf' "${MYAI_USER_DIR:-$HOME/.myai}"; }

role_runner_profile() {
  if [ -n "${MYAI_RUNNER_PROFILE:-}" ]; then printf '%s' "$MYAI_RUNNER_PROFILE"; return 0; fi
  local f v=""; f="$(role_runner_conf)"
  [ -f "$f" ] && v="$(sed -n 's/^profile=//p' "$f" 2>/dev/null | head -1)"
  printf '%s' "${v:-$HOME/.claude}"
}

role_profiles() {
  [ -d "$HOME/.claude" ] && printf '%s\n' "$HOME/.claude"
  local d
  for d in "$HOME"/.claude-*; do
    [ -d "$d" ] || continue
    printf '%s\n' "$d"
  done | LC_ALL=C sort
}

# Names are [a-z0-9_-] only (they become ~/.claude-<n> paths and shell
# function names); anything else is dropped with a warning on stderr.
role_valid_names() {
  local n
  for n in "$@"; do
    case "$n" in
      *[!a-z0-9_-]*|'') printf 'swarm_roles: ignoring profile name %s\n' "$n" >&2 ;;
      *) printf '%s\n' "$n" ;;
    esac
  done
}

role_profile_names() {
  local d
  if [ -n "${MYAI_PROFILES:-}" ]; then
    # shellcheck disable=SC2086  # a space-separated list, split on purpose
    role_valid_names $MYAI_PROFILES
    return 0
  fi
  for d in "$HOME"/.claude-*; do
    [ -d "$d" ] && role_valid_names "${d##*/.claude-}"
  done
  return 0
}

role_lane_of() { smc_lane_for claude "${1:-}"; }

role_is_master() { [ -n "${1:-}" ] && [ "$1" = "$(role_master_lane)" ]; }

role_worker_lanes() {
  local master d lane
  master="$(role_master_lane)"
  role_profiles | while IFS= read -r d; do
    lane="$(role_lane_of "$d")"
    [ "$lane" = "$master" ] || printf '%s\n' "$lane"
  done
}
