#!/usr/bin/env bash
# keyed_lease.sh — the ONE shell door to the gateway's KEYED leases
# (lease_acquire / lease_heartbeat / lease_release / lease_list — phase 1 of
# plan/SWARM_COORDINATOR_PLAN.md, runtime/src/tasks/keyed-lease-store.ts).
# Used by scripts/swarm_master.sh (coordinator election) and
# scripts/ship_lock.sh (the ship lock). NOT the runner_lease_* slot pool.
#
# Transport is the same JSON-RPC-over-curl call tell.sh's _tell_mail_send
# makes: POST http://localhost:${MCP_PORT:-3100}/mcp with the
# x-gateway-local-token header from scripts/lib/gateway.sh.
#
# Test seams:
#   • override kl_call in-process (sourced suites), or
#   • MYAI_LEASE_STUB=<executable> — kl_call runs `<stub> <tool> <args-json>`
#     instead of curl and treats its stdout as the tool's JSON result. This is
#     the cross-process seam (the pre-tool hook spawns ship_lock.sh, so a
#     function stub cannot reach it).
#
# Sourced, never executed. bash 3.2-safe; safe under `set -euo pipefail`.

KL_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"

# kl_host → this Mac's short hostname, lowercased (the lease key suffix).
kl_host() { hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || true; }

# ── the coordinator key: ONE per Mac by default (active-active) ─────────────
# Operator rule 2026-10-19: each Mac's master lane is its own swarm master, so every
# Mac uses `swarm-coordinator:<host>`. Only `coordinator_mode fleet` in
# config/fleet_roles.txt brings back the shared fleet-wide key
# `swarm-coordinator:fleet` (plan/MULTI_MAC_SWARM_BRIEF.md: one lease = one
# coordinator for the whole fleet, both gateways on one Atlas DB) — and then
# only for a Mac with a role. A repo without the roles lib keeps the per-host key.
_KL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
if ! command -v fleet_has_role >/dev/null 2>&1 && [ -f "$_KL_DIR/fleet_role.sh" ]; then
  # shellcheck source=scripts/lib/fleet_role.sh
  . "$_KL_DIR/fleet_role.sh"
