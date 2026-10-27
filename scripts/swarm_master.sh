#!/usr/bin/env bash
# swarm_master.sh — the `swarm master` keyword: ONE coordinator per MAC
# (plan/SWARM_COORDINATOR_PLAN.md row 2, spec plan/SWARM_COORDINATOR_SPEC.md §1;
# multi-Mac: plan/MULTI_MAC_SWARM_BRIEF.md).
#
# ACTIVE-ACTIVE (default, operator rule 2026-10-19): every Mac — fleet role or
# not — holds its own `swarm-coordinator:<host>`, so the office and home masters
# are each their own swarm master at the same time; failover, the ship lock and
# `tell coordinator` all stay on that Mac.
# FLEET MODE (`coordinator_mode fleet` in config/fleet_roles.txt, 2026-10-05):
# a Mac with a role shares `swarm-coordinator:fleet` (both gateways use one
# Atlas DB), so office + home can never elect two coordinators. The schedule
# there says which role coordinates when; a `take` from a Mac whose role is not
# scheduled needs --force, and stale-lease failover only happens from the
# scheduled role. Switching modes migrates a live holder on its next tick (same
# holder; the old lease is released with its fencing epoch).
#
# The coordinator holds the gateway KEYED lease `swarm-coordinator:<host>`
# (TTL 600s, holder "<host>/<lane>/<pid>" where <pid> is the claude/agy SESSION
# pid, fencing `epoch`). It assigns work, watches the workers and is the only
# session that merges (scripts/ship_lock.sh). Coordination order (sm_order):
# $SWARM_ORDER when set, else this device's configured master first
# (~/.myai/swarm/master.<host>, scripts/lib/swarm_master_config.sh), then the
# config's legacy `order=`, then the live sessions in the swarm repo by session
# start. No lane name is hard-coded.
#
# EVERY DEVICE HAS EXACTLY ONE MASTER (operator rule 2026-10-22): chosen at
# install (`myai swarm master set`); its session takes the lease itself at
# SessionStart (hooks/session/38-swarm-master-ensure.sh) and is nagged until its
# mail watcher runs (hooks/pre-tool/17-master-mail-watch.sh). `check` verifies
# both for boot and `myai doctor`.
#
# A swarm exists only when someone STARTED it: `take` writes the active marker
# ~/.myai/swarm/active.<host>; `stop` removes it. Without the marker nothing is
# elected automatically and the ship lock never engages — a normal
# single-session `ship it` is untouched.
#
# Usage:
#   swarm_master.sh [who]            holder, lane, epoch, age/stale, swarm active?,
#                                    the configured-master check line, and an
#                                    eligibility table per lane
#   swarm_master.sh check            this device's configured master holds the
#                                    lease AND has a live mail watcher?
#                                    rc 0 OK · 1 WARN · 2 RED (lease not held)
#                                    · 3 RED (no master configured while an
#                                    agent/profile exists; with none detected
#                                    yet — a fresh install — it is WARN, rc 1)
#   swarm_master.sh take [--force]   start/join the swarm as coordinator: acquire +
#                                    write the active marker. A VALID lease held by
#                                    another session is refused unless --force
#                                    (force-release with its epoch, then acquire) —
#                                    this is also the MANUAL HANDBACK (there is no
#                                    automatic one). Mails every other live lane
#                                    "new coordinator: <lane> (<host>), epoch N".
#   swarm_master.sh release [--force] step down. Only the holding SESSION may
#                                    release; --force is the operator override.
#   swarm_master.sh stop [--force]   end the swarm: release (holder only, unless
#                                    --force), remove the active marker, mail lanes.
#   swarm_master.sh tick             periodic + cheap + silent (once per
#                                    SWARM_TICK_EVERY=120s per session). Never
#                                    creates a lease from nothing:
#                                    (a) this session holds it → heartbeat;
#                                    (b) swarm active (marker) AND the lease doc
#                                        exists but is STALE AND this lane is the
#                                        first live, not-opted-out lane in order →
#                                        take it over + failover mail.
#                                    Not inside a claude/agy session → returns.
#                                    Every tick also renews this session's claims
#                                    (scripts/lib/claims.sh) and every 10th runs
#                                    the change journal (config_journal.sh scan).
#                                    It also renews this session's presence lease
#                                    lane:<host>:<lane> (SWARM_PRESENCE=0 off) —
#                                    what swarm_live reads as "idle" — and kicks
#                                    the PR snapshot writer in the background
#                                    (swarm_prs_snapshot.sh, self-rate-limited;
#                                    SWARM_PRS=0 off).
#   swarm_master.sh wrap-check [--wait [N]] [--since ISO]
#                                    coordinator only: which live lanes have a
#                                    wrap line STARTING "> <LANE> <date+time>" or
#                                    "> **(0) <date> … WRAP (<lane>" written since
#                                    this session's start (lease acquiredAt, or
#                                    --since); ONE "wrap up" mail
#                                    per unwrapped lane; --wait polls up to N min
#                                    (default 10); prints the fleet line to append
#                                    with handoff_append.sh (coordinator wraps last).
#   swarm_master.sh agy-loop <pid>   tick as agy every 150s while <pid> is still
#                                    agy (pid reuse safe); releases on exit.
#
# Who ticks: every Claude session's mail watcher (scripts/mail_watch.sh, one
# tick per poll, SWARM_TICK=1 default) and agy's pid-bound loop (started by
# scripts/agy_session.sh start). No extra processes for Claude sessions.
#
# Eligibility per lane: live (a session process exists — lanes_match) and not
# opted out (touch ~/.myai/swarm/unavailable.<lane>). An unreadable screen does
# NOT disqualify a lane; `who` shows responsiveness for information only.
#
# State: ~/.myai/swarm/coordinator.<host>.<lane>.<pid>.json — per SESSION —
# holds the holder + epoch this session acquired (fencing). SWARM_DIR overrides.
#
# bash 3.2-safe; safe under `set -euo pipefail`. Source with
# SWARM_MASTER_LIB_ONLY=1 for the functions (scripts/tests/test_swarm_master.sh
# stubs kl_call, the lanes_* touchpoints and _sm_tell).
set -u

SM_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=/dev/null
. "$SM_HERE/lib/session_registry.sh"
# shellcheck source=/dev/null
. "$SM_HERE/lib/session_lanes.sh"
# shellcheck source=/dev/null
. "$SM_HERE/lib/keyed_lease.sh"
# shellcheck source=/dev/null
. "$SM_HERE/lib/claims.sh"
# shellcheck source=/dev/null
. "$SM_HERE/lib/swarm_master_config.sh"

