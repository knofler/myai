#!/usr/bin/env bash
# setup_boot_schedule.sh — install/remove the launchd agent that fires the
# `boot` routine (scripts/morning_boot.sh) at 08:00 on THIS host's weekdays.
#
#   ./scripts/setup_boot_schedule.sh              # install for this host (days from config)
#   ./scripts/setup_boot_schedule.sh --at 07:30   # different time
#   ./scripts/setup_boot_schedule.sh --profile work   # pin CLAUDE_CONFIG_DIR to ~/.claude-work
#   ./scripts/setup_boot_schedule.sh --print      # emit the plist that WOULD be installed
#   ./scripts/setup_boot_schedule.sh --status     # agent state + last report
#   ./scripts/setup_boot_schedule.sh --run-now    # fire it once, immediately
#   ./scripts/setup_boot_schedule.sh --uninstall  # remove
#
# WHICH DAYS: config/boot_machines.txt, `<hostname -s>[:<days>]` — operator
# directive 2026-09-21: the office Mac Monday–Thursday, the home Mac
# Friday. A host not listed there gets Mon–Fri installed
# but the routine itself exits 0 on that host, so it is harmless and pointless.
# scripts/boot_sync.sh re-runs this installer at session start whenever the
# config and the installed plist disagree, so editing the config on EITHER Mac
# is the only step; each Mac installs its own agent on its next session.
#
# PROFILE: CLAUDE_CONFIG_DIR is pinned to the swarm MASTER's profile
# (swarm_roles.sh role_master_lane: ~/.myai/swarm/master.<host> lane=, else
# `default` = ~/.claude; operator directive 2026-09-21: the boot runs as the
# master on every Mac). The boot never launches `claude` itself, so this only
# decides which profile's hooks and settings any helper it calls resolves
# against. Override: --profile <name> (~/.claude-<name>; `default` = ~/.claude).
#
# launchd, not cron: macOS TCC blocks cron from the home directory, and a user
# LaunchAgent runs with normal file access and survives reboots. Same mechanism
# and conventions as setup_cli_runner_schedule.sh — deliberately, so there is
# one pattern on this machine, not two.
#
# TIMING. StartCalendarInterval. If the Mac is asleep or off at 08:00, launchd
# runs the job as soon as it wakes — the operator arriving late still gets a
# warm machine — which is why this is not a `StartInterval` poll.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
RAW_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/boot_machines.sh
. "$SCRIPT_DIR/lib/boot_machines.sh"

case "$(uname -s)" in
  Darwin) ;;
  *) echo "setup_boot_schedule: macOS only (launchd). This host is $(uname -s)." >&2; exit 1 ;;
esac

# ── Canonical master checkout (NEVER bake a worktree path into the plist) ──────
# The plist hard-codes TWO paths: ProgramArguments (morning_boot.sh) and
# WorkingDirectory. If either points at a runner worktree
# (~/ci-workspaces/.worktrees/…), that path is DELETED when the task finishes
# and launchd's 08:00 fire then dies with exit 78 EX_CONFIG — no boot at all.
# This recurred 2026-09-22/23 and again 2026-09-30 23:54 (task-75412752 installed
# from inside a worktree) → no boot 2026-10-01. So: resolve a DURABLE master
# checkout and bake THAT, and REFUSE to write a plist when we are running from a
# worktree — never emit a path we already know will rot.
WS_ROOT="${CI_WORKSPACES:-$HOME/ci-workspaces}"

