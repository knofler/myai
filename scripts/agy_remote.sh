#!/usr/bin/env bash
# agy_remote.sh — start and inspect remote Antigravity (agy) sessions in visible iTerm tabs.
# Backs `agy remote start <repo>` and `agy remote status [repo]`.
#
# Constraints & Architecture:
#   1. Visible iTerm2 tabs only (never tmux). Opens via scripts/lib/iterm_tab.sh.
#   2. Runs `cd <repo> && agy` so ~/.zshrc's agy() wrapper gives:
#      --dangerously-skip-permissions --remote-control --remote-control-name "<DEVICE> - <repo>".
#   3. Duplicate guard: if an agy session is already running in that repo, reports it
#      instead of spawning a duplicate.
#   4. Reuses repo-name→path resolution matching remote_fleet.sh (config/remote_fleet.txt
#      + managed repos).
#
# Usage:
#   scripts/agy_remote.sh start <repo> [--dry-run]
#   scripts/agy_remote.sh status [repo]
#
# bash 3.2-safe. Sourced with AGY_REMOTE_LIB_ONLY=1 for hermetic unit testing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
MASTER_PATH="$(cd "$SCRIPT_DIR/.." && pwd)"
FLEET_FILE="${AGY_REMOTE_FLEET_FILE:-$MASTER_PATH/config/remote_fleet.txt}"
MANAGED_FILE="${AGY_REMOTE_MANAGED_FILE:-$MASTER_PATH/config/managed_repos.txt}"

# Source the generic iTerm helper
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/lib/iterm_tab.sh" ] && . "$SCRIPT_DIR/lib/iterm_tab.sh"

# ── Stubbable OS hooks for unit testing ─────────────────────────────────────────
_agy_remote_comm()     { ps -o comm= -p "$1" 2>/dev/null || true; }
_agy_remote_cwd()      { lsof -nP -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true; }
_agy_remote_ps()       { ps -axo pid,tty,command 2>/dev/null || true; }
_agy_remote_hostname() { hostname -s 2>/dev/null || echo "unknown"; }
_agy_remote_iterm()    { iterm_open_tab "$1" "$2" "${3:-5}"; }
_agy_remote_read_tab() { iterm_read_tab "$1" "${2:-40}"; }
_agy_remote_sleep()    { sleep "$1"; }

# ── Repo resolution (matching remote_fleet.sh resolve_targets) ────────────────
# shellcheck disable=SC2088  # deliberate: matching literal tilde prefix in config files
expand_tilde() { case "$1" in "~/"*) printf '%s' "$HOME/${1#\~/}" ;; *) printf '%s' "$1" ;; esac; }

fleet_root_ok() { [ -e "$1/.git" ] || [ -e "$1/.mcp.json" ]; }

# fleet_all_paths → all paths from remote_fleet.txt and managed_repos.txt
fleet_all_paths() {
  local f p
  for f in "$FLEET_FILE" "$MANAGED_FILE"; do
    [ -f "$f" ] || continue
    grep -vE '^\s*(#|$)' "$f" | while IFS= read -r line; do
      line="${line%%#*}"
      line="$(printf '%s' "$line" | awk '{$1=$1};1')"
      [ -n "$line" ] || continue
      p="$(expand_tilde "$line")"
      if [ -d "$p" ] && fleet_root_ok "$p"; then
        printf '%s\n' "$p"
      fi
    done
  done | awk '!seen[$0]++'
}

agy_remote_resolve() { # <repo-name|path> → canonical path on stdout, 1 if unresolvable
  local want="$1" p name
  [ -n "$want" ] || return 1

  # Direct path check
  if [ -d "$want" ]; then
    (cd "$want" 2>/dev/null && pwd -P) && return 0
  fi

  # Name match across configured fleet paths (case-insensitive fallback)
  local exact="" ci=""
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    name="$(basename "$p")"
    if [ "$name" = "$want" ]; then
      exact="$p"
      break
    elif [ "$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$want" | tr '[:upper:]' '[:lower:]')" ]; then
      [ -z "$ci" ] && ci="$p"
    fi
  done <<EOF
$(fleet_all_paths)
EOF

  if [ -n "$exact" ]; then
    printf '%s\n' "$exact"
    return 0
  fi
  if [ -n "$ci" ]; then
    printf '%s\n' "$ci"
    return 0
  fi

  return 1
}

