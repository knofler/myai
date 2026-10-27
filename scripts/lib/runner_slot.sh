#!/usr/bin/env bash
# runner_slot.sh (lib) — fleet-wide runner leases (multi-Mac phase 3,
# plan/MULTI_MAC_SWARM_BRIEF.md, operator-approved 2026-10-05). Sourced, never
# executed; bash 3.2-safe; every gateway call is best-effort.
#
# Both Macs carry the same runner LaunchAgent and spend the SAME accounts, and
# per-Mac pacing ledgers double-spent an account. Two keyed leases in the shared
# gateway DB fix that:
#
#   runner-slot:<account>  held for the whole fire by "<host>/runner/<pid>"
#                          (TTL RUNNER_SLOT_TTL, default 20 min, renewed every
#                          RUNNER_SLOT_BEAT s by a pid-bound loop) — no two
#                          fires, on any Mac, spend one account at once.
#   runner-alive:<role>    refreshed by every runner tick on a Mac of that role
#                          (TTL RUNNER_ALIVE_TTL, default 90 min) — when the
#                          scheduled role's lease has lapsed its runner is
#                          silent and the other role covers (failover).
#
#   rs_alive_beat                 mark this Mac's role alive (call every tick)
#   rs_role_alive <role>          0 unless the role's alive lease is absent/stale
#   rs_acquire <account>          take runner-slot:<account>; 0 = ours (beat started)
#   rs_release                    stop the beat and release the slot we hold
#
# Needs scripts/lib/keyed_lease.sh (kl_call / kl_args / kl_json / kl_get) and
# scripts/lib/fleet_role.sh (fleet_host / fleet_my_role). Tests:
# scripts/tests/test_runner_slot.sh (MYAI_LEASE_STUB fake gateway).

# shellcheck disable=SC2034  # RS_* / AB_* globals are this lib's public results (read by the runner)
RS_SLOT_TTL="${RUNNER_SLOT_TTL:-1200}"
RS_SLOT_BEAT="${RUNNER_SLOT_BEAT:-300}"
RS_ALIVE_TTL="${RUNNER_ALIVE_TTL:-5400}"

rs_holder() { printf '%s/runner/%s' "$(fleet_host)" "${RS_PID:-$$}"; }

rs_alive_beat() {
  local role
  role="$(fleet_my_role)"
  [ "$role" = unassigned ] && return 0
  # Holder = host: a second host of the same role finds it validly held — the
  # role is alive either way, which is all failover asks.
  kl_call lease_acquire "$(kl_args "key=runner-alive:$role" "holder=$(fleet_host)" "leaseSeconds=$RS_ALIVE_TTL")" >/dev/null 2>&1 || true
  return 0
}

rs_role_alive() {
  local row
  # Gateway unreachable → report ALIVE: a failover we can't verify could double-spend.
  row="$(kl_get "runner-alive:$1" 2>/dev/null)" || return 0
  case "$row" in
    present*) [ "$(printf '%s' "$row" | cut -f4)" = true ] && return 1; return 0 ;;
    absent) return 1 ;;
  esac
  return 0
}

RS_SLOT_KEY="" RS_SLOT_EPOCH="" RS_BEAT_PID="" RS_HELD_BY=""

rs_acquire() {
  local acct="$1" res key holder parent
  key="runner-slot:$acct"; holder="$(rs_holder)"
  res="$(kl_call lease_acquire "$(kl_args "key=$key" "holder=$holder" "leaseSeconds=$RS_SLOT_TTL")")" || return 2
  [ "$(kl_json "$res" acquired)" = true ] || { RS_HELD_BY="$(kl_json "$res" heldBy.holder)"; return 1; }
  RS_SLOT_KEY="$key"; RS_SLOT_EPOCH="$(kl_json "$res" lease.epoch)"
  parent="${RS_PID:-$$}"
  # Renew while the fire runs; dies with the runner (pid-bound) and is killed
  # by rs_release. Re-acquiring as the same holder is an idempotent extend.
  (
    while kill -0 "$parent" 2>/dev/null; do
      sleep "$RS_SLOT_BEAT"
      kill -0 "$parent" 2>/dev/null || break
      kl_call lease_acquire "$(kl_args "key=$key" "holder=$holder" "leaseSeconds=$RS_SLOT_TTL")" >/dev/null 2>&1 || true
    done
  ) </dev/null >/dev/null 2>&1 &
  RS_BEAT_PID=$!
  return 0
}

rs_release() {
  [ -n "$RS_BEAT_PID" ] && { kill "$RS_BEAT_PID" 2>/dev/null || true; RS_BEAT_PID=""; }
  [ -n "$RS_SLOT_KEY" ] || return 0
  kl_call lease_release "$(kl_args "key=$RS_SLOT_KEY" "holder=$(rs_holder)" "epoch=${RS_SLOT_EPOCH:-1}")" >/dev/null 2>&1 || true
  RS_SLOT_KEY="" RS_SLOT_EPOCH=""
  return 0
}
