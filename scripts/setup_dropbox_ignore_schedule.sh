#!/usr/bin/env bash
# setup_dropbox_ignore_schedule.sh — install/remove the launchd agent that keeps
# every node_modules (and the other regenerable artifact dirs) under Dropbox
# marked Dropbox-ignored, on THIS Mac, every 15 minutes.
#
#   ./scripts/setup_dropbox_ignore_schedule.sh              # install (idempotent)
#   ./scripts/setup_dropbox_ignore_schedule.sh --print      # emit the plist that WOULD be installed
#   ./scripts/setup_dropbox_ignore_schedule.sh --status     # agent state + last log lines
#   ./scripts/setup_dropbox_ignore_schedule.sh --run-now    # sweep once, immediately
#   ./scripts/setup_dropbox_ignore_schedule.sh --uninstall  # remove
#
# HARD RULE (AI_RULES §12, operator directive 2026-10-02): "node_modules by
# default for entire repos and devices … should be in Dropbox ignore list …
# I can openly go to any repo and download node_modules knowing it will never
# ever sync to Dropbox." The session hook (hooks/session/20-dropbox-ignore.sh)
# only covers the repo a Claude session starts in, and `--all` was a manual
# sweep — so an `npm install` in any other repo synced until someone swept by
# hand. This agent closes that gap: dropbox_ignore_artifacts.sh --all --quiet
# every 15 min (≈35 s of mostly-idle find over the Dropbox root), plus once at
# load. Each Mac installs its OWN agent: scripts/boot_sync.sh re-runs this
# installer at session start whenever the plist is missing or stale, and the
# 08:00 boot records a sweep phase, so the rule holds on every device with no
# per-machine step. Dropbox ignore is per-folder xattr (com.dropbox.ignored),
# so it must be applied on each Mac that creates the folder — exactly this.
#
# Same conventions as setup_boot_schedule.sh: launchd (not cron — TCC), never
# bake a runner-worktree path into the plist.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
RAW_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.myai.dropbox-ignore"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.ai-cli-runner"
INTERVAL="${DROPBOX_IGNORE_INTERVAL_SEC:-900}"
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

_resolve_master_root() {
  local cand
  # MYAI_HOME = the framework checkout on hosts that export it (~/.zshenv).
  for cand in "${MYAI_MASTER_ROOT:-}" "$RAW_ROOT" "$(_main_checkout_of "$RAW_ROOT")" \
              "${MYAI_HOME:-}"; do
    [ -n "$cand" ] || continue
    _is_ephemeral_checkout "$cand" && continue
    [ -f "$cand/scripts/dropbox_ignore_artifacts.sh" ] || continue
    ( cd "$cand" 2>/dev/null && pwd ) && return 0
  done
  return 1
}

FROM_WORKTREE=0
if _is_ephemeral_checkout "$RAW_ROOT"; then
  FROM_WORKTREE=1
  ROOT="$(_resolve_master_root || true)"
  [ -n "$ROOT" ] || ROOT="$RAW_ROOT"
else
  ROOT="$RAW_ROOT"
fi
SWEEPER="$ROOT/scripts/dropbox_ignore_artifacts.sh"

ACTION=install
for a in "$@"; do
  case "$a" in
    --print)     ACTION=print ;;
    --status)    ACTION=status ;;
    --run-now)   ACTION=run ;;
    --uninstall) ACTION=uninstall ;;
    -h|--help)   sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "setup_dropbox_ignore_schedule: unknown option $a" >&2; exit 2 ;;
  esac
done

render_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$SWEEPER</string>
    <string>--all</string>
    <string>--quiet</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>StartInterval</key>
  <integer>$INTERVAL</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/dropbox-ignore.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/dropbox-ignore.log</string>
</dict>
</plist>
EOF
}

case "$ACTION" in
  print) render_plist; exit 0 ;;
  status)
    if launchctl list "$LABEL" >/dev/null 2>&1; then echo "$LABEL: loaded (every ${INTERVAL}s)"; else echo "$LABEL: NOT loaded"; fi
    [ -f "$LOG_DIR/dropbox-ignore.log" ] && tail -5 "$LOG_DIR/dropbox-ignore.log"
    exit 0 ;;
  run) exec /bin/bash "$SWEEPER" --all ;;
  uninstall)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL."
    exit 0 ;;
esac

[ "$(uname -s)" = Darwin ] || { echo "setup_dropbox_ignore_schedule: macOS only — skipped."; exit 0; }
if [ "$FROM_WORKTREE" = 1 ]; then
  echo "setup_dropbox_ignore_schedule: REFUSING to install from an ephemeral checkout ($RAW_ROOT); run it from $ROOT." >&2
  exit 1
fi
[ -f "$SWEEPER" ] || { echo "setup_dropbox_ignore_schedule: $SWEEPER missing" >&2; exit 1; }
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

if [ -f "$PLIST" ] && render_plist | cmp -s - "$PLIST" && launchctl list "$LABEL" >/dev/null 2>&1; then
  echo "Already installed and current: $LABEL — every ${INTERVAL}s."
  exit 0
fi

render_plist > "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Installed $LABEL — sweeps the Dropbox root every ${INTERVAL}s (and now). Log: $LOG_DIR/dropbox-ignore.log"
