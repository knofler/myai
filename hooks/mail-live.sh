#!/usr/bin/env bash
# mail-live.sh — LIVE mail delivery into an ACTIVE session (task-d759dd15).
#
# The session-start banner (hooks/session/33-mailbox-inbox.sh) shows unread mail
# ONCE, at boot. But a session that has been open for an hour never sees a
# message that arrived five minutes ago until it restarts — and two sessions on
# one machine under different accounts can't SendMessage to poke each other. This hook closes
# that gap: on every user prompt AND after every tool call, it does a THROTTLED
# (~60s, cached) mail_inbox poll for this session's addresses and injects a
# short "MAIL RECEIVED from <from>: <subject> (mail-id)" block for anything new and
# unacked. That block becomes context the session acts on (read + mail_ack).
#
# Wired to BOTH UserPromptSubmit and PostToolUse (same script, one shared cache
# keyed by the address set), so the two events can't double-poll or double-
# inject inside the throttle window. Installed for EVERY profile by
# setup_org_dirs.sh so it fires in every account lane.
#
# FLOOD / LOOP GUARDS:
#   • Throttle: at most one gateway poll per MAIL_LIVE_THROTTLE seconds (60).
#   • Hourly cap: at most MAIL_LIVE_MAX_PER_HOUR (20) injections per rolling
#     hour per address set — excess is held and summarised, never dropped
#     silently (it's still unread in the mailbox).
#   • De-dupe: a message is injected at most ONCE (cached by id); re-polls never
#     re-show it. Acking it in the session is the durable clear.
#   • No auto-reply: this hook only READS and DISPLAYS. It never sends mail and
#     never replies — so a kind:"result" message can never trigger another
#     message, which is what stops agent-to-agent ping-pong. `tell`/session_ping
#     are operator/agent-initiated, never automatic, for the same reason.
#
# HERMETIC TEST HOOK: source with MAIL_LIVE_LIB_ONLY=1 to get the functions
# without running, then override _mail_live_fetch to return canned JSON and
# point MAIL_LIVE_CACHE_DIR at a tmpdir. bash 3.2-safe. Always exits 0.
set +e

MAIL_LIVE_THROTTLE="${MAIL_LIVE_THROTTLE:-60}"
MAIL_LIVE_MAX_PER_HOUR="${MAIL_LIVE_MAX_PER_HOUR:-20}"

# ── colors (disabled if NO_COLOR set) ───────────────────────
# MLG: the MAIL RECEIVED header — bold green, the one fleet-wide colour for
# incoming mail (outgoing is bold orange "MAIL SENT", scripts/tell.sh).
if [ -n "${NO_COLOR:-}" ]; then MLB='' MLR='' MLC='' MLY='' MLM='' MLD='' MLG=''
else MLB=$'\033[1m'; MLR=$'\033[0m'; MLC=$'\033[1;36m'; MLY=$'\033[1;33m'; MLM=$'\033[1;35m'; MLD=$'\033[2m'; MLG=$'\033[1;38;5;40m'; fi

