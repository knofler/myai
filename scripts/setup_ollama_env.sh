#!/usr/bin/env bash
# setup_ollama_env.sh — make the quiet Ollama server env survive a reboot, on
# THIS Mac only (run it on the Mac that hosts the qwen lane; nothing here is
# fleet-wide).
#
# WHY: the qwen lane's quiet settings were applied with `launchctl setenv` +
# an Ollama.app restart, which macOS forgets at reboot — the next boot would
# serve 4 parallel requests, keep models loaded, and spin the fan. A user
# LaunchAgent (RunAtLoad) re-applies them at every login, before Ollama.app is
# usually opened. Ollama.app reads launchd's env when IT starts, so after a
# change the app must be restarted once (this script says so; it never kills
# Ollama itself).
#
#   OLLAMA_CONTEXT_LENGTH=65536   matches the lane's num_ctx (claude-qwen uses 64k too)
#   OLLAMA_NUM_PARALLEL=1         one request at a time
#   OLLAMA_MAX_LOADED_MODELS=1    never two models resident
#   OLLAMA_KEEP_ALIVE=5m          unload after 5 idle minutes → silent
#
# Usage:
#   setup_ollama_env.sh --install     write + load ~/Library/LaunchAgents/com.myai.ollama-env.plist
#   setup_ollama_env.sh --status      plist present? values in plist vs live launchctl getenv
#   setup_ollama_env.sh --uninstall   unload + remove the plist (live env untouched)
#   setup_ollama_env.sh --dry-run     print the plist, change nothing
# Values: override with the same env names (e.g. OLLAMA_KEEP_ALIVE=10m).
# Journal it after --install: scripts/config_journal.sh note <plist> "<why>".
# Tests: scripts/tests/test_qwen_lane.sh (LAUNCH_AGENTS_DIR + a launchctl stub)
set -uo pipefail

LABEL="com.myai.ollama-env"
AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$AGENTS_DIR/$LABEL.plist"
VARS="OLLAMA_CONTEXT_LENGTH OLLAMA_NUM_PARALLEL OLLAMA_MAX_LOADED_MODELS OLLAMA_KEEP_ALIVE"

want() {
  case "$1" in
    OLLAMA_CONTEXT_LENGTH)    echo "${OLLAMA_CONTEXT_LENGTH:-65536}" ;;
    OLLAMA_NUM_PARALLEL)      echo "${OLLAMA_NUM_PARALLEL:-1}" ;;
    OLLAMA_MAX_LOADED_MODELS) echo "${OLLAMA_MAX_LOADED_MODELS:-1}" ;;
    OLLAMA_KEEP_ALIVE)        echo "${OLLAMA_KEEP_ALIVE:-5m}" ;;
  esac
}

render_plist() {
  local cmd="" v
  for v in $VARS; do cmd="$cmd/bin/launchctl setenv $v $(want "$v"); "; done
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${cmd% }</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
}

do_install() {
  local lib; lib="$(cd "$(dirname "$0")" && pwd)/lib/fleet_role.sh"
  # shellcheck source=scripts/lib/fleet_role.sh
  if [ -f "$lib" ] && . "$lib" && ! fleet_local_llm_allowed; then
    echo "setup_ollama_env: this Mac is role $(fleet_my_role) (profile local_llm=off) — no local LLM here, not installing" >&2
    return 3
  fi
  [ "$(uname -s)" = Darwin ] || [ -n "${LAUNCH_AGENTS_DIR:-}" ] || { echo "setup_ollama_env: macOS only" >&2; return 1; }
  mkdir -p "$AGENTS_DIR"
  local new; new="$(render_plist)"
  if [ -f "$PLIST" ] && [ "$(cat "$PLIST")" = "$new" ]; then
    echo "setup_ollama_env: $PLIST already current"
  else
    printf '%s\n' "$new" > "$PLIST"
    echo "setup_ollama_env: wrote $PLIST"
  fi
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  if launchctl load "$PLIST" >/dev/null 2>&1; then echo "setup_ollama_env: loaded (env applied now and at every login)"
  else echo "setup_ollama_env: WARN — launchctl load failed; the plist still applies at next login" >&2; fi
  local v drift=0
  for v in $VARS; do [ "$(launchctl getenv "$v" 2>/dev/null)" = "$(want "$v")" ] || drift=1; done
  [ "$drift" = 0 ] && echo "setup_ollama_env: live launchd env matches" \
                   || echo "setup_ollama_env: WARN — live launchd env differs (see --status)" >&2
  echo "setup_ollama_env: restart Ollama.app once if its settings changed (it reads the env when it starts)."
  echo "  journal it: scripts/config_journal.sh note $PLIST \"quiet Ollama env for the qwen lane, this Mac only\""
}

do_status() {
  local v live inplist
  if [ -f "$PLIST" ]; then echo "plist: $PLIST (present)"; else echo "plist: $PLIST (MISSING — run --install)"; fi
  printf '  %-26s %-10s %-10s %s\n' VAR WANT LIVE PLIST
  for v in $VARS; do
    live="$(launchctl getenv "$v" 2>/dev/null)"
    inplist="$(grep -o "setenv $v [^;<]*" "$PLIST" 2>/dev/null | awk '{print $3}')"
    printf '  %-26s %-10s %-10s %s\n' "$v" "$(want "$v")" "${live:--}" "${inplist:--}"
  done
}

do_uninstall() {
  [ -f "$PLIST" ] || { echo "setup_ollama_env: not installed"; return 0; }
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  echo "setup_ollama_env: removed $PLIST (live env untouched until reboot)"
}

case "${1:---status}" in
  --install)   do_install ;;
  --status)    do_status ;;
  --uninstall) do_uninstall ;;
  --dry-run)   render_plist ;;
  -h|--help)   sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) echo "usage: setup_ollama_env.sh --install|--status|--uninstall|--dry-run" >&2; exit 2 ;;
esac
