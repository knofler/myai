#!/usr/bin/env bash
# qwen_lane.sh — the qwen swarm worker: a deterministic job runner in a VISIBLE
# iTerm tab, backed by the local Ollama (qwen3:8b by default).
#
# WHY NOT AN AGENT: claude-qwen (Claude Code on qwen3:8b) failed a simple live
# job — claimed real files didn't exist, asked a question, never reported. An
# 8B model can't drive tools reliably, and comms must not depend on a model
# CHOOSING to mail. So here the model gets no tools: scripts/lib/qwen_job_run.py
# reads the files, makes ONE no-tools /api/chat call and ALWAYS mails the
# sender back (done / blocker), then acks. Unacked mail to <host>/qwen IS the
# queue (oldest first) — jobs sent while the lane was down still run.
#
# QUIET BY DESIGN (this Mac's fan is in the operator's ear): one job at a time
# (mkdir lock), wait while on battery or while macOS reports a thermal/
# performance warning (pmset), cool down between jobs, and Ollama unloads the
# model after OLLAMA_KEEP_ALIVE (5m) → idle = silent. Ollama's server env is
# made reboot-proof by scripts/setup_ollama_env.sh.
#
# WHERE IT RUNS: headless. The operator's qwen tab is the claude-qwen CHAT
# ("I need it inside the chat window"), so the runner lives in the background
# under a LaunchAgent and shows itself INSIDE that chat as a statusLine
# (scripts/qwen_statusline.sh reads the state file this loop keeps current).
#
# Usage:
#   qwen_lane.sh install-agent     LaunchAgent com.myai.qwen-lane (KeepAlive, RunAtLoad,
#                                  log ~/.myai/logs/qwen_lane.log) — THIS Mac only
#   qwen_lane.sh uninstall-agent   unload + remove it
#   qwen_lane.sh install-statusline  add the lane statusLine to ~/.claude-qwen/settings.json
#   qwen_lane.sh start --headless  one-off background run (nohup) without the agent
#   qwen_lane.sh start             the old visible iTerm tab (opt-in)
#   qwen_lane.sh run      the loop itself (foreground; what the agent runs)
#   qwen_lane.sh status   running? pid, agent, chat statusLine, queued jobs, governor
#   qwen_lane.sh stop     stop the loop (the agent's KeepAlive restarts it — use
#                         uninstall-agent to stop for good)
# Queue a job:  scripts/qwen_job.sh --files 'state/boot/BOOT_REPORT.*.md' --prompt "..."
#
# Env: QWEN_ADDR (<host>/qwen) · QWEN_MODEL (qwen3:8b) · QWEN_POLL (15s idle
# poll) · QWEN_COOLDOWN (20s) · QWEN_GOV_POLL (30s) · QWEN_IGNORE_BATTERY=1 ·
# QWEN_ONCE=1 (exit after one job or one empty poll — tests/proofs) ·
# QWEN_STATE (~/.myai/qwen-lane) · QWEN_WAIT_LOCK=1 (set by the agent: a held
# lock means wait for that runner to exit, then take over — no respawn storm) ·
# QWEN_LOG (~/.myai/logs/qwen_lane.log) · LAUNCH_AGENTS_DIR · CLAUDE_QWEN_DIR.
# bash 3.2-safe. Tests: scripts/tests/test_qwen_lane.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_LC="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
export QWEN_ADDR="${QWEN_ADDR:-${HOST_LC:-localhost}/qwen}"
# Job globs resolve in the MAIN checkout, even when this script runs from a lane
# worktree: per-host state (state/boot/BOOT_REPORT.<host>.md, logs) is gitignored
# and exists only there — found live, the proof job matched nothing from a worktree.
qwen_main_checkout() {
  local common
  common="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || { echo "$REPO_ROOT"; return; }
  case "$common" in */.git) [ -d "${common%/.git}" ] && { echo "${common%/.git}"; return; } ;; esac
  echo "$REPO_ROOT"
}
export QWEN_REPO_ROOT="${QWEN_REPO_ROOT:-$(qwen_main_checkout)}"
QWEN_STATE="${QWEN_STATE:-${MYAI_HOME:-$HOME/.myai}/qwen-lane}"
export QWEN_STATE_DIR="${QWEN_STATE_DIR:-$QWEN_STATE/replied}"
LOCK="$QWEN_STATE/lock"
export QWEN_STATE_FILE="${QWEN_STATE_FILE:-$QWEN_STATE/state.json}"
QWEN_LOG="${QWEN_LOG:-${MYAI_HOME:-$HOME/.myai}/logs/qwen_lane.log}"
AGENT_LABEL="com.myai.qwen-lane"
AGENT_PLIST="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}/$AGENT_LABEL.plist"
QWEN_CLAUDE_DIR="${CLAUDE_QWEN_DIR:-$HOME/.claude-qwen}"
POLL="${QWEN_POLL:-15}"
COOLDOWN="${QWEN_COOLDOWN:-20}"
GOV_POLL="${QWEN_GOV_POLL:-30}"
RUNNER="$SCRIPT_DIR/lib/qwen_job_run.py"

say() { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*"; }
# nap: a sleep the stop signal interrupts at once (bash defers traps until a
# FOREGROUND command returns; `wait` on a background sleep returns immediately).
nap() { sleep "$1" & wait $! 2>/dev/null; }
# lane_state k=v ... → merge into the state file the chat statusLine reads.
lane_state() { python3 "$RUNNER" state "$@" >/dev/null 2>&1 || true; }

# ── quiet governor ────────────────────────────────────────────────────────────
qwen_on_battery() {
  [ "${QWEN_IGNORE_BATTERY:-0}" = 1 ] && return 1
  command -v pmset >/dev/null 2>&1 || return 1
  pmset -g batt 2>/dev/null | grep -q "'Battery Power'"
}

# Hot = macOS has recorded a thermal or performance warning level, or is
# capping CPU speed. "No ... level has been recorded" is the nominal case.
qwen_thermal_hot() {
  command -v pmset >/dev/null 2>&1 || return 1
  pmset -g therm 2>/dev/null | awk '
    /[Nn]o .*has been recorded/ { next }
    /[Ww]arning level/ { hot = 1 }
    /CPU_Speed_Limit/ { split($0, a, "="); if (a[2] + 0 < 100) hot = 1 }
    END { exit hot ? 0 : 1 }'
}

qwen_governor_wait() {
  local said=""
  while :; do
    if qwen_on_battery; then
      [ "$said" = batt ] || { say "paused — on battery (waiting for AC; QWEN_IGNORE_BATTERY=1 overrides)"; lane_state state=paused "reason=on battery" "since=$(date +%s)"; }; said=batt
    elif qwen_thermal_hot; then
      [ "$said" = hot ] || { say "paused — Mac is warm (thermal warning recorded); waiting to cool"; lane_state state=paused "reason=Mac is warm" "since=$(date +%s)"; }; said=hot
    else
      [ -n "$said" ] && { say "resumed — on AC and thermally nominal"; lane_state state=idle "since=$(date +%s)"; }
      return 0
    fi
    [ "${QWEN_ONCE:-0}" = 1 ] && return 1
    nap "$GOV_POLL"
  done
}

# ── single instance ───────────────────────────────────────────────────────────
qwen_lock_pid() { cat "$LOCK/pid" 2>/dev/null || true; }
qwen_running() { local p; p="$(qwen_lock_pid)"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
qwen_try_lock() {
  mkdir -p "$QWEN_STATE" 2>/dev/null
  if ! mkdir "$LOCK" 2>/dev/null; then
    qwen_running && return 1
    rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || return 1   # stale (dead pid)
  fi
  echo "$$" > "$LOCK/pid"
}
qwen_take_lock() {
  qwen_try_lock && return 0
  [ "${QWEN_WAIT_LOCK:-0}" = 1 ] || return 1
  say "another qwen lane holds the lock (pid $(qwen_lock_pid)) — waiting to take over when it exits"
  while ! qwen_try_lock; do nap "$POLL"; done
}

qwen_gateway_env() {
  if [ -z "${GATEWAY_LOCAL_TOKEN:-}" ] && [ -f "$SCRIPT_DIR/lib/gateway.sh" ]; then
    # shellcheck source=scripts/lib/gateway.sh
    . "$SCRIPT_DIR/lib/gateway.sh" 2>/dev/null || true
  fi
  export GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
}

qwen_register() {
  [ -f "$SCRIPT_DIR/lib/session_registry.sh" ] || return 0
  # shellcheck source=scripts/lib/session_registry.sh
  . "$SCRIPT_DIR/lib/session_registry.sh" 2>/dev/null || return 0
  command -v session_registry_write >/dev/null 2>&1 || return 0
  session_registry_write "$(hostname -s 2>/dev/null) - qwen" qwen ai_management "$HOST_LC" "" "$$" "$QWEN_ADDR" 2>/dev/null || true
}

# ── the loop ──────────────────────────────────────────────────────────────────
qwen_run() {
  qwen_take_lock || { say "already running (pid $(qwen_lock_pid)) — one qwen lane at a time"; return 1; }
  trap 'rm -rf "$LOCK"; lane_state state=down "since=$(date +%s)"; say "qwen lane stopped"; exit 0' INT TERM
  trap 'rm -rf "$LOCK"' EXIT
  export MYAI_SESSION_PROFILE=qwen
  qwen_gateway_env
  qwen_register
  lane_state state=idle "since=$(date +%s)" "pid=$$" "addr=$QWEN_ADDR" "model=${QWEN_MODEL:-qwen3:8b}"
  say "qwen lane up — mailbox $QWEN_ADDR · model ${QWEN_MODEL:-qwen3:8b} · files from $QWEN_REPO_ROOT · cool-down ${COOLDOWN}s"
  local idle_said=0 rc
  while :; do
    qwen_governor_wait || return 0
    python3 "$RUNNER" process 2>&1 | while IFS= read -r line; do say "$line"; done
    rc=${PIPESTATUS[0]}
    case "$rc" in
      0) idle_said=0
         [ "${QWEN_ONCE:-0}" = 1 ] && return 0
         say "cooling ${COOLDOWN}s"; nap "$COOLDOWN" ;;
      1) [ "$idle_said" = 1 ] || { say "idle — waiting for jobs (scripts/qwen_job.sh)"; lane_state state=idle; }; idle_said=1
         [ "${QWEN_ONCE:-0}" = 1 ] && return 0
         nap "$POLL" ;;
      *) lane_state state=retrying "reason=gateway unreachable or reply failed" "since=$(date +%s)"
         [ "${QWEN_ONCE:-0}" = 1 ] && return 2
         nap "$GOV_POLL" ;;
    esac
  done
}

