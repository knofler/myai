#!/usr/bin/env bash
# sleep_guard.sh — keep this Mac's sleep/lock posture correct WITHOUT anyone
# having to remember it, and make any drift loud instead of silent.
#
# WHY THIS EXISTS. The target posture on the operator's machines is a specific,
# non-obvious combination (settled 2026-09-12, twice the hard way):
#
#   SleepDisabled 1                 lid close must NOT sleep the Mac, or every
#                                   phone doorway / remote websocket dies.
#   PreventUserIdleDisplaySleep 0   the display MUST still be allowed to sleep,
#                                   because macOS only starts the screen-lock
#                                   countdown once the display sleeps or the
#                                   saver starts. Holding `caffeinate -d` once
#                                   left this Mac unlockable for 15h43m.
#   no `caffeinate -dimsu` holder   the legacy flag set that caused exactly that.
#   screenLock delay > 0            the lock itself is actually armed.
#
# Two of those four are ROOT settings that survive reboot, so the failure mode
# is not "wrong today" — it is "silently reverted by an OS update / migration /
# a stray `pmset -a disablesleep 0` months from now", noticed only when a night
# of scheduled work is lost to a sleeping Mac. The operator's instruction was
# explicit: "i will not remember it all the time, and this mac should not sleep
# without me knowing."
#
# POWER SOURCE (incident 2026-10-21). "Never sleep" is right on the charger and
# wrong in a bag: the first daemon asserted `disablesleep 1` whatever the power
# source, and office-mac ran hot with its lid closed on battery until it drained
# overnight. Operator rule: "on battery, lid closed state, put it to sleep in
# 10 mins, unless advised to override".
#
# NO LID DETECTION (incident 2026-10-23). The second daemon decided on the lid
# (ioreg AppleClamshellState) and kept disablesleep 1 until the lid had been
# closed 10 min. That probe read `lid=open` on every tick from 18:20 to 08:20
# with the lid shut, so sleep was never released and office-mac drained 100% → 2%
# for a third night. The posture now depends on the power source alone:
#   AC power                       disablesleep 1 (lid close never sleeps).
#   battery, no override           disablesleep 0 — macOS sleeps natively on lid
#                                  close (and on idle), nothing to detect.
#   --stay-awake 2h                disablesleep 1 on battery too, TIME-BOXED
#                                  (max 12h), never permanent.
#
# CLOSED-LID BACKSTOP (live lid test 2026-10-23 13:28). macOS evaluates
# clamshell sleep only AT the close: unplug, then shut the lid before the next
# tick, and the close lands while disablesleep is still 1 — the Mac stays awake
# (battery idle sleep is 120 min, and agent caffeinates keep resetting it). So
# on battery with no override, a lid that READS closed for SLEEPGUARD_GRACE_SECS
# (default 5 min) gets `pmset sleepnow`. The lid probe is a backstop only — the
# posture above never depends on it, so a misread `open` is no worse than
# without the backstop. The timer resets on AC, an override, the lid opening,
# and any wake from sleep (a heartbeat gap): a dark wake (Remote Control
# traffic) restarts the 5 minutes instead of sleeping the Mac instantly.
#
# So the guarantee is split in two:
#   1. ENFORCEMENT — a root LaunchDaemon runs `--tick` every 60s and at boot
#      (`--install-daemon`, one sudo, once per machine).
#   2. VISIBILITY  — `--oneline` feeds a SessionStart hook, so every `agent mode`
#      boot states the posture and shouts if it has drifted.
#
# HOW IT RUNS. The daemon is a long-lived loop (`--daemon`: tick, sleep 60,
# forever) under KeepAlive, and every tick writes a heartbeat file.
# `--check`/`--oneline` read it and FAIL when the last tick is over 3 min old:
# a stale daemon is loud, not silent. It supersedes the first power-aware
# daemon (`--tick` on launchd StartInterval=60), which works but gives no way
# to see when it last ran.
#
# The daemon runs a ROOT-OWNED COPY of this script (/usr/local/libexec/
# myai-sleepguard), installed by --install-daemon, never the repo file: this
# repo lives in Dropbox, and a root daemon must not execute a file that Dropbox
# can rewrite, conflict-copy or remove. Re-run --install-daemon after changing
# this script. Its state (stay-awake-until, lid-closed-since, heartbeat) lives in the
# root-owned /var/db/myai-sleepguard.
#
# Usage:  sleep_guard.sh [--check]      full report; rc 0 healthy, 1 drifted
#         sleep_guard.sh --oneline      single line for the boot banner
#         sleep_guard.sh --daemon       the enforcement loop the LaunchDaemon runs (root)
#         sleep_guard.sh --tick         one enforcement pass (root)
#         sleep_guard.sh --stay-awake 2h|90m|off   time-boxed override (root, max 12h)
#         sleep_guard.sh --plist        print the LaunchDaemon plist
#         sleep_guard.sh --install-daemon    install it (needs root)
#         sleep_guard.sh --uninstall-daemon  remove it (needs root)
set -uo pipefail