SWARM_DIR="${SWARM_DIR:-$HOME/.myai/swarm}"
SWARM_JOURNAL_EVERY="${SWARM_JOURNAL_EVERY:-10}"
SWARM_TTL="${SWARM_TTL:-600}"
SWARM_TICK_EVERY="${SWARM_TICK_EVERY:-120}"
SWARM_PRESENCE="${SWARM_PRESENCE:-1}"
SWARM_PRESENCE_TTL="${SWARM_PRESENCE_TTL:-600}"
SWARM_PRS="${SWARM_PRS:-1}"
# A lane with no mail watcher gets woken for mail older than this (seconds).
SWARM_DEAF_AFTER="${SWARM_DEAF_AFTER:-120}"
# Empty = derived per call (sm_order); set it to pin an explicit order.
SWARM_ORDER="${SWARM_ORDER:-}"

# ── identity ────────────────────────────────────────────────────────────────
sm_host()   { kl_host; }
sm_lane()   { session_profile; }
sm_key()    { kl_coord_key; }
# sm_pid → the claude/agy session pid this shell runs under; EMPTY when none
# (no $$ fallback: a script's own pid changes every run and would make every
# invocation a different "holder").
sm_pid()    { _lanes_self_pid; }
sm_holder() { local p; p="$(sm_pid)"; [ -n "$p" ] || return 1; printf '%s/%s/%s' "$(sm_host)" "$(sm_lane)" "$p"; }
sm_state_file() { printf '%s/coordinator.%s.%s.%s.json' "$SWARM_DIR" "$(sm_host)" "$(sm_lane)" "$(sm_pid)"; }
sm_marker() { kl_active_marker; }
sm_active() { [ -f "$(sm_marker)" ]; }

# sm_need_session — refuse a verb outside a claude/agy session.
sm_need_session() {
  [ -n "$(sm_pid)" ] && return 0
  echo "swarm master: not running inside a claude/agy session (no session pid found) — run it from the session, or set LANES_SELF_PID=<session pid>" >&2
  return 1
}

# Stubbable touchpoints.
_sm_now()   { date +%s; }
_sm_alive() { kill -0 "$1" 2>/dev/null; }
_sm_comm()  { ps -o comm= -p "$1" 2>/dev/null || true; }
_sm_sleep() { sleep "$1"; }
_sm_today() { date +%Y-%m-%d; }
# _sm_journal_scan — the change journal (scripts/config_journal.sh scan); its
# stdout (only unannounced changes) passes through. Stubbed in tests.
_sm_journal_scan() { bash "$SM_HERE/config_journal.sh" scan 2>/dev/null || true; }
# _sm_tell <lane> <message> — durable mail + live ping via tell.sh. Best-effort.
# _sm_tell <label> <message> [to] — durable mail + live ping via tell.sh; [to]
# pins the mailbox address (TELL_TO) when the label alone would resolve wider.
_sm_tell() {
  TELL_TO="${3:-}" bash "$SM_HERE/tell.sh" "$1" "$2" >/dev/null 2>&1 || true
}

# ── state file (per session) ────────────────────────────────────────────────
sm_state_write() { # <holder> <epoch>
  mkdir -p "$SWARM_DIR" 2>/dev/null || true
  printf '{"key":"%s","holder":"%s","epoch":%s,"lane":"%s","host":"%s","acquiredAt":%s}\n' \
    "$(sm_key)" "$1" "$2" "$(sm_lane)" "$(sm_host)" "$(_sm_now)" > "$(sm_state_file)"
  # Host-wide holder record: session_default_addrs gives ONLY this session the
  # <host>/coordinator address (scripts/lib/session_registry.sh).
  printf '%s\n' "$1" > "$(SWARM_DIR="$SWARM_DIR" session_coordinator_file)" 2>/dev/null || true
}
sm_state_get() { # <field> → value from this session's state file (empty if none)
  local f; f="$(sm_state_file)"
  [ -f "$f" ] || return 0
  kl_json "$(cat "$f" 2>/dev/null || true)" "$1"
}
sm_state_clear() {
  local cf
  rm -f "$(sm_state_file)" 2>/dev/null || true
  # Drop the coordinator address only if it is still ours (a newer holder may
  # already have rewritten it).
  cf="$(SWARM_DIR="$SWARM_DIR" session_coordinator_file)"
  if [ -f "$cf" ] && [ "$(head -1 "$cf" 2>/dev/null)" = "$(sm_holder 2>/dev/null)" ]; then
    rm -f "$cf" 2>/dev/null || true
  fi
}

sm_marker_write() { # <epoch>
  mkdir -p "$SWARM_DIR" 2>/dev/null || true
  printf '{"host":"%s","startedBy":"%s","epoch":%s,"at":%s}\n' "$(sm_host)" "$(sm_holder)" "$1" "$(_sm_now)" > "$(sm_marker)"
}

# ── eligibility ─────────────────────────────────────────────────────────────
sm_order()      { smc_order; }
sm_in_order()   { case " $(sm_order) " in *" $1 "*) return 0 ;; esac; return 1; }
sm_opted_out()  { [ -f "$SWARM_DIR/unavailable.$1" ]; }
# Operator rule (2026-10-04): only sessions in the swarm repo ($SWARM_REPO,
# default ai_management) can coordinate — a profile tab the operator opened
# in WEBSITE/AZURE/… is never eligible and never answers <host>/coordinator.
sm_repo()       { session_master_repo; }
sm_live()       { [ -n "$(lanes_match "$1" "$(sm_repo)" 2>/dev/null | grep . || true)" ]; }
sm_live_any()   { [ -n "$(lanes_match "$1" 2>/dev/null | grep . || true)" ]; }
# sm_lane_repos <lane> → comma list of the repos that lane's live sessions run in.
sm_lane_repos() {
  lanes_match "$1" 2>/dev/null | while IFS="$(printf '\t')" read -r _p _t _c cwd _l; do
    [ -n "$cwd" ] && _lanes_repo_of "$cwd"
  done | sort -u | paste -sd, - 2>/dev/null || true
}
# sm_my_repo_ok → 0 when THIS session runs in the swarm repo.
sm_my_repo_ok() {
  local cwd
  cwd="$(_lanes_cwd "$(sm_pid)" 2>/dev/null || true)"
  [ -n "$cwd" ] || cwd="$PWD"
  [ "$(_lanes_repo_of "$cwd")" = "$(sm_repo)" ]
}
# sm_responsive <lane> → 0 when any live session of <lane> reports a state
# other than "unknown". INFORMATIONAL (shown by `who`), never a disqualifier.
sm_responsive() {
  local rows row scr st
  rows="$(lanes_match "$1" "$(sm_repo)" 2>/dev/null || true)"
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    lanes_load "$row"
    scr="$(lanes_screen 40 2>/dev/null || true)"
    st="$(lanes_state "$scr" 2>/dev/null || true)"
    if [ -n "$st" ] && [ "$st" != unknown ]; then return 0; fi
  done <<EOF
$rows
EOF
  return 1
}
sm_eligible() { sm_in_order "$1" && ! sm_opted_out "$1" && sm_live "$1"; }

