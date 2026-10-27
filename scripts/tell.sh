#!/usr/bin/env bash
# tell.sh — the `tell <session-label> <message>` keyword: say something to a
# peer session on this Mac and have it land LIVE, right now (task-d759dd15).
#
# One call does both halves of live cross-session messaging:
#   1. mail_send  — a DURABLE note to the peer's address (resolved from the
#      live-session registry, so `tell tech` just works — no guessing the
#      address). This never loses the message even if the peer is asleep.
#   2. session_ping — pokes the peer's tmux pane with "check mail <id>" so it
#      reads the note NOW instead of on its next prompt. Best-effort: if the
#      peer isn't in tmux it can't be live-poked (macOS TIOCSTI), but the
#      durable mail still waits for it.
#
# This is why two profile sessions on ONE Mac can finally talk: ListAgents/
# SendMessage only see same-ACCOUNT sessions, but the mailbox is account-
# independent and the tmux ping doesn't care about accounts either.
#
# Usage:  tell [--kind K] <label> [--kind K] <message...>
#   <label>   <lane> | a repo | a tmux session | any registry label
#   --kind K / env TELL_KIND=K    mail kind (default "live-note"; NOT "request",
#                                 so it is never auto-claimed as a task — that
#                                 is what keeps tell from starting a work loop).
#                                 MAIL DISCIPLINE: while a swarm is active,
#                                 workers mail the coordinator (or the master) ONLY
#                                 with --kind plan | blocker | merge-go | done;
#                                 anything else prints a WARNING (never blocks).
#   env TELL_REPLY_TO=<mail-id>   thread this as a reply (replyTo convention)
#   env TELL_NO_PING=1            mail only, no live ping (nudge.sh types itself)
#
# NO AUTO-REPLY: tell is only ever invoked by an operator or an agent acting on
# an explicit instruction, never fired automatically in response to incoming
# mail — so a kind:"result" can never bounce a tell back and loop. Keep it that
# way: do not call tell from an unattended mail handler.
#
# bash 3.2-safe. Source with TELL_LIB_ONLY=1 for the functions (tests stub
# _tell_mail_send + tmux). Exit 0 when the mail is sent (ping is best-effort).

# _tell_own_address → this session's own mailbox address (host/repo), used as
# `from` so a reply threads back here.
_tell_own_address() {
  local root repo host profile
  # A lane session (a profile lane or agy) signs as host/<lane>, so a reply wakes
  # exactly this session — host/repo is shared by every lane in the repo.
  if command -v session_profile >/dev/null 2>&1; then
    profile="$(session_profile)"
    if [ "$profile" != "default" ] && [ "${MYAI_RUNNER_FIRE:-0}" != "1" ]; then
      printf '%s/%s' "$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')" "$profile"
      return 0
    fi
  fi
  root=$(git rev-parse --show-toplevel 2>/dev/null) || { printf 'unknown'; return 0; }
  for _ridlib in "$root/scripts/lib/repo_id.sh" "$root/AI/scripts/lib/repo_id.sh"; do
    # shellcheck source=/dev/null
    [ -f "$_ridlib" ] && . "$_ridlib" && break
  done
  if command -v canonical_repo_id >/dev/null 2>&1; then repo=$(canonical_repo_id "$root"); else repo=$(basename "$root"); fi
  host=$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
  repo=$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')
  printf '%s/%s' "$host" "$repo"
}

