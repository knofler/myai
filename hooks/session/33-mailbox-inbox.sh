#!/usr/bin/env bash
# 33-mailbox-inbox.sh — Session-start UNREAD MAIL banner (SWARM_MESSAGING P1).
#
# The durable mailbox (mail_send/mail_inbox/mail_ack, runtime/src/notifications/
# mailbox-store.ts) is the path that never loses a cross-Mac/cross-session
# message when the recipient was asleep. This surfaces it the SAME way the
# SCHEDULE banner (17-schedule-status.sh) surfaces the task queue: on every
# session start, print the unread mail addressed to THIS session — by host,
# host/repo, and repo — so a "home-mac: continue X" note left last night is the
# first thing this morning's session sees. Ack with mail_ack once handled.
# bash 3.2-safe. Stays SILENT when the gateway is down or there is no mail.
# Always exits 0.
set +e

PORT="${MCP_PORT:-3100}"
URL="http://localhost:${PORT}/mcp"

# ── colors (disabled if NO_COLOR set) ───────────────────────
if [ -n "$NO_COLOR" ]; then B='' R='' C='' Y='' M='' D='' G=''
else B=$'\033[1m'; R=$'\033[0m'; C=$'\033[1;36m'; Y=$'\033[1;33m'; M=$'\033[1;35m'; D=$'\033[2m'; G=$'\033[1;38;5;40m'; fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

# Canonical repo-id resolution (same resolver schedule_task.sh / the SCHEDULE
# banner use) so mail addressed to a repo lands regardless of folder casing.
for _ridlib in "$ROOT/scripts/lib/repo_id.sh" "$ROOT/AI/scripts/lib/repo_id.sh"; do
    # shellcheck source=/dev/null
    [ -f "$_ridlib" ] && . "$_ridlib" && break
done
if command -v canonical_repo_id >/dev/null 2>&1; then
    REPO=$(canonical_repo_id "$ROOT")
else
    REPO=$(basename "$ROOT")
fi

# Address set this session answers to: host, host/repo, repo (lowercased —
# mailbox-store normalises the same way). role addressing is opt-in per session.
HOST=$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
REPO_LC=$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')
ADDRS="[\"$HOST\",\"$HOST/$REPO_LC\",\"$REPO_LC\"]"

# Host→gateway calls MUST carry x-gateway-local-token (enforce=true 401s the
# Docker bridge IP otherwise → silent empty banner). Same lib the SCHEDULE
# banner sources.
for _gwlib in "$ROOT/scripts/lib/gateway.sh" "$ROOT/AI/scripts/lib/gateway.sh"; do
    # shellcheck source=/dev/null
    [ -f "$_gwlib" ] && . "$_gwlib" && break
done
GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

# ── Swarm awareness (plan/SWARM_COORDINATOR_PLAN.md rows 5–6) ───────────────
# (1) Change journal: `config_journal.sh scan-bg` — skipped when the last scan
#     was < 5 min ago, otherwise a DETACHED scan (output to its own log), so it
#     never adds to session start and never prints here. Unannounced changes
#     reach the brain + the coordinator's mailbox from the scan itself.
# (2) Active claims in this repo — only while a swarm is active on this Mac
#     (~/.myai/swarm/active.<host>, same gate as hooks/pre-tool/04), and only
#     printed when any exist. Silent when the gateway is down.
# Master: scripts/, managed: AI/scripts/.
for _sdir in "$ROOT/scripts" "$ROOT/AI/scripts"; do
    [ -f "$_sdir/config_journal.sh" ] || continue
    bash "$_sdir/config_journal.sh" scan-bg >/dev/null 2>&1
    if [ -f "$_sdir/lib/claims.sh" ] && [ -f "${SWARM_DIR:-$HOME/.myai/swarm}/active.$HOST" ]; then
        _claims=$( (
            # shellcheck source=/dev/null
            . "$_sdir/lib/claims.sh"
            cl_resolve "$ROOT/.claim-probe" >/dev/null 2>&1 || exit 0
            KL_TIMEOUT=3 cl_list_repo "$CL_REPO_ID"
        ) 2>/dev/null )
        if [ -n "$_claims" ]; then
            printf '%s\n' "${B}ACTIVE CLAIMS${R} ${D}— ${REPO_LC} (claim list · claim check <path>)${R}"
            printf '%s\n' "$_claims"
        fi
    fi
    break
done

resp=$(curl -sf -m 4 -X POST "$URL" -H 'content-type: application/json' \
    -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"mail_inbox\",\"arguments\":{\"to\":$ADDRS,\"limit\":20}}}" 2>/dev/null)
[ -z "$resp" ] && exit 0   # gateway down — stay silent

body=$(printf '%s' "$resp" | B="$B" R="$R" C="$C" Y="$Y" M="$M" D="$D" /usr/bin/python3 -c '
import sys, json, os
B=os.environ["B"]; R=os.environ["R"]; C=os.environ["C"]; Y=os.environ["Y"]; M=os.environ["M"]; D=os.environ["D"]
try:
    data = json.loads(json.loads(sys.stdin.read())["result"]["content"][0]["text"])
except Exception:
    sys.exit(0)
if data.get("error"):
    sys.exit(0)
msgs = data.get("messages", [])
unread = data.get("unreadCount", len(msgs))
if not msgs:
    sys.exit(0)
out = ["%s%d unread%s %sin the mailbox for this session%s" % (Y, unread, R, D, R)]
def clip(s, n):
    s = s or ""
    return s[:n]
for m in msgs[:8]:
    sw = (" %s· swarm %s%s" % (D, m.get("swarmId"), R)) if m.get("swarmId") else ""
    out.append("  %s✉%s %s[%s→%s]%s %s%s  %s%s%s" % (
        C, R, D, clip(m.get("from"), 24), clip(m.get("to"), 24), R,
        clip(m.get("subject"), 56), sw, D, clip(m.get("messageId"), 0) or "", R))
    out.append("     %sack: mail_ack {id:\"%s\"}%s" % (D, m.get("messageId"), R))
if len(msgs) > 8:
    out.append("  %s… +%d more unread%s" % (D, len(msgs) - 8, R))
print("\n".join(out))
' 2>/dev/null)

[ -z "$body" ] && exit 0   # no unread mail — stay silent

bar="══════════════════════════════════════════════════════════════"
printf '%s\n' "${B}╔${bar}╗${R}"
printf '%s\n' "${B}║${R}  ${G}MAIL RECEIVED${R}${B} — ${M}${REPO_LC}${R}${B} on ${M}${HOST}${R}"
printf '%s\n' "${B}╠${bar}╣${R}"
printf '%s\n' "$body" | sed 's/^/  /'
printf '%s\n' "${B}╚${bar}╝${R}"
exit 0