# sm_live_lanes → every lane (except "default") with a live interactive session.
sm_live_lanes() { lanes_candidates '*' 2>/dev/null | cut -f5 | grep -v '^default$' | sort -u || true; }

# sm_mail_targets → one "<label><TAB><address>" per OTHER live session on this
# Mac, every repo (2026-10-26: repo sessions — AZURE, WEBSITE, foh … — never
# heard who the master was and sent their reports to a worker). A swarm-repo
# session is told by lane (host/<lane>, its own address); a session in any
# other repo by repo id (host/<repo>, the address it watches —
# session_default_addrs). The master's own lane and bare `default` swarm-repo
# sessions are skipped; one mail per address.
sm_mail_targets() {
  local me mrepo host pid cwd lane repo
  me="$(sm_lane)"; mrepo="$(session_master_repo 2>/dev/null)"; host="$(sm_host)"
  lanes_candidates '*' 2>/dev/null | while IFS="$(printf '\t')" read -r pid _ _ cwd lane; do
    if [ -z "$pid" ] || [ -z "$lane" ]; then continue; fi
    repo=""; [ -n "$cwd" ] && repo="$(_lanes_repo_of "$cwd" 2>/dev/null)"
    if [ -z "$repo" ] || [ "$repo" = "$mrepo" ]; then
      case "$lane" in "$me"|default) continue ;; esac
      printf '%s\t%s/%s\n' "$lane" "$host" "$lane"
    else
      printf '%s\t%s/%s\n' "$repo" "$host" "$repo"
    fi
  done | awk -F'\t' '!seen[$2]++'
}

# sm_mail_lanes <message> — mail every OTHER live session (sm_mail_targets).
sm_mail_lanes() {
  local label to
  while IFS="$(printf '\t')" read -r label to; do
    [ -n "$label" ] && _sm_tell "$label" "$1" "$to"
  done <<EOF
$(sm_mail_targets)
EOF
  return 0
}
# sm_announce_text <epoch> → what every session is told about the master.
sm_announce_text() {
  printf 'new coordinator: %s (%s), epoch %s — %s is swarm master; send reports, blockers and merge-go to %s/%s (alias %s/coordinator)' \
    "$(sm_lane)" "$(sm_host)" "$1" "$(sm_lane)" "$(sm_host)" "$(sm_lane)" "$(sm_host)"
}
sm_announce() { sm_mail_lanes "$(sm_announce_text "$1")"; }

# sm_read_lease → sets L_PRESENT (yes|no) L_HOLDER L_EPOCH L_STALE L_AGE.
# rc 1 when the gateway can't answer.
# L_KEY = the key the reported lease lives under: this Mac's key (sm_key), or
# (during a migration) the other coordinator key when that is the one still VALID.
sm_read_lease() {
  local info state key first=1
  L_PRESENT=no; L_HOLDER=""; L_EPOCH=""; L_STALE=""; L_AGE=""; L_ACQ=""; L_KEY="$(sm_key)"
  for key in $(kl_coord_keys); do
    info="$(kl_coord_get "$key")" || { [ "$first" = 1 ] && return 1; continue; }
    first=0
    case "$info" in present*)
      # A later key only wins when it is VALID and nothing valid was found yet.
      if [ "$L_PRESENT" = yes ] && [ "$L_STALE" = false ]; then continue; fi
      if [ "$L_PRESENT" = yes ] && ! printf '%s' "$info" | awk -F'\t' '$4 == "false" { ok = 1 } END { exit ok ? 0 : 1 }'; then continue; fi
      # shellcheck disable=SC2034  # state is the "present" tag
      IFS="$(printf '\t')" read -r state L_HOLDER L_EPOCH L_STALE L_AGE L_ACQ <<EOF
$info
EOF
      L_PRESENT=yes; L_KEY="$key" ;;
    esac
  done
  return 0
}

# sm_acquire → 0 + state written + SM_EPOCH set; 1 refused (SM_HELD_BY set); 2 gateway down
sm_acquire() {
  local holder res acquired meta
  holder="$(sm_holder)" || return 1
  meta="$(printf '{"lane":"%s","host":"%s","pid":"%s"}' "$(sm_lane)" "$(sm_host)" "$(sm_pid)")"
  res="$(kl_call lease_acquire "$(kl_args "key=$(sm_key)" "holder=$holder" "leaseSeconds=$SWARM_TTL" "meta=$meta")")" || return 2
  acquired="$(kl_json "$res" acquired)"
  if [ "$acquired" = true ]; then
    SM_EPOCH="$(kl_json "$res" lease.epoch)"
    sm_state_write "$holder" "${SM_EPOCH:-1}"
    return 0
  fi
  SM_HELD_BY="$(kl_json "$res" heldBy.holder)"
  [ -n "$SM_HELD_BY" ] || SM_HELD_BY="$(kl_json "$res" error)"
  return 1
}

# sm_release_lease <holder> <epoch> [force] → 0 released, 1 not, 2 gateway down
# [key] defaults to the key the last sm_read_lease found (L_KEY), else sm_key.
sm_release_lease() {
  local res key="${4:-${L_KEY:-$(sm_key)}}"
  if [ "${3:-}" = force ]; then
    res="$(kl_call lease_release "$(kl_args "key=$key" "holder=$1" "force=true" "epoch=$2")")" || return 2
  else
    res="$(kl_call lease_release "$(kl_args "key=$key" "holder=$1" "epoch=$2")")" || return 2
  fi
  SM_REASON="$(kl_json "$res" reason)$(kl_json "$res" error)"
  [ "$(kl_json "$res" released)" = true ]
}