# ── Live agy session discovery ────────────────────────────────────────────────
# agy_remote_live_sessions → lines "pid<TAB>tty<TAB>cwd<TAB>repo<TAB>rc_name"
agy_remote_live_sessions() {
  local out pid tty cmd comm cwd repo rc_name device
  device="$(_agy_remote_hostname)"
  out="$(_agy_remote_ps)"
  [ -n "$out" ] || return 0

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    pid="$(printf '%s' "$line" | awk '{print $1}')"
    tty="$(printf '%s' "$line" | awk '{print $2}')"
    cmd="$(printf '%s' "$line" | awk '{$1=""; $2=""; sub(/^[ \t]+/, ""); print}')"

    [ -n "$pid" ] || continue
    case "$tty" in ''|'??'|'?') continue ;; esac
    case "$cmd" in *agy*) ;; *) continue ;; esac

    comm="$(_agy_remote_comm "$pid")"
    case "${comm##*/}" in
      agy) ;;
      *)
        case "$cmd" in
          agy\ *|*/agy\ *|agy) ;;
          *) continue ;;
        esac
        ;;
    esac

    # Exclude daemon and non-interactive runner tasks
    case "$cmd" in
      *"remote-control serve"*) continue ;;
      *" -p "*|*" --print "*) continue ;;
    esac

    cwd="$(_agy_remote_cwd "$pid")"
    [ -n "$cwd" ] || continue
    repo="$(basename "$cwd")"

    # Extract remote control name if specified
    rc_name="$(printf '%s\n' "$cmd" | awk '
    {
      for (i = 1; i <= NF; i++) {
        if ($i == "--remote-control-name") {
          res = ""
          for (j = i + 1; j <= NF; j++) {
            if ($j ~ /^--/ || $j ~ /^-[a-zA-Z]/) break
            res = (res == "" ? $j : res " " $j)
          }
          gsub(/^"|"$/, "", res)
          print res; exit
        }
        if ($i ~ /^--remote-control-name=/) {
          sub(/^--remote-control-name=/, "", $i)
          gsub(/^"|"$/, "", $i)
          print $i; exit
        }
      }
    }')"

    if [ -z "$rc_name" ]; then
      case "$cmd" in
        *"--remote-control"*) rc_name="$device - $repo" ;;
        *) rc_name="local (no RC)" ;;
      esac
    fi

    printf '%s\t%s\t%s\t%s\t%s\n' "$pid" "$tty" "$cwd" "$repo" "$rc_name"
  done <<EOF
$out
EOF
}

# ── Subcommands ───────────────────────────────────────────────────────────────

agy_remote_status() { # [repo]
  local filter="${1:-}" sessions count=0 pid tty cwd repo rc_name filter_lower
  sessions="$(agy_remote_live_sessions)"
  filter_lower="$(printf '%s' "$filter" | tr '[:upper:]' '[:lower:]')"

  echo "── Live Antigravity (agy) Sessions ──"
  if [ -n "$sessions" ]; then
    printf '%-18s %-8s %-10s %-25s %s\n' "REPO" "PID" "TTY" "RC NAME" "PATH"
    printf '%-18s %-8s %-10s %-25s %s\n' "────" "───" "───" "───────" "────"
    while IFS=$'\t' read -r pid tty cwd repo rc_name; do
      [ -n "$pid" ] || continue
      if [ -n "$filter" ]; then
        if [ "$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')" != "$filter_lower" ] && \
           [ "$(printf '%s' "$cwd" | tr '[:upper:]' '[:lower:]')" != "$filter_lower" ]; then
          continue
        fi
      fi
      count=$((count + 1))
      printf '%-18s %-8s %-10s %-25s %s\n' "$repo" "$pid" "${tty#/dev/}" "$rc_name" "$cwd"
    done <<EOF
$sessions
EOF
  fi

  if [ "$count" -eq 0 ]; then
    if [ -n "$filter" ]; then
      echo "No live agy sessions matching '$filter'."
    else
      echo "No live agy sessions found."
    fi
  else
    echo ""
    echo "Total live sessions: $count"
  fi
  return 0
}