# _tell_mail_send <to> <from> <subject> <kind> <replyTo> [body] → echoes the
# new messageId (mail-…) on success, nothing on failure. Overridable in tests.
_tell_mail_send() {
  local to="$1" from="$2" subject="$3" kind="$4" replyto="$5" body="${6:-}" root url port token args resp
  port="${MCP_PORT:-3100}"
  url="${MAIL_LIVE_URL:-http://localhost:$port/mcp}"
  root=$(git rev-parse --show-toplevel 2>/dev/null)
  for _gwlib in "$root/scripts/lib/gateway.sh" "$root/AI/scripts/lib/gateway.sh"; do
    # shellcheck source=/dev/null
    [ -f "$_gwlib" ] && . "$_gwlib" && break
  done
  token="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
  args="$(to="$to" from="$from" subject="$subject" kind="$kind" replyto="$replyto" body="$body" /usr/bin/python3 -c '
import json, os
a = {"to": os.environ["to"], "from": os.environ["from"], "subject": os.environ["subject"], "kind": os.environ["kind"]}
if os.environ.get("replyto"):
    a["replyTo"] = os.environ["replyto"]
if os.environ.get("body"):
    a["body"] = os.environ["body"]
print(json.dumps({"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"mail_send","arguments":a}}))
')"
  resp="$(curl -sf -m 5 -X POST "$url" -H 'content-type: application/json' \
    -H "x-gateway-local-token: $token" -d "$args" 2>/dev/null)"
  [ -n "$resp" ] || return 1
  printf '%s' "$resp" | /usr/bin/python3 -c '
import sys, json
try:
    outer = json.loads(sys.stdin.read())
    data = json.loads(outer["result"]["content"][0]["text"])
except Exception:
    sys.exit(1)
if data.get("error"): sys.exit(1)
mid = (data.get("message") or {}).get("messageId")
if mid: print(mid)
else: sys.exit(1)
' 2>/dev/null
}

# _tell_is_hookless <label> → 0 for lanes with no mail-live hook (agy): nothing
# inside them polls for mail, so a refused ping must be retried, not dropped.
_tell_is_hookless() { case " ${TELL_HOOKLESS_LANES:-agy} " in *" ${1##*/} "*) return 0 ;; esac; return 1; }

# _tell_autostart_agy [repo-dir] → start agy in a new iTerm tab when
# `tell agy` finds no live agy session (operator direction 2026-10-21).
# Disabled when TELL_AUTOSTART_AGY=0, or when LANES_PROC_SCAN=0 unless
# TELL_AUTOSTART_AGY=1 is explicitly set (keeps hermetic tests from
# spawning real iTerm tabs). Stubbable via TELL_AGY_SESSION_SCRIPT or
# by overriding _tell_autostart_agy.
_tell_autostart_agy() {
  if [ "${TELL_AUTOSTART_AGY:-}" = 0 ]; then return 1; fi
  if [ "${LANES_PROC_SCAN:-1}" = 0 ] && [ "${TELL_AUTOSTART_AGY:-}" != 1 ]; then return 1; fi
  local here script repo_dir
  here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
  script="${TELL_AGY_SESSION_SCRIPT:-$here/agy_session.sh}"
  [ -f "$script" ] || return 1
  repo_dir="${1:-${TELL_REPO_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || (cd "$here/.." && pwd))}}"
  bash "$script" start "$repo_dir" --new-tab
}

# _tell_defer_ping <label> <mail-id> [to] → detached bounded retry
# (session_ping.sh --deferred). With [to] the loop stops as soon as that mail is
# acked (the peer already handled it — no redundant "check mail" typed in).
# Overridable in tests.
_tell_defer_ping() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
  # The detached loop is re-parented to launchd and cannot find its caller, so
  # pass the caller's pid: it must never ping the session that sent the tell.
  LANES_SELF_PID="$( (command -v _lanes_self_pid >/dev/null 2>&1 && _lanes_self_pid) || true)" \
  SP_MAIL_TO="${3:-}" \
    nohup bash "$here/session_ping.sh" --deferred "${1##*/}" "$2" "${TELL_DEFER_MAX:-600}" "${TELL_DEFER_INTERVAL:-15}" >/dev/null 2>&1 &
}

# _tell_is_deaf → 0 when the lane session_ping just resolved (LANE_PID) has NO
# mail_watch.sh in its process tree: its mail-live hook shows mail only on its
# NEXT tool call, so once it goes idle nothing wakes it. A worker that mailed
# its plan and then sat idle for 9 min never saw the coordinator's GO
# (2026-10-04). Overridable in tests.
_tell_is_deaf() {
  [ -n "${LANE_PID:-}" ] || return 1
  command -v lanes_has_watcher >/dev/null 2>&1 || return 1
  ! lanes_has_watcher "$LANE_PID"
}

# _tell_swarm_active → 0 while a swarm coordinator holds the lease.
_tell_swarm_active() { [ -n "$(_tell_coordinator)" ]; }

# _tell_alert_stranded <label> <mail-id> — a typed ping did not submit (text
# left in the peer's input box, so the peer now LOOKS busy and every later ping
# is skipped). Durable mail to the coordinator — never a ping, so it cannot loop.
# Coordinator address: $SP_COORDINATOR_ADDR, default <host>/<master lane>.
_tell_alert_stranded() {
  local host to
  host="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  to="${SP_COORDINATOR_ADDR:-$host/$(_tell_master_lane)}"
  _tell_mail_send "$to" "$(_tell_own_address)" \
    "STRANDED ping: text left unsubmitted in $1's input box (mail ${2:-?}) — it will look busy; check $1 and press Enter there" \
    "live-note" "" "A typed 'check mail' did not submit even after one retry. Until someone submits or clears it, $1 looks busy and further pings are skipped. Run: check $1" >/dev/null 2>&1 || true
}

# _tell_coordinator → holder "<host>/<lane>/<pid>" of the active swarm
# coordinator, empty when no swarm is active (scripts/lib/keyed_lease.sh).
# Overridable in tests.
_tell_coordinator() {
  if command -v kl_coordinator >/dev/null 2>&1; then kl_coordinator; fi
  return 0
}

# _tell_mail_discipline <label> <to> <kind> — MAIL DISCIPLINE (operator rule,
# 2026-10-04): workers mail the coordinator ONLY for plan | blocker | merge-go |
# done. Warns ONLY while a swarm is active (a valid coordinator lease) AND the
# sender is not the coordinator session AND the target is the coordinator's
# lane (or the master's). No swarm → never warns. Never blocks.
_tell_mail_discipline() {
  local label="$1" to="$2" kind="$3" host coord clane me pid
  case "$kind" in plan|blocker|merge-go|done) return 0 ;; esac
  coord="$(_tell_coordinator)"
  [ -n "$coord" ] || return 0
  host="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  clane="$(printf '%s' "$coord" | awk -F/ '{print $2}')"
  # Is the target the coordinator (its lane) or the master (the default one)?
  local mlane; mlane="$(_tell_master_lane)"
  if [ "$label" != "$clane" ] && [ "$to" != "$host/$clane" ] && [ "$label" != "$mlane" ] && [ "$to" != "$host/$mlane" ]; then
    return 0
  fi
  # The coordinator session itself may mail anything.
  pid="$( (command -v _lanes_self_pid >/dev/null 2>&1 && _lanes_self_pid) || true)"
  if command -v session_profile >/dev/null 2>&1; then me="$host/$(session_profile)/$pid"; else me=""; fi
  if [ -n "$pid" ] && [ "$me" = "$coord" ]; then return 0; fi
  echo "tell: WARNING — workers mail the coordinator only for plan | blocker | merge-go | done (use --kind <one>); sending anyway as kind '$kind'" >&2
  return 0
}

