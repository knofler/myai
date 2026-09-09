#!/usr/bin/env bash
# 17-schedule-status.sh — Session-start SCHEDULE banner (the "resume" banner):
# bold, boxed, with COLOR-CODED bullets — what the autonomous runner has DONE
# for THIS repo (green ✓), what's SCHEDULED/queued next (cyan •), and what's
# running NOW (yellow ▶) — plus the runner's real cadence + last session.
# Times in Australia/Sydney. bash 3.2-safe. Always exits 0.
set +e

PORT="${MCP_PORT:-3100}"
URL="http://localhost:${PORT}/mcp"
RUNNER_LABEL="com.myai.cli-task-runner"
RUNNER_LOGS="$HOME/.ai-cli-runner/logs"
RUNNER_PLIST="$HOME/Library/LaunchAgents/${RUNNER_LABEL}.plist"

# ── colors (disabled if NO_COLOR set) ───────────────────────
if [ -n "$NO_COLOR" ]; then B='' R='' G='' C='' Y='' M='' D=''
else B=$'\033[1m'; R=$'\033[0m'; G=$'\033[1;38;5;208m'; C=$'\033[1;36m'; Y=$'\033[1;33m'; M=$'\033[1;35m'; D=$'\033[2m'; fi

# ── repo name (task-store convention) ───────────────────────
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    # Real precondition failure, not "nothing to report" — a missing/broken
    # .git here means EVERY session-start banner that resolves ROOT this way
    # goes dark at once (2026-08-27 incident: a Mac booted with every repo's
    # .git missing and five guards reported nothing, indistinguishable from a
    # healthy quiet session). Say so on stderr instead of exiting silently.
    echo "17-schedule-status: cannot resolve repo (not a git repository) — SCHEDULE banner skipped" >&2
    exit 0
}
# Canonical repo-id resolution (scripts/lib/repo_id.sh, task-89077bf0) — the
# SAME resolver schedule_task.sh uses, so this banner and `schedule --list`
# can never again disagree about what a given checkout's repo id is (e.g. the
# master repo's folder is literally "AI" but its canonical id is
# "ai_management").
for _ridlib in "$ROOT/scripts/lib/repo_id.sh" "$ROOT/AI/scripts/lib/repo_id.sh"; do
    [ -f "$_ridlib" ] && . "$_ridlib" && break
done
if command -v canonical_repo_id >/dev/null 2>&1; then
    NAME=$(canonical_repo_id "$ROOT")
else
    NAME=$(basename "$ROOT")
fi
syd() { TZ=Australia/Sydney date -r "$1" "+%d %b %H:%M AEST" 2>/dev/null; }

# Host→gateway calls MUST carry x-gateway-local-token (enforce=true 401s the Docker
# bridge IP otherwise; curl -sf swallows the 401 → silent empty banner). See
# scripts/lib/gateway.sh — master and managed layouts both tried.
for _gwlib in "$ROOT/scripts/lib/gateway.sh" "$ROOT/AI/scripts/lib/gateway.sh"; do
    [ -f "$_gwlib" ] && . "$_gwlib" && break
done
GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

# Query every historical alias of NAME (not just its current canonical
# spelling) so tasks queued before this repo's ids were unified — e.g. under
# the literal "AI" string — still show up here instead of looking orphaned
# (task-89077bf0). Non-master repos alias only to themselves (one query, as
# before). One response line per alias, newline-joined; python merges by
# taskId so a task queued under either spelling is counted once.
if command -v repo_aliases_for >/dev/null 2>&1; then
    NAME_ALIASES="$(repo_aliases_for "$NAME")"
else
    NAME_ALIASES="$NAME"
