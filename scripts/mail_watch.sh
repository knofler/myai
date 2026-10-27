#!/usr/bin/env bash
# mail_watch.sh — block until NEW unacked mail arrives for an address set, print
# it, and exit 0. Run it as a BACKGROUND task inside a Claude Code session: when
# it exits, the session is re-invoked (even while idle), handles the mail, and
# re-arms the watch. It is the IDLE layer of the three-layer live-mail story:
#
#   watcher (this)   — idle session: a blocking background poll wakes the session
#   mail-live hook   — busy session: a throttled poll on every prompt/tool call
#                      (hooks/mail-live.sh) injects new mail into the live context
#   tmux ping        — operator/agent-initiated poke (`tell` / session_ping.sh)
#
# WHY A WATCHER AND NOT JUST THE HOOK: the mail-live hook only fires on session
# activity (UserPromptSubmit / PostToolUse). A session sitting idle at the prompt
# runs no hooks, so two profile sessions on one Mac couldn't wake an idle peer. This
# blocking watcher closes that gap — its exit IS the wake.
#
# Usage: mail_watch.sh ['<json array of addresses>'] [poll_seconds]
#   addresses  default: session_default_addrs (scripts/lib/session_registry.sh)
#              — host, host/repo, repo, and (opt-in $MYAI_SESSION_ROLE) role.
#   poll       default: 20s.
#
# HARDENING over the original ~/.ai-cli-runner/mail_watch.sh:
#   • default addresses come from the shared session-registry lib, so the
#     watcher, the mail-live hook and the ARM banner all watch the same set.
#   • PER-SESSION seen file (keyed by address-set hash AND this watcher's pid),
#     so two sessions watching the same addresses on one Mac never clobber each
#     other's "already seen" set. Removed on exit.
#   • FAIL-SOFT: a gateway that is down / unreachable / 401 / returns garbage
#     never advances the first-pass state and never exits — the watcher just
#     keeps waiting, so a gateway restart doesn't spuriously "wake" the session
#     with every pre-existing message.
#   • bash 3.2-safe (stock macOS). Hermetic test seam: source with
#     MAIL_WATCH_LIB_ONLY=1 to load the functions without running, then override
#     `mail_watch_fetch` and point MAIL_WATCH_SEEN at a tmp file.
#
# NEVER AUTO-REPLIES: like the mail-live hook, this only READS and PRINTS. It has
# no send path, so a kind:result message can never trigger another message —
# that is what structurally prevents agent-to-agent ping-pong.
set -u

MAIL_WATCH_POLL_DEFAULT="${MAIL_WATCH_POLL_DEFAULT:-20}"
MW_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"

# Resolve the address set to watch: an explicit arg wins; otherwise the shared
# default from the session-registry lib.
mail_watch_addrs() {
  if [ -n "${1:-}" ]; then printf '%s' "$1"; return 0; fi
  if ! command -v session_default_addrs >/dev/null 2>&1; then
    # shellcheck source=/dev/null
    [ -f "$MW_HERE/lib/session_registry.sh" ] && . "$MW_HERE/lib/session_registry.sh" 2>/dev/null
  fi
  if command -v session_default_addrs >/dev/null 2>&1; then
    session_default_addrs
  else
    printf '[]'
  fi
}

# Resolve the gateway endpoint + local token (sourcing gateway.sh for the token
# escape hatch, same as every other host→gateway caller).
mail_watch_gateway() {
  local root _gwlib
  MW_URL="${MAIL_WATCH_URL:-http://localhost:${MCP_PORT:-3100}/mcp}"
  if [ -z "${GATEWAY_LOCAL_TOKEN:-}" ]; then
    root="$(git rev-parse --show-toplevel 2>/dev/null)"
    for _gwlib in "$MW_HERE/lib/gateway.sh" "$root/scripts/lib/gateway.sh" "$root/AI/scripts/lib/gateway.sh"; do
      # shellcheck source=/dev/null
      [ -f "$_gwlib" ] && . "$_gwlib" 2>/dev/null && break
    done
  fi
  MW_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
}

# mail_watch_fetch <addrs-json> → raw JSON-RPC response body on stdout; non-zero
# exit when the gateway is unreachable. OVERRIDABLE in tests.
mail_watch_fetch() {
  local addrs="$1"
  curl -sf -m 6 -X POST "$MW_URL" \
    -H 'content-type: application/json' -H "x-gateway-local-token: $MW_TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"mail_inbox\",\"arguments\":{\"to\":$addrs,\"limit\":30}}}" 2>/dev/null
}

# mail_watch_parse — stdin raw response → "messageId<TAB>from<TAB>subject<TAB>to"
# lines (unacked only; "to" decides first-pass reporting, it is not printed).
# Exits non-zero on an unparseable body so the caller can treat it as "no answer"
# (keep waiting) rather than "empty inbox" (advance state).
mail_watch_parse() {
  python3 -c '
import sys, json
raw = sys.stdin.read()
try:
    j = json.loads(raw)
    msgs = json.loads(j["result"]["content"][0]["text"]).get("messages", [])
except Exception:
    sys.exit(3)
for m in msgs:
    if m.get("acked"):
        continue
    print(m["messageId"] + "\t" + m.get("from", "?") + "\t" + m.get("subject", "").replace("\n", " ").replace("\t", " ")[:160] + "\t" + str(m.get("to", "")))
'
}