# ── verbs ───────────────────────────────────────────────────────────────────
sm_who() {
  local l live resp opt elig first="" rc=0 me repos order
  me="$(sm_holder 2>/dev/null || echo "$(sm_host)/$(sm_lane)/<no session>")"
  echo "swarm master — $(sm_host) (key $(sm_key), you are $me)"
  if kl_shared_mode; then
    local sched; sched="$(fleet_scheduled_role)"
    echo "  fleet: this Mac is role $(fleet_my_role) · shared fleet coordinator · scheduled now: ${sched:-open (any role)}$(fleet_coordinator_ok || printf ' — take here needs --force')"
  elif kl_fleet_mode; then
    echo "  fleet: this Mac is role $(fleet_my_role) · active-active — this Mac's own coordinator (per-host key)"
  fi
  if sm_active; then
    echo "  swarm: ACTIVE ($(sm_marker)) — failover on, ship lock on"
  else
    echo "  swarm: not active — nothing is elected automatically; start one with 'swarm master take'"
  fi
  if sm_read_lease; then
    if [ "$L_PRESENT" = yes ]; then
      if [ "$L_STALE" = true ]; then l="STALE (expired)"; else l="valid"; fi
      echo "  coordinator: $(kl_holder_lane "$L_HOLDER") ($L_HOLDER) · epoch $L_EPOCH · heartbeat ${L_AGE:-?}s ago · $l$([ "$L_KEY" != "$(sm_key)" ] && printf ' · legacy key %s (migrates on its next tick)' "$L_KEY")"
    else
      echo "  coordinator: none"
    fi
  else
    echo "  coordinator: UNKNOWN — gateway unreachable"; rc=1
  fi
  # Account budgets across the fleet (multi-Mac phase 2 ledger) — best effort.
  if kl_fleet_mode && [ "${SWARM_WHO_BUDGET:-on}" != off ] && [ -f "$SM_HERE/usage_reading.sh" ]; then
    local bl
    bl="$(USAGE_TIMEOUT=3 bash "$SM_HERE/usage_reading.sh" status 2>/dev/null)"
    if [ -n "$bl" ]; then echo "  budget (all Macs):"; printf '%s\n' "$bl" | sed 's/^/    /'; fi
  fi
  echo "  master: $(sm_check 2>&1 | head -1)"
  order="$(sm_order)"
  echo "  eligible: live sessions in repo $(sm_repo) only, in order: ${order:-(none — no master configured and no live session)}"
  printf '  %-8s %-5s %-24s %-11s %-10s %s\n' lane live repo responsive opted-out eligible
  for l in $order; do
    live=no; resp=no; opt=no; elig=no
    repos="$(sm_lane_repos "$l")"
    if sm_live "$l"; then live=yes; elif sm_live_any "$l"; then live="yes*"; fi
    if [ "$live" = yes ] && sm_responsive "$l"; then resp=yes; fi
    if sm_opted_out "$l"; then opt=yes; fi
    if [ "$live" = "yes*" ]; then
      elig="not eligible (repo)"
    elif [ "$live" = yes ] && [ "$opt" = no ]; then
      elig=yes
      if [ -z "$first" ]; then first="$l"; elig="yes  ← first in order"; fi
    fi
    printf '  %-8s %-5s %-24s %-11s %-10s %s\n' "$l" "$live" "${repos:--}" "$resp" "$opt" "$elig"
  done
  return "$rc"
}

# _sm_has_watcher <session-pid> → 0 when a scripts/mail_watch.sh runs under
# that session (scripts/lib/session_lanes.sh). Stubbed in tests.
_sm_has_watcher() { lanes_has_watcher "$1"; }

# sm_check — one line for boot phase 9c, `myai doctor` and `who`: does this
# device's CONFIGURED master hold the coordinator lease AND have a live mail
# watcher? rc 0 OK · 1 WARN · 2 RED (lease not held) · 3 RED (no master).
sm_check() {
  local lane desc hl hhost hpid
  if ! smc_exists; then
    # A fresh install with no agent yet has nothing to choose from (v1 G2: a
    # stranger's first `myai doctor` FAILed here) — warn, don't fail.
    if [ -z "$(smc_detect 2>/dev/null)" ]; then
      echo "WARN — no swarm master on $(sm_host) yet, and no agent or profile detected — after you install one, choose it: myai swarm master set"
      return 1
    fi
    echo "RED — no swarm master configured on $(sm_host) — fix: myai swarm master set"
    return 3
  fi
  lane="$(smc_master_lane)"
  desc="$(smc_master_agent) (lane $lane)"
  if ! sm_read_lease; then
    echo "WARN — master $desc: gateway unreachable, lease unknown"
    return 1
  fi
  if [ "$L_PRESENT" != yes ] || [ "$L_STALE" = true ]; then
    echo "RED — master $desc does not hold $(sm_key)$([ "$L_PRESENT" = yes ] && printf ' (lease %s is STALE)' "$L_HOLDER") — start its session (it takes the lease itself) or run 'swarm master take --force' in it"
    return 2
  fi
  hl="$(kl_holder_lane "$L_HOLDER")"; hhost="${L_HOLDER%%/*}"; hpid="${L_HOLDER##*/}"
  if [ "$hl" != "$lane" ]; then
    echo "WARN — the lease is held by $hl ($L_HOLDER), not the configured master $desc — 'swarm master take --force' from the master session hands it back"
    return 1
  fi
  if [ "$hhost" != "$(sm_host)" ]; then
    echo "OK — master $desc holds $(sm_key) on $hhost (its watcher is checked there)"
    return 0
  fi
  if ! _sm_has_watcher "$hpid"; then
    echo "WARN — master $desc holds $(sm_key) ($L_HOLDER) but has NO mail watcher — deaf while idle; arm scripts/mail_watch.sh (run_in_background) in that session"
    return 1
  fi
  echo "OK — master $desc holds $(sm_key) ($L_HOLDER, epoch $L_EPOCH) and its mail watcher is live"
  return 0
}