fi
body=$( { for _alias in $NAME_ALIASES; do
    curl -sf -m 4 -X POST "$URL" -H 'content-type: application/json' \
        -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"tasks_list\",\"arguments\":{\"repo\":\"$_alias\",\"limit\":200}}}" 2>/dev/null
    echo
done; } | B="$B" R="$R" G="$G" C="$C" Y="$Y" M="$M" D="$D" /usr/bin/python3 -c '
import sys, json, os
from datetime import datetime, timezone, timedelta
B=os.environ["B"]; R=os.environ["R"]; G=os.environ["G"]; C=os.environ["C"]; Y=os.environ["Y"]; M=os.environ["M"]; D=os.environ["D"]
got_any = False
tasks_by_id = {}
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        data = json.loads(json.loads(line)["result"]["content"][0]["text"])
    except Exception:
        continue
    got_any = True
    for t in data.get("tasks", []):
        tid = t.get("taskId")
        tasks_by_id[tid if tid is not None else id(t)] = t
if not got_any:
    sys.exit(0)
ts = list(tasks_by_id.values())
done = [t for t in ts if t["status"] in ("review","done","blocked") and t.get("updatedAt")]
done.sort(key=lambda t: t["updatedAt"], reverse=True)
pend = [t for t in ts if t["status"] == "pending"]
order = {"P0":0,"P1":1,"P2":2,"P3":3}
pend.sort(key=lambda t: (0 if "quick win" in (t.get("notes") or "") else 1, order.get(t.get("priority"),9)))
working = [t for t in ts if t["status"] == "working"]

def syd(iso):
    try:
        dt = datetime.fromisoformat(iso.replace("Z","+00:00")).astimezone(timezone(timedelta(hours=10)))
        return dt.strftime("%d %b %H:%M")
    except Exception:
        return ""
def title(t, n=64):
    return (t.get("title") or "")[:n]

out = []
if working:
    out.append("%s▶ NOW%s    %s%s%s  %s(agent working)%s" % (Y,R,B,title(working[0]),R,D,R))

if done:
    out.append("%s✓ DONE%s   %s(%d)%s" % (G,R,D,len(done),R))
    for t in done[:4]:
        st = t["status"]
        out.append("   %s✓%s %s[%s]%s %s  %s%s · %s%s" % (G,R,D,t.get("priority","?"),R,title(t), D,syd(t.get("updatedAt","")),("→ "+st),R))

if pend:
    out.append("%s• SCHEDULED%s %s(%d queued)%s" % (C,R,D,len(pend),R))
    for t in pend[:6]:
        qw = "%s⚡%s " % (Y,R) if "quick win" in (t.get("notes") or "") else "   "
        out.append("%s%s•%s %s[%s]%s %s" % (qw,C,R,D,t.get("priority","?"),R,title(t)))
    if len(pend) > 6:
        out.append("   %s… +%d more queued%s" % (D,len(pend)-6,R))

if not (working or done or pend):
    out.append("EMPTY")
print("\n".join(out))
' 2>/dev/null)

[ -z "$body" ] && exit 0   # gateway down — stay silent

# ── runner-backlog WELL health (task-618ccbe7 / task-d8a33c2f) — `myai doctor`
# already reports {total, consumed, remaining} and warns when the well runs
# low, but that only surfaces when someone remembers to run doctor by hand.
# Mirror the same counting queue_topup.sh + doctor use here (TOTAL = non-blank/
# non-comment lines in the backlog file, CONSUMED = the gateway-backed cursor,
# task-e9163eb9 — NOT a local file, which read CONSUMED=0 on any fresh
# checkout/worktree regardless of the real consumption state) so a low well
# shows up on every session start, not just on-demand.
BACKLOG="${MYAI_RUNNER_BACKLOG:-$ROOT/config/runner_backlog.jsonl}"
well_line=""
if [ -f "$BACKLOG" ]; then
    total=$(grep -cvE '^[[:space:]]*(#|$)' "$BACKLOG" 2>/dev/null || echo 0)
    consumed=$(gw_backlog_cursor_get 2>/dev/null)
    if [ -n "$consumed" ]; then
    remaining=$(( total - consumed ))
    [ "$remaining" -lt 0 ] && remaining=0
    backlog_min="${RUNNER_BACKLOG_MIN:-6}"
    if [ "$remaining" -lt "$backlog_min" ] 2>/dev/null; then
        well_line="  ${Y}⚠ WELL LOW${R}  ${D}${remaining} remaining / ${total} total backlog items (< ${backlog_min}) — queue_topup.sh will enqueue a PLANNER task${R}"
    fi
    fi
fi

# ── pricing-staleness warning (task-7ff72a04) — openai_agent.py's
# pricing_staleness_warning() / --check-pricing only reaches an operator
# inside a real agentic run's log or when someone remembers to run
# `openai_agent.py --check-pricing` by hand (agentic_fallback.sh's
# agentic_pricing_stale_warning wraps it for that lane). Same doctor-only-
# visibility problem the WELL LOW check above was promoted out of in commit
# 244f9b4 — mirror that precedent: run the same check here so a drifted
# $/token table (PRICES_PER_M, gating AGENTIC_FALLBACK_DAILY_USD_CAP) shows
# on every session start, not only when the agentic lane happens to fire.
pricing_line=""
for _oa in "$ROOT/scripts/lib/openai_agent.py" "$ROOT/AI/scripts/lib/openai_agent.py"; do
    if [ -f "$_oa" ]; then
        pricing_out=$(/usr/bin/python3 "$_oa" --check-pricing 2>/dev/null)
        pricing_rc=$?
        if [ "$pricing_rc" -ne 0 ] && [ -n "$pricing_out" ]; then
            pricing_msg="${pricing_out#\[openai-agent\] }"
            pricing_line="  ${Y}⚠ PRICING STALE${R}  ${D}${pricing_msg}${R}"
        fi
        break
    fi
done

# ── planner drift (task-5a79bd74) — queue_topup.sh --report already computes
# whether CONSUMED backlog items actually shipped (done) vs are still in-flight
# vs are genuinely stale (silent enqueue failure, later-pruned task, etc), but
# it only surfaces when an operator remembers to run it by hand. Mirror the
# WELL LOW / PRICING STALE precedent: run the compact --summary mode here so
# planner effectiveness is visible on every session start.
drift_line=""
for _qt in "$ROOT/scripts/queue_topup.sh" "$ROOT/AI/scripts/queue_topup.sh"; do
    if [ -f "$_qt" ]; then
        drift_out=$(bash "$_qt" --summary 2>/dev/null)
        [ -n "$drift_out" ] && drift_line="  ${C}◆ DRIFT${R}  ${D}${drift_out}${R}"
        break
    fi
done

# ── test->main ship drift (task-d4350b8f) — surface the condition the
# runner's ship step (scripts/runner_ship_step.sh) acts on BEFORE it becomes a
# backlog: how many commits origin/test carries that origin/main doesn't.
# Cached refs only (no fetch — this hook must stay fast/offline-safe); a stale
# reading just means "at least this many" until the next fetch.
ship_drift_line=""
if git -C "$ROOT" rev-parse --verify -q origin/main >/dev/null 2>&1 && git -C "$ROOT" rev-parse --verify -q origin/test >/dev/null 2>&1; then
    ship_drift=$(git -C "$ROOT" rev-list --count origin/main..origin/test 2>/dev/null)
    ship_threshold="${SHIP_DRIFT_THRESHOLD:-5}"
    if [ -n "$ship_drift" ] && [ "$ship_drift" -gt 0 ] 2>/dev/null; then
        if [ "$ship_drift" -ge "$ship_threshold" ] 2>/dev/null; then
            ship_drift_line="  ${Y}🚀 SHIP${R}  ${D}test is ${ship_drift} commit(s) ahead of main (>= threshold ${ship_threshold}) — runner_ship_step.sh should open/merge a PR on the next review-flip${R}"
        else
            ship_drift_line="  ${C}◆ SHIP${R}  ${D}test is ${ship_drift} commit(s) ahead of main (threshold ${ship_threshold})${R}"
        fi
    fi
fi

# ── runner cadence (read real interval from plist) + last session ──
runner_line="${D}not installed on this machine${R}"
if launchctl list "$RUNNER_LABEL" >/dev/null 2>&1; then
    iv=$(/usr/bin/python3 -c "import re,sys;import plistlib;
try:
  d=plistlib.load(open('$RUNNER_PLIST','rb'));print(int(d.get('StartInterval',0))//3600)
except Exception:
  print(0)" 2>/dev/null)
    [ -z "$iv" ] || [ "$iv" = "0" ] && every="" || every="every ${iv}h"
    last_log=$(ls -t "$RUNNER_LOGS" 2>/dev/null | head -1)
    if [ -n "$last_log" ]; then
        last_ts=$(stat -c %Y "$RUNNER_LOGS/$last_log" 2>/dev/null || stat -f %m "$RUNNER_LOGS/$last_log" 2>/dev/null)  # GNU-first (BSD `stat -f` pollutes stdout on Linux)
        runner_line="${G}active${R} ${D}${every} · last: $(syd "$last_ts")${R}"
    else
        runner_line="${G}active${R} ${D}${every} · no sessions yet${R}"
    fi
fi

# ── render bold boxed banner ────────────────────────────────
bar="══════════════════════════════════════════════════════════════"
printf '%s\n' "${B}╔${bar}╗${R}"
printf '%s\n' "${B}║  📅  SCHEDULE — ${M}${NAME}${R}${B}${R}"
printf '%s\n' "${B}╠${bar}╣${R}"
if [ "$body" = "EMPTY" ]; then
    printf '%s\n' "  ${D}no tasks in the fleet queue for this repo — use 'schedule <desc>'${R}"
else
    printf '%s\n' "$body" | sed 's/^/  /'
fi
printf '%s\n' "${B}╠${bar}╣${R}"
printf '%s\n' "  ${B}runner:${R} $runner_line"
[ -n "$well_line" ] && printf '%s\n' "$well_line"
[ -n "$drift_line" ] && printf '%s\n' "$drift_line"
[ -n "$ship_drift_line" ] && printf '%s\n' "$ship_drift_line"
[ -n "$pricing_line" ] && printf '%s\n' "$pricing_line"
printf '%s\n' "  ${D}dashboard: http://localhost:3210/schedule${R}"
printf '%s\n' "${B}╚${bar}╝${R}"
exit 0