LABEL="com.myai.sleepguard"
PLIST="${SLEEPGUARD_PLIST:-/Library/LaunchDaemons/${LABEL}.plist}"
LIBEXEC="/usr/local/libexec/myai-sleepguard"
LEGACY="caffeinate -dimsu"
# Test seams only (SLEEPGUARD_PLIST above, these below): launchd gives the
# daemon a clean environment, so in production they always take their defaults.
STATE_DIR="${SLEEPGUARD_STATE_DIR:-/var/db/myai-sleepguard}"
LOOP_SECS="${SLEEPGUARD_INTERVAL:-60}"           # --daemon: seconds between ticks
MAX_TICKS="${SLEEPGUARD_MAX_TICKS:-0}"           # --daemon: stop after N ticks (tests; 0 = forever)
LID_GRACE_SECS="${SLEEPGUARD_GRACE_SECS:-300}"   # battery + lid reads closed this long → sleepnow
WAKE_GAP_SECS=$((LOOP_SECS * 3))                 # a heartbeat older than this = the Mac was asleep
HEARTBEAT_STALE_SECS=180    # --check fails when the last tick is older than this
HEARTBEAT_LOG_SECS=900      # a "still alive" log line at most this often
MAX_STAY_AWAKE_SECS=43200   # an override can never exceed 12h
now() { echo "${SLEEPGUARD_NOW:-$(date +%s)}"; }

# --- probes (each echoes a value; never fails the script) --------------------
#
# DESIGN NOTE — what is and is not a drift signal.
# The obvious probe, `pmset -g assertions | grep PreventUserIdleDisplaySleep`,
# is USELESS as a gate: powerd itself holds that assertion (as
# InternalPreventDisplaySleep / com.apple.powermanagement.delayDisplayOff, with
# a timeout) the entire time the screen is simply awake and in use. Gating on it
# reports DRIFT on a perfectly healthy machine, and a guard that cries wolf is
# worse than no guard — the operator learns to scroll past the banner.
#
# So the checks split by lifetime:
#   PERSISTENT CONFIG (gates, rc 1)  — SleepDisabled, the displaysleep timeout,
#       the screen-lock delay, and a caffeinate holding the forbidden -d/-u.
#       These stay wrong until someone fixes them.
#   TRANSIENT HOLDERS (info only)    — an app preventing display sleep right now
#       (Chrome on a video call legitimately does this). Reported, never a gate.

sleep_disabled() { pmset -g 2>/dev/null | awk '/SleepDisabled/{print $2; found=1} END{if(!found) print "?"}'; }

# Configured display-sleep timeout in minutes. 0 means "never" => never locks.
display_timeout() {
  pmset -g 2>/dev/null | awk '/^[[:space:]]*displaysleep/{print $2; found=1; exit} END{if(!found) print "?"}'
}

# Who, if anyone, is holding the display awake at this instant. Informational.
display_holder() {
  pmset -g 2>/dev/null \
    | sed -n 's/.*display sleep prevented by \(.*\)).*/\1/p' | head -1
}