sm_take() {
  local force=0 rc
  if [ "${1:-}" = --force ]; then force=1; fi
  sm_need_session || return 1
  if ! sm_in_order "$(sm_lane)"; then
    echo "swarm master: lane '$(sm_lane)' is not in the coordination order ($(sm_order))" >&2
    return 2
  fi
  if ! sm_my_repo_ok; then
    echo "swarm master: only a session in repo $(sm_repo) can coordinate — this one runs elsewhere" >&2
    return 2
  fi
  if [ "$force" = 0 ] && kl_shared_mode && ! fleet_coordinator_ok; then
    echo "swarm master: the schedule gives coordinator to role '$(fleet_scheduled_role)' now; this Mac is '$(fleet_my_role)' — 'swarm master take --force' overrides (config/fleet_roles.txt)" >&2
    return 1
  fi
  sm_read_lease || { echo "swarm master: gateway unreachable — cannot take" >&2; return 1; }
  if [ "$L_PRESENT" = yes ] && [ "$L_STALE" = false ] && [ "$L_HOLDER" != "$(sm_holder)" ]; then
    if [ "$force" = 0 ]; then
      echo "swarm master: coordinator is $(kl_holder_lane "$L_HOLDER") ($L_HOLDER, epoch $L_EPOCH, heartbeat ${L_AGE:-?}s ago) — refusing; 'swarm master take --force' overrides (manual handback)" >&2
      return 1
    fi
    sm_release_lease "$(sm_holder)" "$L_EPOCH" force; rc=$?
    if [ "$rc" != 0 ]; then
      echo "swarm master: force release of $L_HOLDER (epoch $L_EPOCH) failed: ${SM_REASON:-gateway unreachable}" >&2
      return 1
    fi
    echo "swarm master: force-released $L_HOLDER (epoch $L_EPOCH)"
  fi
  sm_acquire; rc=$?
  case "$rc" in
    0) sm_marker_write "$SM_EPOCH"
       echo "swarm master: $(sm_lane) is coordinator on $(sm_host) (holder $(sm_holder), epoch $SM_EPOCH) — swarm active"
       sm_announce "$SM_EPOCH"
       return 0 ;;
    2) echo "swarm master: gateway unreachable — cannot take" >&2; return 1 ;;
    *) echo "swarm master: not acquired — held by ${SM_HELD_BY:-?}" >&2; return 1 ;;
  esac
}

# sm_step_down <verb> [--force] → shared by release/stop. 0 done (or nothing
# to release), 1 refused / failed.
sm_step_down() {
  local verb="$1" force=0 me epoch rc
  if [ "${2:-}" = --force ]; then force=1; fi
  me="$(sm_holder 2>/dev/null || true)"
  if [ -z "$me" ] && [ "$force" = 0 ]; then sm_need_session; return 1; fi
  sm_read_lease || { echo "swarm master: gateway unreachable — lease not released (it expires in ≤${SWARM_TTL}s)" >&2; return 1; }
  if [ "$L_PRESENT" = no ]; then
    sm_state_clear
    echo "swarm master: no coordinator lease on $(sm_host)"
    return 0
  fi
  if [ -n "$me" ] && [ "$L_HOLDER" = "$me" ]; then
    epoch="$(sm_state_get epoch)"; epoch="${epoch:-$L_EPOCH}"
    sm_release_lease "$me" "$epoch"; rc=$?
  elif [ "$force" = 1 ]; then
    sm_release_lease "${me:-$(sm_host)/operator/0}" "$L_EPOCH" force; rc=$?
  elif [ "$L_STALE" = true ]; then
    echo "swarm master: the lease ($L_HOLDER) is already stale — nothing held to release"
    return 0
  else
    echo "swarm master: refusing to $verb — the coordinator lease is held by $L_HOLDER, not this session (${me}). Only the holding session may $verb; '$verb --force' is the operator override." >&2
    return 1
  fi
  sm_state_clear
  case "$rc" in
    0) echo "swarm master: released $L_KEY (holder $L_HOLDER, epoch ${epoch:-$L_EPOCH})"; return 0 ;;
    2) echo "swarm master: gateway unreachable — lease not released" >&2; return 1 ;;
    *) echo "swarm master: not released — ${SM_REASON:-unknown}" >&2; return 1 ;;
  esac
}

sm_release() { sm_step_down release "${1:-}"; }

sm_stop() {
  local force="${1:-}"
  sm_step_down stop "$force" || return 1
  rm -f "$(sm_marker)" 2>/dev/null || true
  echo "swarm master: swarm stopped on $(sm_host) — failover and ship lock off"
  sm_mail_lanes "swarm stopped on $(sm_host) by $(sm_lane) — no coordinator; normal ship it applies"
  return 0
}

# sm_tick_due → 0 when SWARM_TICK_EVERY has passed since this session's last
# tick (timestamp file, not stat — portable). Records the new tick time.
sm_tick_due() {
  local f now last
  mkdir -p "$SWARM_DIR" 2>/dev/null || return 1
  f="$SWARM_DIR/tick.$(sm_host).$(sm_lane).$(sm_pid)"
  now="$(_sm_now)"
  last="$(cat "$f" 2>/dev/null || true)"
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  if [ $((now - last)) -lt "$SWARM_TICK_EVERY" ]; then return 1; fi
  printf '%s\n' "$now" > "$f" 2>/dev/null || true
  return 0
}

# sm_presence — acquire/renew this session's lane:<host>:<lane> presence lease
# (idempotent for the same holder; a dead session's lease goes stale after the
# TTL and the next session of that lane takes it over). swarm_live reports a
# lane "idle" only while this — or the coordinator lease — is fresh.
sm_presence() {
  local holder meta branch
  [ "$SWARM_PRESENCE" = 1 ] || return 0
  holder="$(sm_holder)" || return 0
  branch="$(git branch --show-current 2>/dev/null || true)"
  meta="$(kl_strs "lane=$(sm_lane)" "host=$(sm_host)" "pid=$(sm_pid)" ${branch:+"branch=$branch"})"
  kl_call lease_acquire "$(kl_args "key=lane:$(sm_host):$(sm_lane)" "holder=$holder" \
    "leaseSeconds=$SWARM_PRESENCE_TTL" "meta=$meta")" >/dev/null 2>&1 || true
}

# sm_prs_kick — refresh state/swarm/prs.json for swarm_live in the background;
# the writer rate-limits and locks itself, so a tick never waits on GitHub.
sm_prs_kick() {
  [ "$SWARM_PRS" = 1 ] || return 0
  [ -f "$SM_HERE/swarm_prs_snapshot.sh" ] || return 0
  ( bash "$SM_HERE/swarm_prs_snapshot.sh" >/dev/null 2>&1 & ) 2>/dev/null || true
}