_is_ephemeral_checkout() {   # a runner worktree / workspace clone — unsafe to bake
  local p="$1"
  [ -n "$p" ] || return 1
  case "$p" in "$WS_ROOT"/*) return 0 ;; esac
  [ -f "$p/.git" ] && return 0   # a linked git worktree keeps .git as a FILE
  return 1
}

_main_checkout_of() {   # a linked worktree's main checkout (git's common dir); empty if none
  local common
  common="$(git -C "$1" rev-parse --git-common-dir 2>/dev/null)" || return 0
  case "$common" in /*) ;; *) common="$1/$common" ;; esac
  [ "$(basename "$common")" = ".git" ] && ( cd "$(dirname "$common")" 2>/dev/null && pwd )
  return 0
}

_resolve_master_root() {   # first DURABLE checkout that actually carries the boot scripts
  local cand
  # MYAI_HOME = the framework checkout on hosts that export it (~/.zshenv).
  for cand in "${MYAI_MASTER_ROOT:-}" "$RAW_ROOT" "$(_main_checkout_of "$RAW_ROOT")" \
              "${MYAI_HOME:-}"; do
    [ -n "$cand" ] || continue
    _is_ephemeral_checkout "$cand" && continue
    [ -f "$cand/scripts/morning_boot.sh" ] && [ -f "$cand/scripts/setup_boot_schedule.sh" ] || continue
    ( cd "$cand" 2>/dev/null && pwd ) && return 0
  done
  return 1
}

# FROM_WORKTREE gates every write: --print/--status may still RENDER (redirected
# to the resolved master, so comparisons stay correct), but an actual install is
# refused. This is the belt to boot_sync.sh's braces (it skips re-install from a
# worktree entirely) — a direct manual run from a worktree must not mutate the
# live launchd plist either.
FROM_WORKTREE=0
if _is_ephemeral_checkout "$RAW_ROOT"; then
  FROM_WORKTREE=1
  ROOT="$(_resolve_master_root || true)"
  [ -n "$ROOT" ] || ROOT="$RAW_ROOT"   # nothing durable found; display only, never installed
else
  ROOT="$RAW_ROOT"
fi

refuse_worktree_install() {
  echo "setup_boot_schedule: REFUSING to install from an ephemeral checkout ($RAW_ROOT)." >&2
  echo "  A launchd plist pointing here breaks at 08:00 (exit 78 EX_CONFIG) once the worktree is cleaned up." >&2
  if [ "$ROOT" != "$RAW_ROOT" ]; then
    echo "  Master checkout resolved to $ROOT — run the installer from there:" >&2
    echo "    (cd \"$ROOT\" && ./scripts/setup_boot_schedule.sh)" >&2
  else
    echo "  No durable master checkout found — run from the master checkout, or set MYAI_MASTER_ROOT to it." >&2
  fi
  exit 78
}

LABEL="com.myai.morning-boot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BOOTER="$ROOT/scripts/morning_boot.sh"
LOG_DIR="$HOME/.ai-cli-runner/boot"
ALLOW_FILE="${BOOT_MACHINES_FILE:-$ROOT/config/boot_machines.txt}"   # override: tests only
HOUR=8
MINUTE=0
# shellcheck source=scripts/lib/swarm_roles.sh
. "$SCRIPT_DIR/lib/swarm_roles.sh"
PROFILE="${BOOT_CLAUDE_PROFILE:-$(role_master_lane)}"
ACTION=install
HOST="${BOOT_HOST_OVERRIDE:-$(hostname -s 2>/dev/null || echo unknown)}"   # override: tests only

while [ $# -gt 0 ]; do
  case "$1" in
    --at)
      shift
      AT="${1:?--at needs HH:MM}"
      HOUR="${AT%%:*}"; MINUTE="${AT##*:}"
      HOUR="$((10#$HOUR))"; MINUTE="$((10#$MINUTE))"
      ;;
    --profile)   shift; PROFILE="${1:?--profile needs a profile name}" ;;
    --print)     ACTION=print ;;
    --status)    ACTION=status ;;
    --run-now)   ACTION=runnow ;;
    --uninstall) ACTION=uninstall ;;
    -h|--help)   grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "setup_boot_schedule: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$PROFILE" in
  default) CONFIG_DIR="$HOME/.claude" ;;
  ''|*[!a-z0-9_-]*) echo "setup_boot_schedule: --profile must be a profile name [a-z0-9_-] (got $PROFILE)" >&2; exit 2 ;;
  *) CONFIG_DIR="$HOME/.claude-$PROFILE" ;;
esac
# A named profile must exist; the bare default may not yet (claude creates it).
[ "$PROFILE" = default ] || [ -d "$CONFIG_DIR" ] || { echo "setup_boot_schedule: --profile $PROFILE: no such profile dir $CONFIG_DIR" >&2; exit 2; }

LISTED=1
DAYS="$(boot_machines_days "$ALLOW_FILE" "$HOST" 2>/dev/null)" || { LISTED=0; DAYS="1 2 3 4 5"; }
DAYS_LABEL="$(boot_machines_label "$DAYS")"

render_plist() {
  cat <<PLIST_HEAD
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$BOOTER</string>
    </array>
    <key>StartCalendarInterval</key>
    <array>
PLIST_HEAD
  # launchd needs one dict per weekday; there is no range syntax.
  local wd
  for wd in $DAYS; do
    printf '        <dict><key>Weekday</key><integer>%s</integer><key>Hour</key><integer>%s</integer><key>Minute</key><integer>%s</integer></dict>\n' \
      "$wd" "$HOUR" "$MINUTE"
  done
  cat <<PLIST_TAIL
    </array>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>$LOG_DIR/boot.out</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/boot.err</string>
    <key>WorkingDirectory</key><string>$ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$HOME/.local/bin:$HOME/.docker/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>CLAUDE_CONFIG_DIR</key><string>$CONFIG_DIR</string>
        <key>MYAI_HOME</key><string>$ROOT</string>
    </dict>
</dict>
</plist>
PLIST_TAIL
}

installed_days_label() {   # from the plist on disk
  local d
  d="$(grep -o '<key>Weekday</key><integer>[0-6]</integer>' "$PLIST" 2>/dev/null | grep -o '[0-6]' | sort -un | tr '\n' ' ' | sed 's/ $//')"
  [ -n "$d" ] && boot_machines_label "$d" || echo "?"
}

case "$ACTION" in
  print)
    render_plist
    exit 0
    ;;
  status)
    if launchctl list "$LABEL" >/dev/null 2>&1; then
      echo "INSTALLED: $LABEL"
      launchctl list "$LABEL" | grep -E '"(PID|LastExitStatus)"' || true
      if [ -f "$PLIST" ]; then
        h="$(grep -o '<key>Hour</key><integer>[0-9]*' "$PLIST" | head -1 | grep -o '[0-9]*$')"
        m="$(grep -o '<key>Minute</key><integer>[0-9]*' "$PLIST" | head -1 | grep -o '[0-9]*$' | awk '{printf "%02d", $1}')"
        prof="$(grep -A1 'CLAUDE_CONFIG_DIR' "$PLIST" | grep -o 'claude-[a-z]*' | head -1)"
        echo "Schedule: ${h}:${m} $(installed_days_label)  profile=${prof:-?}"
        if render_plist | cmp -s - "$PLIST"; then echo "Plist:    matches config (boot_machines.txt + defaults)"
        else echo "Plist:    DIFFERS from config — re-run ./scripts/setup_boot_schedule.sh (boot_sync does this at session start)"; fi
      fi
    else
      echo "NOT installed."
    fi
    echo "Hosts (config/boot_machines.txt):"
    boot_machines_hosts "$ALLOW_FILE" | while read -r hh dd; do printf '  %-24s %s\n' "$hh" "$(boot_machines_label "$dd")"; done
    echo "This host:     $HOST → $([ "$LISTED" = 1 ] && echo "$DAYS_LABEL" || echo 'not listed (routine exits 0 here)')"
    bash "$BOOTER" --status 2>/dev/null || true
    exit 0
    ;;
  uninstall)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Uninstalled $LABEL."
    exit 0
    ;;
  runnow)
    if launchctl list "$LABEL" >/dev/null 2>&1; then
      launchctl start "$LABEL"
      echo "Fired $LABEL — watch: tail -f $LOG_DIR/boot.out"
    else
      echo "$LABEL not installed; running in the foreground instead."
      exec bash "$BOOTER"
    fi
    exit 0
    ;;
esac

# Default action = install. NEVER write a plist from a worktree (see header).
[ "$FROM_WORKTREE" = 1 ] && refuse_worktree_install

[ -f "$BOOTER" ] || { echo "setup_boot_schedule: $BOOTER missing" >&2; exit 1; }
chmod +x "$BOOTER"
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

if [ -f "$PLIST" ] && render_plist | cmp -s - "$PLIST" && launchctl list "$LABEL" >/dev/null 2>&1; then
  printf 'Already installed and current: %s — %02d:%02d %s (profile claude-%s).\n' "$LABEL" "$HOUR" "$MINUTE" "$DAYS_LABEL" "$PROFILE"
  exit 0
fi

render_plist > "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

printf 'Installed %s — fires %02d:%02d %s on %s (profile claude-%s).\n' "$LABEL" "$HOUR" "$MINUTE" "$DAYS_LABEL" "$HOST" "$PROFILE"
if [ "$LISTED" != 1 ]; then
  echo "NOTE: config/boot_machines.txt names neither $HOST nor '*', so the routine will exit 0 without doing anything."
  echo "      Restore the universal '*:0-6' line (or add '$HOST:<days>') to make this Mac boot itself."
fi
echo "Watch:  tail -f $LOG_DIR/boot.out"
echo "Report: $ROOT/state/boot/BOOT_REPORT.$HOST.md"