# The 2026-09-12 incident, generalised: ANY caffeinate carrying -d (display) or
# -u (declare user active). Matched per-pid on the real argv so this function
# can never match the shell command line that is running the check itself.
forbidden_caffeinate() {
  local pid args
  for pid in $(pgrep -x caffeinate 2>/dev/null); do
    args="$(ps -o args= -p "$pid" 2>/dev/null)"
    case "$args" in
      *caffeinate*) : ;;
      *) continue ;;
    esac
    # Only inspect the flag cluster(s), so a -t value or a path cannot false-match.
    if printf '%s' "$args" | grep -Eq '(^|[[:space:]])-[a-z]*[du][a-z]*([[:space:]]|$)'; then
      echo "$pid:$args"; return 0
    fi
  done
  return 0
}

legacy_holder() { pgrep -f "$LEGACY" 2>/dev/null | head -1; }

lock_delay() {
  # sysadminctl prints to STDERR, with a timestamp prefix. Digits only.
  sysadminctl -screenLock status 2>&1 \
    | awk '/screenLock delay is/{for(i=1;i<=NF;i++) if($i ~ /^[0-9]+$/) {print $i; found=1; exit}} END{if(!found) print "?"}'
}


# none | power-aware | interval | legacy.
#   legacy   — the hourly always-disablesleep-1 daemon (kept a closed Mac awake
#              on battery — 2026-10-21 incident).
#   interval — the first power-aware daemon (--tick on StartInterval=60). It
#              enforces correctly; it is only superseded by the KeepAlive loop
#              + heartbeat, so it is reported as info, not drift.
daemon_kind() {
  [ -f "$PLIST" ] || { echo none; return; }
  if ! grep -q "$LIBEXEC" "$PLIST" 2>/dev/null; then echo legacy
  elif grep -q "<string>--daemon</string>" "$PLIST" 2>/dev/null; then echo power-aware
  else echo interval; fi
}

# Seconds since the daemon's last tick, or "never".
heartbeat_age() {
  local t
  t="$(awk '{print $1; exit}' "$STATE_DIR/heartbeat" 2>/dev/null)"
  case "$t" in ''|*[!0-9]*) echo never; return ;; esac
  echo $(( $(now) - t ))
}

# AC | battery. Desktops and unknown output count as AC (the safe-awake side).
power_source() {
  if pmset -g batt 2>/dev/null | head -1 | grep -q "'Battery Power'"; then echo battery; else echo AC; fi
}

# closed | open. No clamshell (desktop) = open. Unreliable (read `open` all
# night with the lid shut, 2026-10-23), so it only ever feeds the backstop.
lid_state() {
  if ioreg -r -k AppleClamshellState -d 4 2>/dev/null | grep -q '"AppleClamshellState" = Yes'; then echo closed; else echo open; fi
}

# Seconds the backstop has seen the lid closed, or "" when no timer runs.
lid_closed_for() {
  local since
  since="$(cat "$STATE_DIR/lid-closed-since" 2>/dev/null)" || true
  case "$since" in ''|*[!0-9]*) return 0 ;; esac
  echo $(( $(now) - since ))
}

# Seconds left on a --stay-awake override, or 0.
stay_awake_left() {
  local until n
  until="$(cat "$STATE_DIR/stay-awake-until" 2>/dev/null)"
  case "$until" in ''|*[!0-9]*) echo 0; return ;; esac
  n="$(now)"
  if [ "$until" -gt "$n" ]; then echo $((until - n)); else echo 0; fi
}

# The SleepDisabled value the posture requires: 1 on AC or under a --stay-awake
# override, 0 on battery. Shared by enforce and the checks so they never disagree.
wanted_sd() { if [ "$1" = AC ] || [ "$2" -gt 0 ]; then echo 1; else echo 0; fi; }

# The --oneline problem token for a SleepDisabled mismatch, or nothing.
sd_problem() {
  local src="$1" left="$2" sd="$3"
  [ "$sd" = "$(wanted_sd "$src" "$left")" ] && return 0
  if [ "$src" = AC ]; then echo "lid-close-sleeps-on-AC"
  elif [ "$left" -gt 0 ]; then echo "stay-awake-not-applied"
  else echo "battery-never-sleeps"; fi
}