qwen_start() {
  if qwen_running; then echo "qwen lane already running (pid $(qwen_lock_pid))"; return 0; fi
  if [ "${1:-}" = --headless ]; then
    mkdir -p "$(dirname "$QWEN_LOG")"
    nohup bash "$SCRIPT_DIR/qwen_lane.sh" run >> "$QWEN_LOG" 2>&1 < /dev/null &
    echo "qwen lane started headless (pid $!) — log $QWEN_LOG · survives neither reboot nor crash: use install-agent for that"
    return 0
  fi
  # shellcheck source=scripts/lib/iterm_tab.sh
  . "$SCRIPT_DIR/lib/iterm_tab.sh"
  local tty
  if tty="$(iterm_open_tab "$REPO_ROOT" "bash '$SCRIPT_DIR/qwen_lane.sh' run" 8)"; then
    echo "qwen lane started in a visible iTerm tab ($tty)"
  else
    echo "qwen_lane: could not open an iTerm tab — run it yourself in a terminal: bash '$SCRIPT_DIR/qwen_lane.sh' run" >&2
    return 1
  fi
}

# The agent always runs the MAIN checkout's script, so removing a worktree can
# never strand it.
qwen_agent_script() {
  local m; m="$(qwen_main_checkout)/scripts/qwen_lane.sh"
  [ -f "$m" ] && echo "$m" || echo "$SCRIPT_DIR/qwen_lane.sh"
}

qwen_render_agent() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AGENT_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$(qwen_agent_script)</string><string>run</string></array>
  <key>WorkingDirectory</key><string>$(qwen_main_checkout)</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>QWEN_WAIT_LOCK</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$QWEN_LOG</string>
  <key>StandardErrorPath</key><string>$QWEN_LOG</string>
</dict>
</plist>
EOF
}

qwen_install_agent() {
  mkdir -p "$(dirname "$AGENT_PLIST")" "$(dirname "$QWEN_LOG")"
  local new; new="$(qwen_render_agent)"
  if [ -f "$AGENT_PLIST" ] && [ "$(cat "$AGENT_PLIST")" = "$new" ]; then
    echo "qwen lane agent: $AGENT_PLIST already current"
  else
    printf '%s\n' "$new" > "$AGENT_PLIST"; echo "qwen lane agent: wrote $AGENT_PLIST"
  fi
  launchctl unload "$AGENT_PLIST" >/dev/null 2>&1 || true
  if launchctl load "$AGENT_PLIST" >/dev/null 2>&1; then
    echo "qwen lane agent: loaded — runs headless now and at every login (KeepAlive); log $QWEN_LOG"
  else
    echo "qwen lane agent: WARN — launchctl load failed; it starts at next login" >&2
  fi
  qwen_running && echo "  a lane is already running (pid $(qwen_lock_pid)); the agent waits and takes over when it exits"
  echo "  journal it: scripts/config_journal.sh note $AGENT_PLIST \"qwen lane runner, headless, this Mac only\""
}

