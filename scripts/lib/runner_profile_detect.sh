#!/usr/bin/env bash
# runner_profile_detect.sh — record which Claude profile dir THIS host's task
# runner actually uses, in ${MYAI_USER_DIR:-~/.myai}/runner.conf (v1 G6, phase P3a;
# design: state/reports/v1-g6-lane-rename.md §5.2, master ruling 2026-10-26).
#
# WHY. role_runner_profile (swarm_roles.sh) answers "which profile does the
# runner use?" from $MYAI_RUNNER_PROFILE, then runner.conf, then ~/.claude. Hosts
# installed before G6 have no runner.conf: their runner runs on a profile named
# in its scheduler entry. Moving the runner's call sites onto the resolver (P3)
# without this file would silently switch those runners to ~/.claude. So
# `myai upgrade` runs this first: it DETECTS the profile and writes it down.
# It never hard-codes a profile name.
#
# Sources, in order (the first that yields exactly one answer wins):
#   1. the installed scheduler entry — launchd plist (macOS), systemd user unit
#      or cron line (Linux): its CLAUDE_CONFIG_DIR is what actually runs
#   2. the runner's own environment: MYAI_RUNNER_FIRE=1 with CLAUDE_CONFIG_DIR
#   3. the default baked into the installed cli_task_runner.sh
#      (`export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-<dir>}"`)
#
# Rules: an existing runner.conf is NEVER overwritten. Two scheduler entries
# that disagree are ambiguous → write nothing, warn. A detected dir that does
# not exist → write nothing, warn. Nothing detected → write nothing (the
# fresh-install default ~/.claude applies). Always exits 0 so an upgrade can
# never fail here; usage errors exit 2.
#
# Usage:  runner_profile_detect.sh [--dry-run|--check]   (--check = --dry-run)
#         RPD_LIB_ONLY=1 . runner_profile_detect.sh      (source: rpd_detect)
# Test seams: RPD_LAUNCHD_PLIST, RPD_SYSTEMD_UNIT, RPD_CRONTAB (a file standing
# in for `crontab -l`), RPD_RUNNER_SCRIPT.
#
# bash 3.2-safe; safe under `set -euo pipefail`; no network.

RPD_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=scripts/lib/swarm_roles.sh disable=SC1091
. "$RPD_HERE/swarm_roles.sh"

RPD_CRON_MARKER="# myai-cli-runner (managed by setup_cli_runner_linux.sh"

rpd_launchd_plist() { printf '%s' "${RPD_LAUNCHD_PLIST:-$HOME/Library/LaunchAgents/com.myai.cli-task-runner.plist}"; }
rpd_systemd_unit()  { printf '%s' "${RPD_SYSTEMD_UNIT:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/myai-cli-runner.service}"; }

# Expand a leading $HOME / ${HOME} / %h / ~ to the real home dir.
# shellcheck disable=SC2016  # the patterns are the literal text "$HOME" / "${HOME}"
_rpd_expand() {
  local v="$1"
  case "$v" in
    '$HOME'*)   v="$HOME${v#\$HOME}" ;;
    '${HOME}'*) v="$HOME${v#\$\{HOME\}}" ;;
    '%h'*)      v="$HOME${v#%h}" ;;
    '~'*)       v="$HOME${v#\~}" ;;
  esac
  printf '%s' "$v"
}

# A plist key read with python3 plistlib (portable: also runs on Linux CI).
_rpd_plist_get() { # <plist> <dict> <key>
  [ -f "$1" ] || return 0
  python3 -I -c '
import plistlib, sys
try:
    d = plistlib.load(open(sys.argv[1], "rb"))
except Exception:
    sys.exit(0)
v = d.get(sys.argv[2])
if isinstance(v, dict):
    v = v.get(sys.argv[3])
if isinstance(v, str):
    print(v)
elif isinstance(v, list):
    print("\n".join(x for x in v if isinstance(x, str)))
' "$1" "$2" "$3" 2>/dev/null || true
}

# Source 1: every installed scheduler entry's CLAUDE_CONFIG_DIR, one per line.
_rpd_scheduler_dirs() {
  local v u cron
  v="$(_rpd_plist_get "$(rpd_launchd_plist)" EnvironmentVariables CLAUDE_CONFIG_DIR)"
  if [ -n "$v" ]; then _rpd_expand "$v"; echo; fi
  u="$(rpd_systemd_unit)"
  if [ -f "$u" ]; then
    v="$(sed -n 's/^Environment=CLAUDE_CONFIG_DIR=//p' "$u" 2>/dev/null | head -1)"
    if [ -n "$v" ]; then _rpd_expand "$v"; echo; fi
  fi
  if [ -n "${RPD_CRONTAB:-}" ]; then cron="$(cat "$RPD_CRONTAB" 2>/dev/null)" || cron=""
  else cron="$(crontab -l 2>/dev/null)" || cron=""; fi
  v="$(printf '%s\n' "$cron" | grep -F "$RPD_CRON_MARKER" | sed -n 's/.*CLAUDE_CONFIG_DIR=\([^ ]*\).*/\1/p' | head -1)" || v=""
  v="${v//\\/}"   # the cron line escapes \$HOME
  if [ -n "$v" ]; then _rpd_expand "$v"; echo; fi
  return 0
}