# Address set this session answers to: host, host/repo, repo, and (opt-in) role.
# Same resolver the session-start mailbox banner uses, so live + boot agree.
_mail_live_addrs() {
  local root repo host repo_lc role_part="" _srlib
  root=$(git rev-parse --show-toplevel 2>/dev/null) || { printf '[]'; return 0; }
  # ONE derivation: the watcher, this hook and the banner must watch the same
  # set (scripts/lib/session_registry.sh → session_default_addrs, incl. the
  # coordinator address and the swarm-repo gate on host/<lane>).
  for _srlib in "$root/scripts/lib/session_registry.sh" "$root/AI/scripts/lib/session_registry.sh"; do
    if [ -f "$_srlib" ]; then
      # shellcheck source=/dev/null
      . "$_srlib" 2>/dev/null && command -v session_default_addrs >/dev/null 2>&1 && {
        session_default_addrs "$root" | tr -d '\n'; return 0; }
    fi
  done
  # Fallback (repo without the lib): same rules, minus the coordinator address.
  for _ridlib in "$root/scripts/lib/repo_id.sh" "$root/AI/scripts/lib/repo_id.sh"; do
    # shellcheck source=/dev/null
    [ -f "$_ridlib" ] && . "$_ridlib" && break
  done
  if command -v canonical_repo_id >/dev/null 2>&1; then repo=$(canonical_repo_id "$root"); else repo=$(basename "$root"); fi
  host=$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
  repo_lc=$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')
  # role addressing is opt-in: MYAI_SESSION_ROLE (e.g. "reviewer") if the
  # operator set one for this session.
  if [ -n "${MYAI_SESSION_ROLE:-}" ]; then
    role_part=",\"$(printf '%s' "$MYAI_SESSION_ROLE" | tr '[:upper:]' '[:lower:]')\""
  fi
  # host/profile ("<host>/<lane>") — what `tell <lane>` mails. Same derivation as
  # session_profile in scripts/lib/session_registry.sh.
  local profile="${MYAI_SESSION_PROFILE:-}"
  if [ -z "$profile" ]; then
    case "${CLAUDE_CONFIG_DIR:-}" in
      */.claude-*) profile="${CLAUDE_CONFIG_DIR##*/.claude-}" ;;
    esac
  fi
  profile=$(printf '%s' "$profile" | tr '[:upper:]' '[:lower:]')
  # Runner fires share a lane's config dir; they never answer host/<lane>.
  if [ -n "$profile" ] && [ "$profile" != "default" ] && [ "${MYAI_RUNNER_FIRE:-0}" != "1" ] \
     && [ "$repo_lc" = "$(printf '%s' "${SWARM_REPO:-ai_management}" | tr '[:upper:]' '[:lower:]')" ]; then
    role_part="$role_part,\"$host/$profile\""
  fi
  printf '["%s/%s","%s"%s]' "$host" "$repo_lc" "$repo_lc" "$role_part"
}

# _mail_live_fetch <addrs-json> → raw JSON-RPC response body (overridable in tests).
_mail_live_fetch() {
  local addrs="$1" root url port
  port="${MCP_PORT:-3100}"
  url="${MAIL_LIVE_URL:-http://localhost:$port/mcp}"
  root=$(git rev-parse --show-toplevel 2>/dev/null)
  for _gwlib in "$root/scripts/lib/gateway.sh" "$root/AI/scripts/lib/gateway.sh"; do
    # shellcheck source=/dev/null
    [ -f "$_gwlib" ] && . "$_gwlib" && break
  done
  local token="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
  curl -sf -m 4 -X POST "$url" -H 'content-type: application/json' \
    -H "x-gateway-local-token: $token" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"mail_inbox\",\"arguments\":{\"to\":$addrs,\"limit\":30}}}" 2>/dev/null
}

# Cache file for this address set (shared across the two hook events + both
# polls within a throttle window). Keyed by a hash of the address set.
_mail_live_cache_file() {
  local addrs="$1" dir hash
  dir="${MAIL_LIVE_CACHE_DIR:-${TMPDIR:-/tmp}/myai-mail-live}"
  mkdir -p "$dir" 2>/dev/null
  hash=$(printf '%s' "$addrs" | cksum 2>/dev/null | awk '{print $1}')
  [ -n "$hash" ] || hash=default
  printf '%s/%s.cache\n' "$dir" "$hash"
}