qwen_uninstall_agent() {
  [ -f "$AGENT_PLIST" ] || { echo "qwen lane agent: not installed"; return 0; }
  launchctl unload "$AGENT_PLIST" >/dev/null 2>&1 || true
  rm -f "$AGENT_PLIST"; echo "qwen lane agent: removed (the runner stops with it)"
}

# install-statusline: merge (never replace) a statusLine into the claude-qwen
# profile so the lane shows INSIDE the operator's chat. Keeps every other key.
qwen_install_statusline() {
  local f="$QWEN_CLAUDE_DIR/settings.json" cmd
  cmd="bash '$(qwen_main_checkout)/scripts/qwen_statusline.sh'"
  mkdir -p "$QWEN_CLAUDE_DIR"
  F="$f" CMD="$cmd" python3 - <<'PYX'
import json, os, shutil
f, cmd = os.environ["F"], os.environ["CMD"]
try:
    cur = json.load(open(f))
except (OSError, ValueError):
    cur = {}
want = {"type": "command", "command": cmd, "padding": 0}
if cur.get("statusLine") == want:
    print("qwen statusLine: already current in %s" % f)
else:
    if os.path.exists(f):
        shutil.copyfile(f, f + ".bak")
    cur["statusLine"] = want
    tmp = f + ".tmp"
    json.dump(cur, open(tmp, "w"), indent=2)
    os.replace(tmp, f)
    print("qwen statusLine: set in %s (previous copy: settings.json.bak)" % f)
PYX
  echo "  journal it: scripts/config_journal.sh note $f \"qwen lane statusLine for the claude-qwen chat\""
}

qwen_status() {
  if qwen_running; then echo "qwen lane: RUNNING (pid $(qwen_lock_pid)) · mailbox $QWEN_ADDR"
  else echo "qwen lane: stopped · mailbox $QWEN_ADDR (start: scripts/qwen_lane.sh install-agent)"; fi
  if [ -f "$AGENT_PLIST" ]; then echo "agent: $AGENT_LABEL installed ($AGENT_PLIST)"
  else echo "agent: not installed (scripts/qwen_lane.sh install-agent)"; fi
  echo "chat statusLine: $(bash "$SCRIPT_DIR/qwen_statusline.sh" </dev/null 2>/dev/null)"
  qwen_gateway_env
  local next; next="$(python3 "$RUNNER" next 2>/dev/null | tail -1)"
  echo "next queued job: ${next:-none}"
  if qwen_on_battery; then echo "governor: on battery → paused"
  elif qwen_thermal_hot; then echo "governor: thermal warning → paused"
  else echo "governor: AC + thermally nominal → ready"; fi
}

qwen_stop() {
  qwen_running || { echo "qwen lane: not running"; return 0; }
  local p; p="$(qwen_lock_pid)"; kill "$p" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$p" 2>/dev/null || { echo "qwen lane: stopped"; return 0; }; sleep 1; done
  echo "qwen lane: still running after 10s (mid-job?) — it stops after the current job" >&2; return 1
}

# Fleet roles: a role whose profile says local_llm=off (home, 16 GB) never
# runs the lane or loads a model. Jobs for it route to an office Mac's qwen
# mailbox (scripts/qwen_job.sh picks it).
qwen_local_llm_refused() {
  # shellcheck source=scripts/lib/fleet_role.sh
  [ -f "$SCRIPT_DIR/lib/fleet_role.sh" ] && . "$SCRIPT_DIR/lib/fleet_role.sh"
  command -v fleet_local_llm_allowed >/dev/null 2>&1 || return 1
  fleet_local_llm_allowed && return 1
  echo "qwen_lane: this Mac is role $(fleet_my_role) (profile local_llm=off) — no local LLM here; jobs go to $(fleet_qwen_host)/qwen" >&2
  return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-status}" in
    run|start|install-agent) qwen_local_llm_refused && exit 3 ;;
  esac
  case "${1:-status}" in
    start)  qwen_start "${2:-}" ;;
    install-agent)      qwen_install_agent ;;
    uninstall-agent)    qwen_uninstall_agent ;;
    install-statusline) qwen_install_statusline ;;
    run)    qwen_run ;;
    status) qwen_status ;;
    stop)   qwen_stop ;;
    -h|--help) sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//' ;;
    *) echo "usage: qwen_lane.sh install-agent|uninstall-agent|install-statusline|start [--headless]|run|status|stop" >&2; exit 2 ;;
  esac
fi