log_tick() { echo "$(date '+%Y-%m-%d %H:%M:%S') sleep-guard: $*"; }

TICKS=0

# One enforcement pass, then a heartbeat: "<epoch> ticks=<n> power=… …".
# The heartbeat is written on EVERY tick (it is what --check ages); the log
# gets a line on every change plus a "still alive" line every 15 min.
tick() {
  local n last
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  enforce
  TICKS=$((TICKS + 1)); n="$(now)"
  echo "$n ticks=$TICKS $TICK_STATE" > "$STATE_DIR/heartbeat"
  last="$(cat "$STATE_DIR/last-alive-log" 2>/dev/null)" || true   # absent on the first tick; must not trip errexit
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  if [ $((n - last)) -ge "$HEARTBEAT_LOG_SECS" ]; then
    log_tick "alive — $TICK_STATE"
    echo "$n" > "$STATE_DIR/last-alive-log"
  fi
}

# The long-lived loop the LaunchDaemon runs under KeepAlive.
daemon_loop() {
  log_tick "daemon started (pid $$, tick every ${LOOP_SECS}s)"
  while :; do
    tick
    if [ "$MAX_TICKS" -gt 0 ] && [ "$TICKS" -ge "$MAX_TICKS" ]; then return 0; fi
    sleep "$LOOP_SECS"
  done
}

# The posture decision: power source + override only, never the lid (see NO LID
# DETECTION above). Idempotent; pmset writes only when the value must change.
# Releasing disablesleep hands lid-close sleep back to macOS; the closed-lid
# backstop below covers the one case macOS misses.
enforce() {
  local src sd left want lid
  src="$(power_source)"; sd="$(sleep_disabled)"; left="$(stay_awake_left)"
  want="$(wanted_sd "$src" "$left")"; lid="$(lid_state)"
  TICK_STATE="power=$src sleepdisabled=$sd stay-awake=${left}s lid=$lid"
  if [ "$sd" != "$want" ]; then
    pmset -a disablesleep "$want"
    log_tick "disablesleep $want (power=$src stay-awake=${left}s)"
  fi
  lid_backstop "$src" "$left" "$lid"
  return 0
}

# CLOSED-LID BACKSTOP (see header). Battery + no override + lid reads closed
# for LID_GRACE_SECS → sleepnow. Runs before tick() writes this tick's
# heartbeat, so the heartbeat it reads is the PREVIOUS tick's.
lid_backstop() {
  local src="$1" left="$2" lid="$3" n since prev
  n="$(now)"
  if [ "$src" != battery ] || [ "$left" -gt 0 ] || [ "$lid" != closed ]; then
    rm -f "$STATE_DIR/lid-closed-since"; return 0
  fi
  prev="$(awk '{print $1; exit}' "$STATE_DIR/heartbeat" 2>/dev/null)" || true
  case "$prev" in ''|*[!0-9]*) prev="$n" ;; esac
  since="$(cat "$STATE_DIR/lid-closed-since" 2>/dev/null)" || true
  case "$since" in ''|*[!0-9]*) since="" ;; esac
  if [ -n "$since" ] && [ $((n - prev)) -gt "$WAKE_GAP_SECS" ]; then
    # The Mac slept since the last tick: a dark wake restarts the buffer.
    since=""
    log_tick "woke on battery, lid closed (no tick for $((n - prev))s) — buffer restarts"
  fi
  if [ -z "$since" ]; then
    echo "$n" > "$STATE_DIR/lid-closed-since"
    log_tick "battery + lid closed — sleeping in $((LID_GRACE_SECS / 60)) min unless AC, an override, or the lid opens"
    return 0
  fi
  if [ $((n - since)) -ge "$LID_GRACE_SECS" ]; then
    rm -f "$STATE_DIR/lid-closed-since"
    log_tick "battery + lid closed for $(((n - since) / 60)) min — sleeping now"
    pmset sleepnow
  fi
  return 0
}

# --- plist -------------------------------------------------------------------