mail_live_run() {
  local addrs cache now last resp block ids hourcount remaining
  addrs="$(_mail_live_addrs)"
  [ "$addrs" = "[]" ] && return 0
  cache="$(_mail_live_cache_file "$addrs")"
  now=$(date +%s 2>/dev/null); [ -n "$now" ] || now=0

  # Throttle: skip the whole poll if we polled within the window.
  last=0
  [ -f "$cache" ] && last=$(awk '$1=="poll"{print $2; exit}' "$cache" 2>/dev/null)
  [ -n "$last" ] || last=0
  if [ "$((now - last))" -lt "$MAIL_LIVE_THROTTLE" ]; then
    return 0
  fi

  resp="$(_mail_live_fetch "$addrs")"
  # Update the poll timestamp regardless of outcome (prune inj lines >2h old),
  # so a gateway blip doesn't make us hammer it every prompt.
  _mail_live_rewrite_poll() {
    local tmp; tmp="$cache.$$.tmp"
    if { printf 'poll %s\n' "$now"
         [ -f "$cache" ] && awk -v cut="$((now - 7200))" '$1=="inj" && $2+0 >= cut {print}' "$cache" 2>/dev/null
       } > "$tmp" 2>/dev/null; then
      mv -f "$tmp" "$cache" 2>/dev/null || rm -f "$tmp" 2>/dev/null
    else
      rm -f "$tmp" 2>/dev/null
    fi
  }
  if [ -z "$resp" ]; then _mail_live_rewrite_poll; return 0; fi  # gateway down — stay silent

  # Injections already made in the last rolling hour, and the id set we've shown.
  hourcount=0
  [ -f "$cache" ] && hourcount=$(awk -v cut="$((now - 3600))" '$1=="inj" && $2+0 >= cut {n++} END{print n+0}' "$cache" 2>/dev/null)
  [ -n "$hourcount" ] || hourcount=0
  remaining=$((MAIL_LIVE_MAX_PER_HOUR - hourcount))
  [ "$remaining" -lt 0 ] && remaining=0

  local injected_ids=""
  [ -f "$cache" ] && injected_ids=$(awk '$1=="inj"{print $3}' "$cache" 2>/dev/null)

  # python does the parse + de-dupe + cap render. stdout is:
  #   <new-id>\n ... \n%%%BLOCK%%%\n<rendered human block>
  local pyout
  pyout="$(printf '%s' "$resp" | \
    MLB="$MLB" MLR="$MLR" MLC="$MLC" MLY="$MLY" MLM="$MLM" MLD="$MLD" MLG="$MLG" \
    INJECTED="$injected_ids" REMAINING="$remaining" /usr/bin/python3 -c '
import sys, json, os
B=os.environ["MLB"]; R=os.environ["MLR"]; C=os.environ["MLC"]; Y=os.environ["MLY"]; M=os.environ["MLM"]; D=os.environ["MLD"]; G=os.environ.get("MLG","")
injected = set(x for x in os.environ.get("INJECTED","").split() if x)
try:
    remaining = int(os.environ.get("REMAINING","0"))
except ValueError:
    remaining = 0
try:
    outer = json.loads(sys.stdin.read())
    data = json.loads(outer["result"]["content"][0]["text"])
except Exception:
    sys.exit(0)
if data.get("error"):
    sys.exit(0)
msgs = data.get("messages", [])
# newest-first already; show oldest-first so a burst reads top-to-bottom.
new = [m for m in msgs if m.get("messageId") and m.get("messageId") not in injected]
new = list(reversed(new))
if not new:
    sys.exit(0)
shown = new[:remaining] if remaining > 0 else []
held = len(new) - len(shown)
def clip(s, n):
    s = s or ""
    return s[:n]
lines = []
for m in shown:
    kind = m.get("kind") or "note"
    sw = (" %s· swarm %s%s" % (D, m.get("swarmId"), R)) if m.get("swarmId") else ""
    lines.append("  %sMAIL RECEIVED%s from %s%s%s: %s%s%s  %s(%s)%s%s" % (
        G, R, C, clip(m.get("from"), 28), R,
        B, clip(m.get("subject"), 60), R,
        D, clip(m.get("messageId"), 64), R, sw))
    lines.append("     %skind:%s · read it, then mail_ack {id:\"%s\"}%s" % (D, kind, clip(m.get("messageId"), 64), R))
if held > 0:
    lines.append("  %s… +%d more held (hourly live-inject cap) — still unread in the mailbox%s" % (D, held, R))
ids = [m.get("messageId") for m in shown]
print("\n".join(ids))
print("%%%BLOCK%%%")
print("\n".join(lines))
' 2>/dev/null)"

  if [ -z "$pyout" ]; then _mail_live_rewrite_poll; return 0; fi

  ids="$(printf '%s' "$pyout" | sed -n '1,/^%%%BLOCK%%%$/p' | sed '$d')"
  block="$(printf '%s' "$pyout" | sed -n '/^%%%BLOCK%%%$/,$p' | sed '1d')"

  # Rewrite cache: fresh poll ts, pruned old inj lines, plus the newly shown ids.
  local tmp; tmp="$cache.$$.tmp"
  if { printf 'poll %s\n' "$now"
       [ -f "$cache" ] && awk -v cut="$((now - 7200))" '$1=="inj" && $2+0 >= cut {print}' "$cache" 2>/dev/null
       for _id in $ids; do printf 'inj %s %s\n' "$now" "$_id"; done
     } > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$cache" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  else
    rm -f "$tmp" 2>/dev/null
  fi

  [ -z "$block" ] && return 0
  local bar="────────────────────────────────────────────────────────────"
  printf '%s\n' "${MLM}┌${bar}┐${MLR}"
  printf '%s\n' "$block"
  printf '%s\n' "${MLM}└${bar}┘${MLR}"
  return 0
}

[ -n "${MAIL_LIVE_LIB_ONLY:-}" ] && return 0
mail_live_run
exit 0