# sm_tick_journal — count this session's ticks; every SWARM_JOURNAL_EVERY-th
# one (default 10, i.e. ~20 min) runs the change-journal scan.
sm_tick_journal() {
  local f n
  f="$SWARM_DIR/tickcount.$(sm_host).$(sm_lane).$(sm_pid)"
  n="$(cat "$f" 2>/dev/null || echo 0)"
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  n=$((n + 1))
  printf '%s\n' "$n" > "$f" 2>/dev/null || true
  if [ $((n % SWARM_JOURNAL_EVERY)) = 0 ]; then _sm_journal_scan; fi
  return 0
}

# sm_handoff_file → this repo's handoff (master: state/, managed: AI/state/).
sm_handoff_file() {
  local f
  f="$(cd "$SM_HERE/.." && pwd)/state/AI_AGENT_HANDOFF.md"
  [ -f "$f" ] || f="$(cd "$SM_HERE/../.." && pwd)/AI/state/AI_AGENT_HANDOFF.md"
  printf '%s' "$f"
}

# sm_since_epoch <ISO|empty> [today YYYY-MM-DD] → epoch seconds. ISO may carry
# Z or ±HH[:MM] (else local time); empty / "?" → local midnight of [today].
sm_since_epoch() {
  /usr/bin/python3 - "${1:-}" "${2:-}" <<'PY' 2>/dev/null || echo 0
import calendar, re, sys, time
iso, today = sys.argv[1], sys.argv[2]
m = re.match(r"^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$", iso or "")
if not m:
    y, mo, d = (int(x) for x in (today or time.strftime("%Y-%m-%d")).split("-"))
    print(int(time.mktime((y, mo, d, 0, 0, 0, 0, 0, -1))))
    sys.exit(0)
y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
h, mi, se = int(m.group(4) or 0), int(m.group(5) or 0), int(m.group(6) or 0)
tz = m.group(7)
if tz:
    off = 0
    if tz != "Z":
        t = tz[1:].replace(":", "")
        off = (1 if tz[0] == "+" else -1) * (int(t[:2]) * 3600 + (int(t[2:4]) * 60 if len(t) >= 4 else 0))
    print(calendar.timegm((y, mo, d, h, mi, se, 0, 0, 0)) - off)
else:
    print(int(time.mktime((y, mo, d, h, mi, se, 0, 0, -1))))
PY
}

# sm_lane_wrapped <lane> <file> <since-epoch> → 0 when the handoff has a wrap
# line FOR THAT LANE written at/after <since-epoch>. Only two shapes count, and
# only at the START of the line (PR #488 review — a bare "(<lane>" anywhere
# was a false "wrapped"):
#   > <LANE-UPPER> <YYYY-MM-DD>[T| ]HH:MM[±TZ]…            (handoff_append --header)
#   > **(0) <YYYY-MM-DD>[ HH:MM] … WRAP (<lane>…            (an action entry)
# A line with a time is compared to <since>; a date-only line counts only for
# a calendar day AFTER the since-day (give your wrap line a time).
sm_lane_wrapped() {
  /usr/bin/python3 - "$1" "$2" "$3" <<'PY' 2>/dev/null
import calendar, re, sys, time
lane, path, since = sys.argv[1], sys.argv[2], int(sys.argv[3])
D = r"(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?(Z|[+-]\d{2}(?::?\d{2})?)?"
pats = [re.compile(r"^> " + re.escape(lane.upper()) + r" " + D),
        re.compile(r"^> \*\*\(0\) " + D + r".*?\bWRAP \(" + re.escape(lane.lower()) + r"\b")]
since_day = time.localtime(since)[:3]
try:
    lines = open(path, encoding="utf-8").read().split("\n")
except Exception:
    sys.exit(1)
for line in lines:
    for rx in pats:
        m = rx.match(line)
        if not m:
            continue
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if m.group(4) is None:
            if (y, mo, d) > since_day:
                sys.exit(0)
            continue
        h, mi, tz = int(m.group(4)), int(m.group(5)), m.group(6)
        if tz:
            off = 0
            if tz != "Z":
                t = tz[1:].replace(":", "")
                off = (1 if tz[0] == "+" else -1) * (int(t[:2]) * 3600 + (int(t[2:4]) * 60 if len(t) >= 4 else 0))
            e = calendar.timegm((y, mo, d, h, mi, 0, 0, 0, 0)) - off
        else:
            e = time.mktime((y, mo, d, h, mi, 0, 0, 0, -1))
        if e >= since:
            sys.exit(0)
sys.exit(1)
PY
}