fi
kl_legacy_coord_key() { printf 'swarm-coordinator:%s' "$(kl_host)"; }
kl_fleet_mode() { command -v fleet_has_role >/dev/null 2>&1 && FLEET_HOST="${FLEET_HOST:-$(kl_host)}" fleet_has_role; }
# kl_shared_mode → 0 when this Mac shares the ONE fleet key (role + `coordinator_mode fleet`).
kl_shared_mode() { kl_fleet_mode && [ "$(FLEET_HOST="${FLEET_HOST:-$(kl_host)}" fleet_coordinator_mode)" = fleet ]; }
kl_fleet_key() { printf 'swarm-coordinator:fleet'; }
kl_coord_key() { if kl_shared_mode; then kl_fleet_key; else kl_legacy_coord_key; fi; }
# kl_coord_keys → the keys to READ, preferred first. During a migration (either
# direction) a live swarm may still hold the other key; readers (who, ship lock,
# tell) honour either until the holder's next tick migrates it.
kl_coord_keys() {
  kl_coord_key; echo
  if kl_shared_mode; then kl_legacy_coord_key; echo
  elif kl_fleet_mode; then kl_fleet_key; echo; fi
}
# kl_coord_get <key> → kl_get, except that in active-active mode a fleet-key
# lease held from ANOTHER Mac reads as "absent": that Mac's coordinator must
# never gate (ship lock) or receive (tell) this Mac's swarm.
kl_coord_get() {
  local info holder
  info="$(kl_get "$1")" || return 1
  if [ "$1" = "$(kl_fleet_key)" ] && ! kl_shared_mode; then
    holder="$(printf '%s' "$info" | cut -f2)"
    case "$info" in
      present*) [ "$(printf '%s' "${holder%%/*}" | tr '[:upper:]' '[:lower:]')" = "$(kl_host)" ] || info="absent" ;;
    esac
  fi
  printf '%s' "$info"
}

# kl_call <tool> <args-json> → the tool's JSON result on stdout. rc 1 when the
# gateway is unreachable, answers non-2xx, or returns something unparseable;
# a tool-level {error} is returned as JSON (rc 0) for the caller to inspect.
kl_call() {
  local tool="$1" args="$2" url token body resp
  if [ -n "${MYAI_LEASE_STUB:-}" ]; then
    "$MYAI_LEASE_STUB" "$tool" "$args"
    return $?
  fi
  if [ -z "${GATEWAY_LOCAL_TOKEN:-}" ] && [ -f "$KL_HERE/gateway.sh" ]; then
    # shellcheck source=/dev/null
    . "$KL_HERE/gateway.sh" 2>/dev/null || true
  fi
  token="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
  url="${MYAI_GATEWAY_URL:-http://localhost:${MCP_PORT:-3100}/mcp}"
  body="$(printf '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"%s","arguments":%s}}' "$tool" "$args")"
  resp="$(curl -sf -m "${KL_TIMEOUT:-5}" -X POST "$url" -H 'content-type: application/json' \
    -H "x-gateway-local-token: $token" -d "$body" 2>/dev/null)" || return 1
  [ -n "$resp" ] || return 1
  printf '%s' "$resp" | /usr/bin/python3 -c '
import json, sys
try:
    outer = json.loads(sys.stdin.read())
    print(outer["result"]["content"][0]["text"])
except Exception:
    sys.exit(1)
' 2>/dev/null
}

# kl_json <json> <field> → one value from a JSON object; dotted paths walk
# nested objects ("lease.epoch", "heldBy.holder"). true/false print as
# true/false, missing prints nothing. rc 0 always.
kl_json() {
  printf '%s' "$1" | /usr/bin/python3 -c '
import json, sys
try:
    v = json.loads(sys.stdin.read())
    for k in sys.argv[1].split("."):
        v = v.get(k) if isinstance(v, dict) else None
except Exception:
    v = None
if v is None:
    sys.exit(0)
if isinstance(v, bool):
    print("true" if v else "false")
elif isinstance(v, (dict, list)):
    print(json.dumps(v))
else:
    print(v)
' "$2" 2>/dev/null || true
}

# kl_args k=v … → a JSON object. Values that are all digits become numbers,
# true/false become booleans, everything else a string. A value starting with
# '{' is passed through as raw JSON (for meta).
kl_args() {
  /usr/bin/python3 -c '
import json, sys
out = {}
for a in sys.argv[1:]:
    k, _, v = a.partition("=")
    if v.isdigit():
        out[k] = int(v)
    elif v in ("true", "false"):
        out[k] = (v == "true")
    elif v.startswith("{"):
        out[k] = json.loads(v)
    else:
        out[k] = v
print(json.dumps(out))
' "$@"
}

# kl_get <key> → one line describing that exact key:
#   "absent"                                      no such lease
#   "present<TAB>holder<TAB>epoch<TAB>stale<TAB>ageSec<TAB>acquiredAt(ISO, server)"
# stale (true/false) is the gateway's server-time verdict; ageSec is the
# seconds since the last heartbeat on THIS Mac's clock (display only).
# rc 1 when the gateway can't answer (caller decides: fail open or closed).
kl_get() {
  local key="$1" res
  res="$(kl_call lease_list "$(kl_args "prefix=$key" "limit=50")")" || return 1
  [ -n "$res" ] || return 1
  printf '%s' "$res" | /usr/bin/python3 -c '
import json, sys, time, datetime
key = sys.argv[1]
try:
    d = json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)
if not isinstance(d, dict) or "leases" not in d:
    sys.exit(1)
for l in d.get("leases") or []:
    if l.get("key") != key:
        continue
    age = "?"  # never empty: tab is IFS whitespace
    hb = l.get("heartbeatAt") or ""
    try:
        t = datetime.datetime.strptime(hb[:19], "%Y-%m-%dT%H:%M:%S")
        age = str(max(0, int(time.time() - (t - datetime.datetime(1970, 1, 1)).total_seconds())))
    except Exception:
        pass
    print("present\t%s\t%s\t%s\t%s\t%s" % (l.get("holder", ""), l.get("epoch", 1),
          "true" if l.get("stale") else "false", age, l.get("acquiredAt") or "?"))
    sys.exit(0)
print("absent")
' "$key" 2>/dev/null
}

# kl_strs k=v … → a JSON object whose values are ALL strings (meta, free text).
kl_strs() {
  /usr/bin/python3 -c '
import json, sys
print(json.dumps(dict(a.partition("=")[::2] for a in sys.argv[1:])))
' "$@"
}

# kl_list <prefix> → one line per lease whose key starts with <prefix>:
#   key<TAB>holder<TAB>epoch<TAB>stale(true|false)<TAB>ageSec<TAB>meta.note
# rc 1 when the gateway can't answer. Tabs/newlines in a note become spaces.
kl_list() {
  local res
  res="$(kl_call lease_list "$(kl_args "prefix=$1" "limit=${2:-1000}")")" || return 1
  [ -n "$res" ] || return 1
  printf '%s' "$res" | /usr/bin/python3 -c '
import json, sys, time, datetime
try:
    d = json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)
if not isinstance(d, dict) or "leases" not in d:
    sys.exit(1)
for l in d.get("leases") or []:
    age = "?"  # never empty: a tab is IFS whitespace and an empty field would collapse
    try:
        t = datetime.datetime.strptime((l.get("heartbeatAt") or "")[:19], "%Y-%m-%dT%H:%M:%S")
        age = str(max(0, int(time.time() - (t - datetime.datetime(1970, 1, 1)).total_seconds())))
    except Exception:
        pass
    note = str((l.get("meta") or {}).get("note") or "").replace("\t", " ").replace("\n", " ")
    print("%s\t%s\t%s\t%s\t%s\t%s" % (l.get("key", ""), l.get("holder", ""), l.get("epoch", 1),
          "true" if l.get("stale") else "false", age, note))
' 2>/dev/null
}

# kl_coordinator → the holder of this Mac's VALID coordinator lease, printed
# only while a swarm is active (marker present). Empty otherwise or when the
# gateway can't answer. rc 0 always.
kl_coordinator() {
  local info holder stale
  local key
  [ -f "$(kl_active_marker)" ] || return 0
  for key in $(kl_coord_keys); do
    info="$(KL_TIMEOUT="${KL_TIMEOUT:-3}" kl_coord_get "$key" 2>/dev/null)" || continue
    case "$info" in present*) ;; *) continue ;; esac
    IFS="$(printf '\t')" read -r _ holder _ stale _ <<EOF
$info
EOF
    if [ "$stale" = false ]; then printf '%s' "$holder"; return 0; fi
  done
  return 0
}

# kl_coordinator_host → host segment of the active coordinator's holder (it may
# be ANOTHER Mac in fleet mode); empty when there is none.
kl_coordinator_host() { local h; h="$(kl_coordinator)"; [ -n "$h" ] && printf '%s' "${h%%/*}"; return 0; }

# kl_coordinator_lane → lane of the active coordinator, or this Mac's configured
# master lane (role_master_lane) when no swarm is active / no valid coordinator.
kl_coordinator_lane() {
  local h
  h="$(kl_coordinator)"
  if [ -n "$h" ]; then kl_holder_lane "$h"; return 0; fi
  # shellcheck source=scripts/lib/swarm_roles.sh disable=SC1091
  type role_master_lane >/dev/null 2>&1 || . "$KL_HERE/swarm_roles.sh" 2>/dev/null || true
  if type role_master_lane >/dev/null 2>&1; then role_master_lane; else printf 'default'; fi
}

# kl_holder_lane <holder> → the <lane> segment of "<host>/<lane>/<pid>".
kl_holder_lane() { printf '%s' "$1" | awk -F/ '{print $2}'; }

# kl_swarm_dir → the local swarm state dir (SWARM_DIR overrides; tests).
kl_swarm_dir() { printf '%s' "${SWARM_DIR:-$HOME/.myai/swarm}"; }

# kl_active_marker → path of this Mac's "swarm deliberately started" marker,
# written by `swarm master take` and removed by `swarm master stop`. Without it
# nothing elects a coordinator automatically and the ship lock never engages.
kl_active_marker() { printf '%s/active.%s' "$(kl_swarm_dir)" "$(kl_host)"; }