agy_remote_start() { # <repo> [--dry-run]
  local repo_arg="${1:-}" dry_run=0 target_path repo_name device expected_rc
  shift 2>/dev/null || true

  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1; shift ;;
      *) shift ;;
    esac
  done

  if [ -z "$repo_arg" ]; then
    echo "agy_remote start: missing repo argument" >&2
    echo "usage: scripts/agy_remote.sh start <repo> [--dry-run]" >&2
    return 2
  fi

  target_path="$(agy_remote_resolve "$repo_arg")" || {
    echo "agy_remote start: cannot resolve fleet repo '$repo_arg'" >&2
    echo "checked: $FLEET_FILE and $MANAGED_FILE" >&2
    return 1
  }

  repo_name="$(basename "$target_path")"
  device="$(_agy_remote_hostname)"
  expected_rc="$device - $repo_name"

  # Duplicate guard: check if agy is already live in this exact directory
  local live pid tty cwd repo rc_name
  live="$(agy_remote_live_sessions)"
  if [ -n "$live" ]; then
    while IFS=$'\t' read -r pid tty cwd repo rc_name; do
      [ -n "$pid" ] || continue
      if [ "$cwd" = "$target_path" ]; then
        echo "agy_remote: agy is ALREADY LIVE for $repo_name (pid $pid, tty ${tty#/dev/}, RC: '$rc_name') — skipping duplicate"
        return 0
      fi
    done <<EOF
$live
EOF
  fi

  if [ "$dry_run" -eq 1 ]; then
    echo "[dry-run] would open visible iTerm tab in '$target_path' running 'cd $target_path && agy'"
    echo "[dry-run] expected Remote Control name: '$expected_rc'"
    return 0
  fi

  # Launch visible tab in iTerm2
  local tty_out
  echo "agy_remote: starting agy for $repo_name in a new visible iTerm tab..."
  tty_out="$(_agy_remote_iterm "$target_path" "agy" 5)" || {
    echo "agy_remote start: failed to open or verify iTerm tab for $repo_name" >&2
    return 1
  }

  local clean_tty="${tty_out#/dev/}" live_pid="" live_rc="" waited=0 wait_max="${AGY_START_WAIT:-20}"
  while [ "$waited" -lt "$wait_max" ]; do
    while IFS=$'\t' read -r pid tty cwd repo rc_name; do
      [ -n "$pid" ] || continue
      if [ "${tty#/dev/}" = "$clean_tty" ] && [ "$cwd" = "$target_path" ]; then
        live_pid="$pid"
        live_rc="$rc_name"
        break 2
      fi
    done <<EOF
$(agy_remote_live_sessions)
EOF
    _agy_remote_sleep 1
    waited=$((waited + 1))
  done

  if [ -n "$live_pid" ]; then
    echo "agy_remote: started agy for $repo_name (pid $live_pid, tty $clean_tty)"
    echo "  remote control name: $live_rc"
    echo "  connect from phone:  https://antigravity.google.com"
    return 0
  fi

  local screen_tail
  screen_tail="$(_agy_remote_read_tab "$tty_out" 15 2>/dev/null || true)"
  echo "agy_remote start: tab opened at $clean_tty but no agy process appeared there within ${wait_max}s" >&2
  if [ -n "$screen_tail" ]; then
    echo "tab screen output:" >&2
    printf '%s\n' "$screen_tail" | sed 's/^/  /' >&2
  fi
  return 1
}

[ -n "${AGY_REMOTE_LIB_ONLY:-}" ] && return 0

# ── CLI Entry ─────────────────────────────────────────────────────────────────
action="${1:-help}"
shift 2>/dev/null || true

case "$action" in
  start)
    agy_remote_start "$@"
    ;;
  status)
    agy_remote_status "$@"
    ;;
  help|-h|--help)
    echo "Usage:"
    echo "  scripts/agy_remote.sh start <repo> [--dry-run]   # launch phone-drivable agy session in iTerm"
    echo "  scripts/agy_remote.sh status [repo]              # list running agy sessions across the fleet"
    ;;
  *)
    echo "agy_remote: unknown action '$action'" >&2
    echo "Usage: scripts/agy_remote.sh {start|status|help}" >&2
    exit 2
    ;;
esac