# Source 3: the default baked into the runner script the scheduler runs.
_rpd_runner_script() {
  if [ -n "${RPD_RUNNER_SCRIPT:-}" ]; then printf '%s' "$RPD_RUNNER_SCRIPT"; return 0; fi
  local s
  s="$(_rpd_plist_get "$(rpd_launchd_plist)" ProgramArguments x | grep 'cli_task_runner\.sh$' | head -1)" || s=""
  printf '%s' "${s:-$RPD_HERE/../cli_task_runner.sh}"
}
_rpd_script_default() {
  local f v
  f="$(_rpd_runner_script)"
  [ -f "$f" ] || return 0
  # shellcheck disable=SC2016  # matches the literal "${CLAUDE_CONFIG_DIR:-" text
  v="$(sed -n 's/^export CLAUDE_CONFIG_DIR="\${CLAUDE_CONFIG_DIR:-\([^}]*\)}".*/\1/p' "$f" 2>/dev/null | head -1)" || v=""
  # A runner from G6 P3 on asks the resolver (`$(role_runner_profile)`) instead
  # of naming a dir — that is not a detection, so stay silent.
  # shellcheck disable=SC2016  # the literal text "$(" — a command substitution in the runner
  case "$v" in ''|*'$('*) return 0 ;; esac
  _rpd_expand "$v"
}

# rpd_detect → prints "<dir>\t<source>" and returns 0; returns 1 when nothing is
# detected; returns 3 (printing "<dir1> <dir2>…\tambiguous") when the scheduler
# entries disagree.
rpd_detect() {
  local dirs n
  dirs="$(_rpd_scheduler_dirs | sed '/^$/d' | LC_ALL=C sort -u)"
  n="$(printf '%s' "$dirs" | grep -c . || true)"
  if [ "$n" -gt 1 ]; then printf '%s\tambiguous\n' "$(printf '%s' "$dirs" | tr '\n' ' ' | sed 's/ $//')"; return 3; fi
  if [ "$n" = 1 ]; then printf '%s\tscheduler entry\n' "$dirs"; return 0; fi
  if [ "${MYAI_RUNNER_FIRE:-}" = 1 ] && [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
    printf '%s\trunner environment\n' "$CLAUDE_CONFIG_DIR"; return 0
  fi
  dirs="$(_rpd_script_default)"
  if [ -n "$dirs" ]; then printf '%s\tcli_task_runner.sh default\n' "$dirs"; return 0; fi
  return 1
}

# rpd_record [--dry-run] → write runner.conf when absent and detection is clean.
rpd_record() {
  local dry="${1:-}" conf out rc dir src
  conf="$(role_runner_conf)"
  if [ -f "$conf" ]; then
    echo "runner profile: kept $conf ($(sed -n 's/^profile=//p' "$conf" | head -1))"
    return 0
  fi
  out="$(rpd_detect)" && rc=0 || rc=$?
  dir="${out%%$'\t'*}"; src="${out#*$'\t'}"
  case "$rc" in
    1) echo "runner profile: none detected — the runner uses the default ($HOME/.claude)"; return 0 ;;
    3) echo "⚠ runner profile: ambiguous — scheduler entries disagree ($dir); wrote nothing." >&2
       printf '  set it by hand: printf %s > %s\n' "'profile=<dir>\\n'" "$conf" >&2; return 0 ;;
  esac
  if [ ! -d "$dir" ]; then
    echo "⚠ runner profile: $src names $dir, which does not exist; wrote nothing." >&2; return 0
  fi
  if [ "$dry" = --dry-run ]; then
    echo "runner profile: would write $conf (profile=$dir, from the $src)"; return 0
  fi
  if ! { mkdir -p "$(dirname "$conf")" && printf 'profile=%s\n' "$dir" > "$conf.tmp.$$" && mv "$conf.tmp.$$" "$conf"; }; then
    rm -f "$conf.tmp.$$"; echo "⚠ runner profile: could not write $conf" >&2; return 0
  fi
  echo "runner profile: wrote $conf (profile=$dir, from the $src)"
}

if [ -z "${RPD_LIB_ONLY:-}" ] && [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  case "${1:-}" in
    ''|--apply)          rpd_record ;;
    --dry-run|--check)   rpd_record --dry-run ;;
    *) echo "usage: runner_profile_detect.sh [--dry-run|--check]" >&2; exit 2 ;;
  esac
  exit 0
fi