# sm_wrap_check [--wait [N]] [--since ISO] [--file F] — "coordinator wraps
# last": list the live lanes and whether each has a wrap line written since
# this session's start (the coordinator lease's acquiredAt, or --since);
# ONE "wrap up" mail per unwrapped lane per day; --wait polls up to N minutes
# (default 10); then prints the fleet line for the coordinator's own wrap.
sm_wrap_check() {
  local wait=0 file="" since="" since_e me today lanes l pending wrapped dedup deadline line
  while [ $# -gt 0 ]; do
    case "$1" in
      --wait) wait=10; shift; case "${1:-}" in ''|*[!0-9]*) ;; *) wait="$1"; shift ;; esac ;;
      --since) [ $# -ge 2 ] || { echo "swarm master: --since needs an ISO time" >&2; return 2; }; since="$2"; shift 2 ;;
      --file) [ $# -ge 2 ] || { echo "swarm master: --file needs a value" >&2; return 2; }; file="$2"; shift 2 ;;
      *) echo "swarm master: wrap-check [--wait [N]] [--since ISO] [--file F]" >&2; return 2 ;;
    esac
  done
  sm_need_session || return 1
  me="$(sm_holder)"
  sm_read_lease || { echo "swarm master: gateway unreachable — cannot confirm the coordinator" >&2; return 1; }
  if [ "$L_PRESENT" != yes ] || [ "$L_STALE" != false ] || [ "$L_HOLDER" != "$me" ]; then
    echo "swarm master: wrap-check is for the coordinator — this session ($me) is not it${L_HOLDER:+ (coordinator: $L_HOLDER)}" >&2
    return 1
  fi
  [ -n "$file" ] || file="$(sm_handoff_file)"
  today="$(_sm_today)"
  if [ -z "$since" ] && [ "${L_ACQ:-?}" != "?" ]; then since="$L_ACQ"; fi
  since_e="$(sm_since_epoch "$since" "$today")"
  lanes=""
  for l in $(sm_live_lanes); do
    if [ "$l" != "$(sm_lane)" ]; then lanes="$lanes $l"; fi
  done
  dedup="$SWARM_DIR/wrap-mail.$(sm_host).$today"
  deadline=$(( $(_sm_now) + wait * 60 ))
  while :; do
    pending=""; wrapped=""
    for l in $lanes; do
      if sm_lane_wrapped "$l" "$file" "$since_e"; then wrapped="$wrapped $l"; else pending="$pending $l"; fi
    done
    for l in $pending; do
      if ! grep -qx "$l" "$dedup" 2>/dev/null; then
        printf '%s\n' "$l" >> "$dedup"
        _sm_tell "$l" "wrap up: you are live on $(sm_host) and have no wrap line in the handoff since ${since:-$today} — run 'wrap up' (scripts/handoff_append.sh --header \"$(printf '%s' "$l" | tr '[:lower:]' '[:upper:]') <YYYY-MM-DDTHH:MM±TZ> …\"); the coordinator ($(sm_lane)) wraps last"
      fi
    done
    if [ -z "$pending" ] || [ "$wait" = 0 ] || [ "$(_sm_now)" -ge "$deadline" ]; then break; fi
    _sm_sleep 30
  done
  echo "wrap-check — $(sm_host), since ${since:-$today 00:00}, coordinator $(sm_lane)"
  for l in $lanes; do
    case " $wrapped " in *" $l "*) echo "  $l: wrapped" ;; *) echo "  $l: NOT wrapped (mailed once)" ;; esac
  done
  [ -n "$lanes" ] || echo "  (no other live lanes)"
  line="FLEET $today ($(sm_host)): coordinator $(sm_lane) wraps last; wrapped:${wrapped:- none}"
  if [ -n "$pending" ]; then line="$line; still unwrapped:$pending"; fi
  echo "fleet line for your own wrap:"
  echo "  ./scripts/handoff_append.sh --header \"$line\""
  return 0
}

# sm_deaf_sweep — the coordinator's safety net for DEAF lanes (2026-10-04): a
# session with no scripts/mail_watch.sh in its process tree only sees mail when
# it happens to make a tool call, so once idle it never wakes (a new worker
# mailed its plan, then sat idle ~9 min and never saw the GO). On every
# coordinator tick, for each other live lane whose resolved session has no
# watcher and holds unacked mail older than SWARM_DEAF_AFTER: type
# "check mail <id>" into it — idle sessions only (session_ping refuses a busy
# one; the next tick retries), ONE ping per mail ever (marker file). agy is
# skipped: its own pid-bound loop (agy-loop) already watches for it.
# SWARM_DEAF_SWEEP=0 disables. Best-effort, never fails the tick.
# _sm_ping_lane <lane> <mail-id> → 0 when "check mail <id>" was typed into the
# lane's idle session. Overridable in tests.
_sm_ping_lane() {
  LANES_SELF_PID="$(sm_pid)" bash "$SM_HERE/session_ping.sh" "$1" "$2" >/dev/null 2>&1
}

sm_deaf_sweep() {
  local host me lane mids mid mark resp
  [ "${SWARM_DEAF_SWEEP:-1}" = 1 ] || return 0
  host="$(sm_host)"; me="$(sm_lane)"
  mkdir -p "$SWARM_DIR/deaf-pinged" 2>/dev/null || return 0
  find "$SWARM_DIR/deaf-pinged" -type f -mtime +1 -delete 2>/dev/null || true
  for lane in $(lanes_candidates '*' 2>/dev/null | awk -F'\t' '{print $5}' | sort -u); do
    case "$lane" in "$me"|agy|default) continue ;; esac
    lanes_resolve "$lane" "$(sm_repo)" "" >/dev/null 2>&1 || continue
    if lanes_has_watcher "$LANE_PID"; then continue; fi
    resp="$(kl_call mail_inbox "$(printf '{"to":"%s/%s"}' "$host" "$lane")")" || continue
    mids="$(printf '%s' "$resp" | AFTER="$SWARM_DEAF_AFTER" /usr/bin/python3 -c '
import json, os, sys, datetime
try:
    d = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
now = datetime.datetime.now(datetime.timezone.utc)
for m in d.get("messages") or []:
    if m.get("acked") or m.get("kind") == "result":
        continue
    try:
        t = datetime.datetime.fromisoformat(str(m.get("createdAt", "")).replace("Z", "+00:00"))
    except Exception:
        continue
    if (now - t).total_seconds() >= int(os.environ["AFTER"]):
        print(m.get("messageId", ""))
' 2>/dev/null)"
    for mid in $mids; do
      case "$mid" in mail-*) ;; *) continue ;; esac
      mark="$SWARM_DIR/deaf-pinged/$mid"
      [ -e "$mark" ] && continue
      if _sm_ping_lane "$lane" "$mid"; then
        : > "$mark"
        echo "swarm master: woke deaf lane $lane (no mail watcher) for $mid"
      fi
      break # one ping drains the whole inbox; next tick handles anything left
    done
  done
  return 0
}

# sm_migrate_key <holder> <old epoch> <old key> — acquire the current key
# (sm_key) for the same holder, then release the old lease with its fencing
# epoch. Either direction: per-host → fleet (`coordinator_mode fleet`) or
# fleet → per-host (active-active). If ANOTHER session already validly holds
# the new key, step down from the old one instead of splitting the swarm.
sm_migrate_key() {
  local holder="$1" lepoch="$2" legacy="$3" rc
  sm_acquire; rc=$?
  case "$rc" in
    0)
      sm_release_lease "$holder" "$lepoch" "" "$legacy" || true
      sm_marker_write "$SM_EPOCH"
      echo "swarm master: migrated coordinator $holder from $legacy (epoch $lepoch) to $(sm_key) (epoch $SM_EPOCH)" ;;
    1)
      sm_release_lease "$holder" "$lepoch" "" "$legacy" || true
      sm_state_clear
      echo "swarm master: $(sm_key) is held by ${SM_HELD_BY:-another session} — stepped down from $legacy instead of splitting the fleet" ;;
    *) : ;;  # gateway down → keep the legacy lease, retry next tick
  esac
  return 0
}