# mail_watch_is_direct <to> → 0 when <to> is one of $MW_DIRECT (newline list of
# this session's own addresses; mail_watch_run fills it from
# session_direct_addrs). OVERRIDABLE in tests via MW_DIRECT.
mail_watch_is_direct() {
  [ -n "$1" ] && [ -n "${MW_DIRECT:-}" ] && printf '%s\n' "$MW_DIRECT" | grep -qxF "$1"
}

# One poll against the seen-file in $MW_SEEN (first pass seeds it silently).
#   return 0 — NEW mail printed (caller should exit, waking the session)
#   return 1 — no new mail (keep waiting; state advanced)
#   return 2 — gateway unreachable / garbage (keep waiting; state NOT advanced)
#
# First-pass state is a sentinel FILE ($MW_SEEN.seeded), not a shell variable, so
# it survives being called inside a command substitution (the hermetic test does
# exactly that to capture output). The sentinel is only written AFTER a parseable
# answer, so a gateway-down / garbage poll (return 2, before it is written) never
# advances the first pass — a recovery still seeds silently rather than waking on
# every pre-existing message.
mail_watch_poll() {
  local addrs="$1" raw out new="" line id to first=1
  raw="$(mail_watch_fetch "$addrs")" || return 2
  [ -n "$raw" ] || return 2
  out="$(printf '%s' "$raw" | mail_watch_parse)" || return 2
  [ -f "$MW_SEEN.seeded" ] && first=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    id=${line%%$'\t'*}
    to=${line##*$'\t'}
    line=${line%$'\t'*}
    if ! grep -qxF "$id" "$MW_SEEN" 2>/dev/null; then
      printf '%s\n' "$id" >> "$MW_SEEN"
      # First pass seeds silently (a restart must not replay old shared mail)
      # — EXCEPT mail to this session's own direct address (host/<lane>,
      # host/coordinator): unacked there means unhandled. Mail that landed in
      # the gap between a watcher exiting and its re-arm used to be swallowed
      # here (three coordinator mails sat unseen for 2 h, 2026-10-04).
      if [ "$first" = 0 ] || mail_watch_is_direct "$to"; then
        new="$new$line"$'\n'
      fi
    fi
  done <<EOF
$out
EOF
  : > "$MW_SEEN.seeded" 2>/dev/null || true
  if [ -n "$new" ]; then
    # Bold green MAIL RECEIVED header (outgoing is bold orange MAIL SENT).
    if [ -n "${NO_COLOR:-}" ]; then printf 'MAIL RECEIVED\n%s' "$new"
    else printf '\033[1;38;5;40mMAIL RECEIVED\033[0m\n%s' "$new"; fi
    return 0
  fi
  return 1
}

# mail_watch_swarm_tick — one `swarm master tick` per poll (plan/
# SWARM_COORDINATOR_PLAN.md row 2): the coordinator's lease heartbeat and the
# failover check ride on this loop, so every Claude session running the watcher
# keeps the election alive with zero extra processes. swarm_master.sh throttles
# itself to once per 120s and is silent unless the lease was lost. Errors are
# swallowed — a broken tick must never stop mail. SWARM_TICK=0 disables it.
# OVERRIDABLE in tests.
mail_watch_swarm_tick() {
  [ "${SWARM_TICK:-1}" = 1 ] || return 0
  [ -f "$MW_HERE/swarm_master.sh" ] || return 0
  bash "$MW_HERE/swarm_master.sh" tick 2>/dev/null || true
}

mail_watch_run() {
  local addrs poll
  addrs="$(mail_watch_addrs "${1:-}")"
  poll="${2:-$MAIL_WATCH_POLL_DEFAULT}"
  if [ "$addrs" = "[]" ] || [ -z "$addrs" ]; then
    echo "mail_watch: no addresses to watch (could not derive host/repo)" >&2
    return 0
  fi
  mail_watch_gateway
  MW_DIRECT_AUTO=0
  if [ -z "${MW_DIRECT+x}" ] && command -v session_direct_addrs >/dev/null 2>&1; then
    MW_DIRECT="$(session_direct_addrs 2>/dev/null || true)"; MW_DIRECT_AUTO=1
  fi
  if [ -z "${MW_SEEN:-}" ]; then
    MW_SEEN="${TMPDIR:-/tmp}/myai-mail-watch.$(printf '%s' "$addrs" | cksum | awk '{print $1}').$$.seen"
  fi
  : > "$MW_SEEN" 2>/dev/null || true
  rm -f "$MW_SEEN.seeded" 2>/dev/null || true
  # Self-cleaning: the per-session seen file + sentinel are throwaway state.
  trap 'rm -f "$MW_SEEN" "$MW_SEEN.seeded" 2>/dev/null' EXIT
  while true; do
    # No explicit address list → re-derive each poll, so an address this
    # session GAINS mid-watch (<host>/coordinator after `swarm master take`)
    # is watched without a re-arm. The seen-file is keyed by the first set
    # and kept, so nothing already seen is replayed.
    if [ -z "${1:-}" ] && [ "${MW_ADDRS_FIXED:-0}" != 1 ]; then
      addrs="$(mail_watch_addrs "")"
      [ "$MW_DIRECT_AUTO" = 1 ] && MW_DIRECT="$(session_direct_addrs 2>/dev/null || true)"
    fi
    if mail_watch_poll "$addrs"; then return 0; fi
    mail_watch_swarm_tick
    sleep "$poll"
  done
}

# Run unless sourced for the hermetic test (MAIL_WATCH_LIB_ONLY=1).
if [ -z "${MAIL_WATCH_LIB_ONLY:-}" ]; then
  mail_watch_run "${1:-}" "${2:-}"
fi