tell() { # [--kind K] <label> [--kind K] <message...>
  local kind="${TELL_KIND:-live-note}"
  if [ "${1:-}" = --kind ]; then kind="${2:-}"; shift 2 || true; fi
  local label="${1:-}"; shift || true
  if [ "${1:-}" = --kind ]; then kind="${2:-}"; shift 2 || true; fi
  local message="$*"
  if [ -z "$label" ] || [ -z "$message" ] || [ -z "$kind" ]; then
    echo "tell: usage: tell [--kind plan|blocker|merge-go|done] <session-label> <message...>" >&2
    return 2
  fi
  command -v session_registry_resolve >/dev/null 2>&1 || {
    echo "tell: session_registry.sh not loaded" >&2; return 2; }

  local row to from replyto mid prc SP_TARGET_PID=""
  replyto="${TELL_REPLY_TO:-}"
  from="$(_tell_own_address)"

  # Resolve the label to a registry row to learn the target address. If it
  # doesn't resolve (peer not in tmux / not registered), fall back to treating
  # the label itself as the mailbox address so the DURABLE mail still goes out —
  # only the live ping is lost.
  # A lane label (`tell <lane>`, `tell agy`) always mails
  # host/<lane>: every session watches its own host/<profile> address
  # (session_default_addrs), so this lands whether or not the peer is in tmux,
  # and never wakes the other lane sharing the same host/repo address.
  # Coordinator role address (2026-10-04): while a swarm is active, mail for
  # the coordinator — `tell coordinator`, or `tell <its lane>`
  # — goes to <host>/coordinator, which ONLY the lease-holding session watches
  # (five master tabs share <host>/<master lane>). The live ping targets that exact
  # session pid. No swarm: `tell coordinator` falls back to the master.
  local coord="" clane="" chost
  chost="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  coord="$(_tell_coordinator)"
  clane="$(printf '%s' "$coord" | cut -d/ -f2)"
  if [ "$label" = coordinator ] && [ -z "$coord" ]; then label="$(_tell_master_lane)"; fi
  if [ -n "$coord" ] && { [ "$label" = coordinator ] || [ "$label" = "$clane" ]; }; then
    # The HOLDER's host: in fleet mode the coordinator may be the other Mac.
    to="${coord%%/*}/coordinator"
    label="$clane"
    # shellcheck disable=SC2034  # read by session_ping (dynamic scope) → exact holder pid
    SP_TARGET_PID="${coord##*/}"
  elif command -v session_is_profile_label >/dev/null 2>&1 && session_is_profile_label "$label"; then
    to="$chost/$label"
  elif row="$(session_registry_resolve "$label" 2>/dev/null)"; then
    to="$(printf '%s' "$row" | awk -F'\t' '{print $7}')"
    [ -n "$to" ] || to="$label"
  else
    to="$label"
  fi
  # TELL_TO pins the mailbox address (swarm_master.sh announces to host/<repo>
  # so a repo session on THIS Mac is told, not every host's).
  [ -n "${TELL_TO:-}" ] && to="$TELL_TO"

  # Subject = the message clipped to 120 chars; the FULL message always goes in
  # the body. The gateway caps subjects at 300 (mailbox-store MAX_SUBJECT_CHARS)
  # and tell used to put everything there — a long master→worker request arrived
  # cut mid-sentence with an empty body (2026-10-03).
  _tell_mail_discipline "$label" "$to" "$kind"
  local subject="$message"
  if [ "${#message}" -gt 120 ]; then subject="$(printf '%s' "$message" | cut -c1-117)..."; fi
  mid="$(_tell_mail_send "$to" "$from" "$subject" "$kind" "$replyto" "$message")"
  if [ -z "$mid" ]; then
    echo "tell: mail_send to '$to' failed (gateway unreachable?) — nothing delivered" >&2
    return 1
  fi
  # Bold orange MAIL SENT header — the fleet-wide colour for outgoing mail
  # (incoming is bold green MAIL RECEIVED: mail-live hook, watcher, banner).
  local hdr="MAIL SENT"
  [ -z "${NO_COLOR:-}" ] && hdr=$'\033[1;38;5;208m'"MAIL SENT"$'\033[0m'
  echo "$hdr to $to: $message"
  echo "tell: mailed '$to' as $mid (from $from, kind $kind${replyto:+, replyTo $replyto})"

  # TELL_NO_PING=1: mail only (nudge.sh types the message itself instead).
  [ "${TELL_NO_PING:-0}" = 1 ] && return 0
  # Live poke — best-effort, never fatal (durable mail already landed).
  session_ping "$label" "$mid"; prc=$?
  # When `tell agy` (or `tell <this-host>/agy`) finds no live agy session
  # (prc != 0, 3, 5), start one in a new iTerm tab on this Mac and re-attempt
  # the live ping (2026-10-21). Never start a local tab for another host's agy.
  local lhost=""
  case "$label" in */*) lhost="$(printf '%s' "${label%/*}" | tr '[:upper:]' '[:lower:]')" ;; esac
  if [ "$prc" != 0 ] && [ "$prc" != 3 ] && [ "$prc" != 5 ] && [ "${label##*/}" = agy ] && { [ -z "$lhost" ] || [ "$lhost" = "$chost" ]; }; then
    if _tell_autostart_agy; then
      echo "tell: started agy session — delivering ping for $mid" >&2
      session_ping "$label" "$mid"; prc=$?
    fi
  fi
  case "$prc" in
    0) : ;;
    3)
      # Reachable but busy. A Claude session's mail-live hook surfaces the mail
      # at its next tool call; a HOOKLESS lane (agy) would never notice it, so
      # its ping is deferred: retried in the background until it goes idle.
      if _tell_is_hookless "$label"; then
        _tell_defer_ping "$label" "$mid" "$to"
        echo "tell: $label is busy — ping deferred (retrying every ${TELL_DEFER_INTERVAL:-15}s for up to ${TELL_DEFER_MAX:-600}s until it is idle)" >&2
      elif _tell_swarm_active && _tell_is_deaf; then
        # Swarm active + no mail watcher in that session: the hook would show
        # the mail only if it makes another tool call — so ALSO wake it when it
        # goes idle (stops early once the mail is acked).
        _tell_defer_ping "$label" "$mid" "$to"
        echo "tell: $label is busy and has NO mail watcher (deaf once idle) — ping deferred until it is idle or the mail is acked" >&2
      else
        echo "tell: $label is busy — not typed; its mail-live hook shows the mail at its next tool call" >&2
      fi ;;
    5)
      _tell_alert_stranded "$label" "$mid"
      echo "tell: $label — ping text STRANDED in its input box (typed, not submitted, even after a retry); coordinator alerted" >&2 ;;
    *) echo "tell: (live ping not delivered — no reachable iTerm tab or tmux pane for '$label'; it sees the mail on its next prompt or boot)" >&2 ;;
  esac
  return 0
}

# Swarm roles (v1 G6) — loaded BEFORE the lib-only return so tests that source
# this file with TELL_LIB_ONLY=1 get the same master lane as a real run.
_tell_roles_lib="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/lib/swarm_roles.sh"
# shellcheck source=scripts/lib/swarm_roles.sh
[ -f "$_tell_roles_lib" ] && . "$_tell_roles_lib"
unset _tell_roles_lib
# _tell_master_lane — the swarm master's lane (from master.<host>, never a
# hard-coded name); `default` when the roles lib is somehow absent.
_tell_master_lane() { if declare -F role_master_lane >/dev/null 2>&1; then role_master_lane; else printf 'default'; fi; }

[ -n "${TELL_LIB_ONLY:-}" ] && return 0

# ── CLI entry ────────────────────────────────────────────────────────────────
_TELL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$_TELL_DIR/lib/session_registry.sh" ] && . "$_TELL_DIR/lib/session_registry.sh"
# shellcheck source=/dev/null
[ -f "$_TELL_DIR/lib/keyed_lease.sh" ] && . "$_TELL_DIR/lib/keyed_lease.sh"
# shellcheck source=/dev/null
SESSION_PING_LIB_ONLY=1 . "$_TELL_DIR/session_ping.sh"
tell "$@"