sm_tick() {
  local me holder sholder sepoch skey res l _cf
  # Not inside a claude/agy session → no identity, nothing to do (no tick file).
  [ -n "$(sm_pid)" ] || return 0
  sm_tick_due || return 0
  # Claims this session holds are renewed on every tick (lost ones dropped),
  # and every SWARM_JOURNAL_EVERY-th tick runs the change-journal scan.
  cl_renew 2>/dev/null || true
  sm_presence
  sm_prs_kick
  sm_tick_journal
  me="$(sm_lane)"; holder="$(sm_holder)" || return 0
  sholder="$(sm_state_get holder)"; sepoch="$(sm_state_get epoch)"
  # (m) Key migration: this session holds a coordinator key that is no longer
  #     this Mac's key (per-host ↔ fleet after a coordinator_mode change) →
  #     move to the current key, then release the old one.
  skey="$(sm_state_get key)"
  if [ -n "$sholder" ] && [ "$sholder" = "$holder" ] && [ -n "$sepoch" ] && [ "$skey" != "$(sm_key)" ] \
     && { [ "$skey" = "$(kl_legacy_coord_key)" ] || [ "$skey" = "$(kl_fleet_key)" ]; }; then
    sm_migrate_key "$holder" "$sepoch" "$skey"
    return 0
  fi
  # (a) This session holds it → heartbeat with the fencing epoch.
  if [ -n "$sholder" ] && [ "$sholder" = "$holder" ] && [ -n "$sepoch" ]; then
    res="$(kl_call lease_heartbeat "$(kl_args "key=$(sm_key)" "holder=$holder" "epoch=$sepoch" "leaseSeconds=$SWARM_TTL")")" || return 0
    if [ "$(kl_json "$res" ok)" = false ]; then
      sm_state_clear
      echo "swarm master: lost coordinator lease $(sm_key) (now held by $(kl_json "$res" heldBy.holder))"
      return 0
    fi
    # Keep the <host>/coordinator address pointed at us (a lease taken before
    # the address existed, or a deleted file, heals on the next tick).
    _cf="$(SWARM_DIR="$SWARM_DIR" session_coordinator_file)"
    if [ "$(head -1 "$_cf" 2>/dev/null)" != "$holder" ]; then
      printf '%s\n' "$holder" > "$_cf" 2>/dev/null || true
    fi
    sm_deaf_sweep
    return 0
  fi
  # (b) Failover — only for a DELIBERATELY started swarm, only onto a lease doc
  #     that exists but is stale. Never creates one, never takes a valid one.
  sm_active || return 0
  sm_in_order "$me" || return 0
  sm_my_repo_ok || return 0
  if sm_opted_out "$me"; then return 0; fi
  # Shared fleet key: only the Mac whose role the schedule names (or anyone in
  # an open window) may fail over onto a stale fleet lease. Active-active needs
  # no gate — the key is per host, so failover never leaves this Mac.
  if kl_shared_mode && ! fleet_coordinator_ok; then return 0; fi
  sm_read_lease || return 0
  [ "$L_PRESENT" = yes ] || return 0
  if [ "$L_STALE" = false ]; then
    # Ours already (state file lost) → adopt it so the heartbeat resumes.
    if [ "$L_HOLDER" = "$holder" ]; then sm_state_write "$holder" "$L_EPOCH"; fi
    return 0
  fi
  for l in $(sm_order); do
    if [ "$l" = "$me" ]; then break; fi
    if sm_eligible "$l"; then return 0; fi
  done
  if sm_acquire; then sm_announce "$SM_EPOCH"; fi
  return 0
}

# sm_is_agy <pid> → 0 while <pid> is alive AND still an agy process (a reused
# pid running something else ends the loop).
sm_is_agy() {
  local c
  _sm_alive "$1" || return 1
  c="$(_sm_comm "$1")"
  case "${c##*/}" in agy) return 0 ;; esac
  return 1
}

sm_agy_loop() {
  local pid="${1:-}" lock other
  case "$pid" in ''|*[!0-9]*) echo "swarm master: agy-loop needs agy's pid" >&2; return 2 ;; esac
  mkdir -p "$SWARM_DIR" 2>/dev/null || true
  lock="$SWARM_DIR/agy-loop.$pid.lock"
  # mkdir is atomic: exactly one loop per agy pid. A lock whose loop died is
  # stale and is taken over.
  if ! mkdir "$lock" 2>/dev/null; then
    other="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$other" ] && _sm_alive "$other"; then
      echo "swarm master: agy-loop for pid $pid already running (loop pid $other)"
      return 0
    fi
    rm -rf "$lock" 2>/dev/null || true
    mkdir "$lock" 2>/dev/null || { echo "swarm master: agy-loop lock contended for pid $pid" >&2; return 0; }
  fi
  printf '%s\n' "${SM_LOOP_SELF_PID:-$$}" > "$lock/pid"
  export MYAI_SESSION_PROFILE=agy LANES_SELF_PID="$pid"
  SM_LOOP_LOCK="$lock"
  trap 'sm_agy_loop_exit' EXIT
  while sm_is_agy "$pid"; do
    sm_tick || true
    _sm_sleep "${SWARM_AGY_LOOP_SLEEP:-150}"
  done
  return 0
}

sm_agy_loop_exit() {
  local h
  h="$(sm_state_get holder)"
  if [ -n "$h" ] && [ "$h" = "$(sm_holder 2>/dev/null || true)" ]; then
    sm_release >/dev/null 2>&1 || true
  fi
  rm -rf "${SM_LOOP_LOCK:-/nonexistent-swarm-lock}" 2>/dev/null || true
}

sm_main() {
  local verb="${1:-who}"
  shift || true
  case "$verb" in
    who|status) sm_who ;;
    take) sm_take "$@" ;;
    release) sm_release "$@" ;;
    stop) sm_stop "$@" ;;
    tick) sm_tick ;;
    check) sm_check ;;
    agy-loop) sm_agy_loop "$@" ;;
    wrap-check) sm_wrap_check "$@" ;;
    -h|--help|help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$SM_HERE/swarm_master.sh" ;;
    *) echo "swarm master: unknown verb '$verb' (who | check | take [--force] | release [--force] | stop [--force] | wrap-check [--wait [N]] [--since ISO] | tick | agy-loop <pid>)" >&2; return 2 ;;
  esac
}

[ -n "${SWARM_MASTER_LIB_ONLY:-}" ] && return 0
sm_main "$@"