emit_plist() {
  cat <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <!-- A ROOT-OWNED copy installed by --install-daemon, NOT the repo script:
       this repo lives in Dropbox and a root daemon must not execute a
       Dropbox-synced file. -->
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${LIBEXEC}</string>
    <string>--daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <!-- A long-lived loop (tick, sleep 60) kept alive by launchd, writing a
       heartbeat every tick so a stalled daemon is visible in --check. If the
       loop ever exits, launchd restarts it after ThrottleInterval. -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/var/log/${LABEL}.log</string>
  <key>StandardErrorPath</key><string>/var/log/${LABEL}.log</string>
</dict>
</plist>
PLIST_EOF
}

# --- modes -------------------------------------------------------------------

case "${1:---check}" in
  --plist) emit_plist; exit 0 ;;

  --tick) tick; exit 0 ;;

  --daemon) daemon_loop; exit 0 ;;

  --stay-awake)
    dur="${2:-}"
    if [ "$(id -u)" != 0 ] && [ -z "${SLEEPGUARD_STATE_DIR:-}" ]; then
      echo "sleep-guard: --stay-awake needs root:  sudo bash $0 --stay-awake ${dur:-2h}"; exit 2
    fi
    mkdir -p "$STATE_DIR"
    case "$dur" in
      off) rm -f "$STATE_DIR/stay-awake-until"; echo "sleep-guard: stay-awake override cleared."; exit 0 ;;
      *[0-9]h) secs=$(( ${dur%h} * 3600 )) ;;
      *[0-9]m) secs=$(( ${dur%m} * 60 )) ;;
      *) echo "sleep-guard: --stay-awake takes a duration like 2h or 90m (max 12h), or 'off'"; exit 2 ;;
    esac
    case "${dur%[hm]}" in ''|*[!0-9]*) echo "sleep-guard: bad duration '$dur'"; exit 2 ;; esac
    if [ "$secs" -le 0 ] || [ "$secs" -gt "$MAX_STAY_AWAKE_SECS" ]; then
      echo "sleep-guard: stay-awake must be between 1m and 12h (got '$dur')"; exit 2
    fi
    echo $(( $(now) + secs )) > "$STATE_DIR/stay-awake-until"
    echo "sleep-guard: staying awake on battery (lid close will not sleep) for $dur (until $(date -r $(( $(now) + secs )) '+%H:%M' 2>/dev/null || echo "+$dur"))."
    exit 0
    ;;

  --install-daemon)
    if [ "$(id -u)" != 0 ]; then
      echo "sleep-guard: --install-daemon needs root. Run this one-liner yourself:"
      echo "  sudo bash $0 --install-daemon"
      exit 2
    fi
    install -d -o root -g wheel -m 755 "$(dirname "$LIBEXEC")" "$STATE_DIR"
    install -o root -g wheel -m 755 "$0" "$LIBEXEC"
    emit_plist > "$PLIST"
    chown root:wheel "$PLIST"; chmod 644 "$PLIST"
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load  "$PLIST" 2>/dev/null || true
    echo "sleep-guard: installed $PLIST running $LIBEXEC --daemon (a KeepAlive loop, tick every 60s)."
    echo "  AC: lid close never sleeps. Battery: disablesleep 0, so macOS sleeps on lid close as normal;"
    echo "  a lid still closed on battery after $((LID_GRACE_SECS / 60)) min is put to sleep (backstop)."
    echo "  Override: sudo bash $0 --stay-awake 2h   (max 12h)"
    exit 0
    ;;

  --uninstall-daemon)
    if [ "$(id -u)" != 0 ]; then
      echo "sleep-guard: --uninstall-daemon needs root:  sudo bash $0 --uninstall-daemon"; exit 2
    fi
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST" "$LIBEXEC"
    rm -rf "$STATE_DIR"
    echo "sleep-guard: removed $PLIST. 'disablesleep' keeps its CURRENT value — set it by hand if you want it off:"
    echo "  sudo pmset -a disablesleep 0"
    exit 0
    ;;

  --oneline)
    sd="$(sleep_disabled)"; dt="$(display_timeout)"; fc="$(forbidden_caffeinate)"
    ld="$(lock_delay)"; dm="$(daemon_kind)"; dh="$(display_holder)"; src="$(power_source)"
    left="$(stay_awake_left)"
    problems=""
    # AC wants disablesleep 1, battery wants 0 (1 again under a --stay-awake override).
    sp="$(sd_problem "$src" "$left" "$sd")"
    [ -z "$sp" ] || problems="${problems}$sp "
    [ "$dm" != legacy ] || problems="${problems}old-daemon-never-sleeps-on-battery "
    if [ "$dm" = power-aware ]; then
      hb="$(heartbeat_age)"
      if [ "$hb" = never ]; then problems="${problems}daemon-never-ticked "
      elif [ "$hb" -gt "$HEARTBEAT_STALE_SECS" ]; then problems="${problems}daemon-stale(last-tick-${hb}s-ago) "; fi
    fi
    case "$dt" in 0|'?') problems="${problems}display-never-sleeps(no-lock) " ;; esac
    [ -z "$fc" ] || problems="${problems}caffeinate-blocks-display "
    case "$ld" in ''|0|'?') problems="${problems}screenlock-unarmed " ;; esac
    if [ -n "$problems" ]; then
      echo "SLEEP GUARD: DRIFTED — ${problems}(daemon: $dm) — run ./AI/scripts/sleep_guard.sh"
      exit 1
    fi
    if [ "$src" = battery ]; then
      lidtxt="on battery: lid close sleeps (${LID_GRACE_SECS}s closed-lid backstop)"
      [ "$left" -gt 0 ] && lidtxt="on battery: stay-awake override $((left / 60))m left"
    else
      lidtxt="on AC: lid-close safe"
    fi
    if [ -n "$dh" ]; then
      echo "sleep posture: OK ($lidtxt, lock armed ${ld}s, daemon $dm) — but '$dh' is holding the display awake, so it will not lock until that stops"
      exit 0
    fi
    hbtxt=""; [ "$dm" = power-aware ] && hbtxt=", last tick ${hb}s ago"
    echo "sleep posture: OK — $lidtxt, display sleeps ${dt}m, lock armed ${ld}s, enforcement daemon $dm$hbtxt"
    exit 0
    ;;

  --check|"")
    sd="$(sleep_disabled)"; dt="$(display_timeout)"; fc="$(forbidden_caffeinate)"
    lg="$(legacy_holder)"; ld="$(lock_delay)"; dm="$(daemon_kind)"; dh="$(display_holder)"
    src="$(power_source)"; left="$(stay_awake_left)"
    rc=0
    echo "SLEEP / LOCK POSTURE  ($(hostname -s), power: $src)"

    if [ "$src" = battery ] && [ "$left" -gt 0 ]; then
      if [ "$sd" = 1 ]; then
        echo "  ok    on battery with a stay-awake override — $((left / 60)) min left, then lid close sleeps again"
      else
        echo "  DRIFT stay-awake override active ($((left / 60)) min left) but SleepDisabled=$sd — lid close WILL sleep"
        echo "        the daemon applies it within 60s; if this persists: sudo pmset -a disablesleep 1"; rc=1
      fi
    elif [ "$src" = battery ]; then
      if [ "$sd" = 0 ]; then
        echo "  ok    on battery: SleepDisabled=0 — macOS sleeps this Mac on lid close, as designed"
        lc="$(lid_closed_for)"
        if [ -n "$lc" ]; then
          echo "        backstop: lid closed ${lc}s — sleeps at ${LID_GRACE_SECS}s unless AC, an override, or the lid opens"
        else
          echo "        backstop: a lid closed ${LID_GRACE_SECS}s on battery is put to sleep (covers a close before the guard's tick)"
        fi
        echo "        (to keep it awake: sudo bash ./AI/scripts/sleep_guard.sh --stay-awake 2h)"
      else
        echo "  DRIFT SleepDisabled=$sd on battery with no override — a closed lid will NOT sleep and the battery"
        echo "        drains (2026-10-23). The daemon releases it within 60s; if this persists:"
        echo "        sudo pmset -a disablesleep 0 ; then reinstall: sudo bash ./AI/scripts/sleep_guard.sh --install-daemon"; rc=1
      fi
    elif [ "$sd" = 1 ]; then echo "  ok    SleepDisabled=1 — on AC, closing the lid will NOT sleep this Mac"
    else echo "  DRIFT SleepDisabled=$sd on AC — lid close WILL sleep this Mac and kill every remote session"
         echo "        fix: sudo pmset -a disablesleep 1"; rc=1; fi

    case "$dt" in
      0|'?') echo "  DRIFT displaysleep=$dt — the display is set to NEVER sleep, so the screen can never lock"
             echo "        fix: sudo pmset -a displaysleep 10"; rc=1 ;;
      *)     echo "  ok    displaysleep=${dt}m — display sleeps, so the lock countdown can start" ;;
    esac

    if [ -z "$fc" ]; then echo "  ok    no caffeinate holding the forbidden -d/-u flags"
    else echo "  DRIFT a caffeinate is blocking DISPLAY sleep — this Mac cannot lock:"
         echo "        $fc"
         echo "        fix: ./AI/scripts/keep_awake.sh --release   (then restart it: keep_awake.sh)"; rc=1; fi

    [ -z "$lg" ] || { echo "  DRIFT legacy '$LEGACY' held by pid $lg"; rc=1; }

    case "$ld" in
      ''|0|'?') echo "  DRIFT screen lock not armed (delay='$ld') — set 'require password' in System Settings"; rc=1 ;;
      *)        echo "  ok    screen lock armed — ${ld}s after the display sleeps" ;;
    esac

    case "$dm" in
      power-aware)
        hb="$(heartbeat_age)"
        if [ "$hb" = never ]; then
          echo "  DRIFT power-aware daemon installed but it has NEVER ticked (no $STATE_DIR/heartbeat)"
          echo "        see: sudo launchctl print system/$LABEL ; sudo bash ./AI/scripts/sleep_guard.sh --install-daemon"; rc=1
        elif [ "$hb" -gt "$HEARTBEAT_STALE_SECS" ]; then
          echo "  DRIFT power-aware daemon is STALE — last tick ${hb}s ago (limit ${HEARTBEAT_STALE_SECS}s); a closed Mac on battery will NOT sleep"
          echo "        see: sudo launchctl print system/$LABEL ; tail /var/log/$LABEL.log ; reinstall: sudo bash ./AI/scripts/sleep_guard.sh --install-daemon"; rc=1
        else
          echo "  ok    power-aware daemon ticking — last tick ${hb}s ago: AC keeps lid close safe, battery lets lid close sleep (+${LID_GRACE_SECS}s backstop)"
        fi ;;
      interval) echo "  info  power-aware daemon (StartInterval) installed — superseded by the KeepAlive loop +"
              echo "        heartbeat; reinstall to get the freshness check:"
              echo "        sudo bash ./AI/scripts/sleep_guard.sh --install-daemon" ;;
      legacy) echo "  DRIFT the OLD daemon is installed: it forces disablesleep 1 even on battery, so a"
              echo "        closed Mac in a bag never sleeps (2026-10-21). Replace it:"
              echo "        sudo bash ./AI/scripts/sleep_guard.sh --install-daemon"; rc=1 ;;
      *) echo "  GAP   no enforcement daemon: 'disablesleep' survives reboot, but nothing RESTORES it if"
         echo "        an OS update or a stray 'pmset -a disablesleep 0' reverts it, and nothing sleeps"
         echo "        a closed Mac on battery."
         echo "        install once: sudo bash ./AI/scripts/sleep_guard.sh --install-daemon" ;;
    esac

    # Transient, informational — deliberately NOT a gate (see DESIGN NOTE above).
    if [ -n "$dh" ]; then
      echo "  info  right now '$dh' is preventing display sleep, so the Mac will"
      echo "        not lock while that continues. Legitimate for media/calls; if it is"
      echo "        unexpected, quit that app. Not a config fault."
    fi

    exit $rc
    ;;

  *) echo "sleep_guard.sh: unknown arg '$1' (try --check, --oneline, --tick, --stay-awake 2h, --plist, --install-daemon)"; exit 2 ;;
esac
