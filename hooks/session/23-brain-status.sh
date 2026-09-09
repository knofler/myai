#!/usr/bin/env bash
# 23-brain-status.sh — Session-start BRAIN sign: the orange 🧠 line that shows
# the git-versioned agent memory is live. Renders the brain main SHA, atom
# counts (sessions/handoffs/memory), the last commit subject, and flags any
# open session/idea branches or pending stashes (uncommitted brain work).
#
# BRAIN W5.2 (plan/BRAIN_V2_CAPTURE_AND_OFFLOAD.md): also renders a second
# line with the composite brain_health score/grade, its recent trend (from
# the recorded snapshot history), and the W5.3 capture-coverage metric (% of
# observed sessions that produced an atom) — so W1's capture work is visible
# on every session start instead of needing a manual `brain health` call.
#
# This is the CLI surface for the brain that was previously only visible on the
# dashboard /brain page. Non-fatal, always exits 0; gateway down → stay silent.
set +e

PORT="${MCP_PORT:-3100}"
URL="http://localhost:${PORT}/mcp"

# ── colors (disabled if NO_COLOR set) ───────────────────────
if [ -n "$NO_COLOR" ]; then B='' R='' G='' C='' Y='' D=''
else B=$'\033[1m'; R=$'\033[0m'; G=$'\033[1;38;5;208m'; C=$'\033[1;36m'; Y=$'\033[1;33m'; D=$'\033[2m'; fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    # Real precondition failure (missing/broken .git), not "gateway down" —
    # see hooks/session/17-schedule-status.sh for the incident this pattern
    # caused. Warn instead of vanishing silently.
    echo "23-brain-status: cannot resolve repo (not a git repository) — BRAIN banner skipped" >&2
    exit 0
}

# Host→gateway calls MUST carry x-gateway-local-token (enforce=true 401s the
# Docker bridge IP otherwise). Same convention as 17-schedule-status.sh.
for _gwlib in "$ROOT/scripts/lib/gateway.sh" "$ROOT/AI/scripts/lib/gateway.sh"; do
    [ -f "$_gwlib" ] && . "$_gwlib" && break
done
GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

body=$(curl -sf -m 4 -X POST "$URL" -H 'content-type: application/json' \
    -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
    -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"brain_status","arguments":{}}}' 2>/dev/null \
    | B="$B" R="$R" G="$G" C="$C" Y="$Y" D="$D" /usr/bin/python3 -c '
import sys, json, os
B=os.environ["B"]; R=os.environ["R"]; G=os.environ["G"]; C=os.environ["C"]; Y=os.environ["Y"]; D=os.environ["D"]
try:
    d = json.loads(json.load(sys.stdin)["result"]["content"][0]["text"])
except Exception:
    sys.exit(0)
if not d.get("initialized"):
    sys.exit(0)
a = d.get("atoms", {}) or {}
sess = a.get("sessions", 0); hand = a.get("handoffs", 0); mem = a.get("memory", 0)
branch = d.get("branch", "?")
ns = d.get("namespaces", 0)
lc = (d.get("lastCommit") or "").strip()
# lastCommit is "<sha> brain(session): <repo>/<slug>"  → split sha + subject
sha = ""; subj = lc
if lc:
    parts = lc.split(None, 1)
    sha = parts[0]
    subj = parts[1] if len(parts) > 1 else ""
    subj = subj.replace("brain(session):", "").replace("brain(handoff):", "").strip()
open_br = d.get("branches", []) or []
stashes = d.get("stashes", []) or []
sync = d.get("sync") or {}
# statusline badge (scripts/org-statusline.sh reads this): sha + timestamp
try:
    import time
    _bp = os.path.expanduser("~/.myai/statusline-badge.json")
    try: _prev = json.load(open(_bp))
    except Exception: _prev = {}
    _prev.update({"sha": sha[:8], "ts": int(time.time()), "repo": os.path.basename(os.getcwd())})
    json.dump(_prev, open(_bp, "w"))
except Exception:
    pass

# line 1: the orange 🧠 sign
line1 = "%s🧠 BRAIN%s %s%s%s%s %s· %d sessions · %d handoffs · %d memory · %d ns%s" % (
    G, R, D, branch, (" "+sha) if sha else "", R, D, sess, hand, mem, ns, R)
# warn markers for uncommitted brain work
warn = ""
if open_br:
    warn += " %s· %d open branch%s%s" % (Y, len(open_br), "es" if len(open_br)!=1 else "", R)
if stashes:
    warn += " %s· %d stash%s%s" % (Y, len(stashes), "es" if len(stashes)!=1 else "", R)
print(line1 + warn)
if subj:
    print("   %slast: %s%s" % (D, subj, R))
# task-1195b1a7: local main behind origin/main (pull-on-boot could not
# fast-forward — usually a diverged clone) is now a LOUD red line, not a
# silent no-op. RED (bold) so it cannot be mistaken for the routine yellow
# open-branch/stash markers above.
behind = sync.get("behind") or 0
if behind > 0:
    RED = "\033[1;31m" if not os.environ.get("NO_COLOR") else ""
    ahead = sync.get("ahead") or 0
    tag = "DIVERGED" if sync.get("diverged") else "BEHIND"
    print("   %s⚠️  BRAIN %s: local main is %d commit(s) behind origin/main (ahead %d) - this boot may be missing recent sessions from other machines. Run \"myai brain merge\" to reconcile.%s" % (RED, tag, behind, ahead, R))
' 2>/dev/null)

[ -z "$body" ] && exit 0   # gateway down / brain uninitialized — stay silent

# ── health/trend/capture-coverage line (W5.2) — only fetched once we know the
# brain is initialized (the check above), so a stray health line never prints
# without its BRAIN header. `record` defaults true (throttled to one snapshot
# per hour server-side, same as any other brain_health caller) so the trend
# this line renders actually accumulates points from ordinary session starts.
health_body=$(curl -sf -m 4 -X POST "$URL" -H 'content-type: application/json' \
    -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
    -d '{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"brain_health","arguments":{}}}' 2>/dev/null \
    | B="$B" R="$R" G="$G" C="$C" Y="$Y" D="$D" /usr/bin/python3 -c '
import sys, json, os
B=os.environ["B"]; R=os.environ["R"]; G=os.environ["G"]; C=os.environ["C"]; Y=os.environ["Y"]; D=os.environ["D"]
try:
    d = json.loads(json.load(sys.stdin)["result"]["content"][0]["text"])
except Exception:
    sys.exit(0)
score = d.get("score"); grade = d.get("grade")
if score is None or grade is None:
    sys.exit(0)

grade_color = {"excellent": G, "good": C, "fair": Y, "poor": Y}.get(grade, C)
# statusline badge: add the health score next to the sha written above
try:
    _bp = os.path.expanduser("~/.myai/statusline-badge.json")
    try: _prev = json.load(open(_bp))
    except Exception: _prev = {}
    _prev.update({"score": score, "grade": grade})
    json.dump(_prev, open(_bp, "w"))
except Exception:
    pass

# trend: last few recorded snapshots (recordBrainHealthSnapshot, throttled to
# one per hour) rendered as an arrow chain, oldest first.
history = d.get("history") or []
pts = [h.get("score") for h in history[-5:] if isinstance(h.get("score"), (int, float))]
trend = " %s· trend %s%s" % (D, "→".join(str(int(p)) for p in pts), R) if len(pts) >= 2 else ""

# W5.3 capture-coverage: % of observed sessions (scratch/observe/) that
# produced a captured atom in the trailing window. None until sessions have
# been observed (fresh brain / hooks never fired yet) — omitted, not shown as 0%.
signals = d.get("signals") or {}
cov = signals.get("captureCoverage")
capture = ""
if cov is not None:
    cov_n = signals.get("captureCoverageSampleSize") or 0
    cov_days = signals.get("captureCoverageWindowDays") or 7
    capture = " %s· capture %d%% (%d session%s/%dd)%s" % (
        D, round(cov * 100), cov_n, "" if cov_n == 1 else "s", cov_days, R)

print("   %shealth:%s %s%d/100%s (%s)%s%s" % (D, R, grade_color, score, R, grade, trend, capture))
' 2>/dev/null)

printf '%s\n' "$body"
[ -n "$health_body" ] && printf '%s\n' "$health_body"

# ── BRAIN-2 anchor visibility (warn-only, silent on the happy path) ──────────
# A missing delta anchor is exactly why an `agent mode -min` boot degrades to
# the stale blank-agent brief while this banner prints a healthy-looking brain
# — the failure mode that rode 7 sessions unresolved and cost a whole session
# re-deriving settled policy. Name it, and only when it is actually wrong: on
# the happy path this prints nothing, so the banner keeps its 3-line budget.
for _brainlib in "$ROOT/scripts/lib/brain.sh" "$ROOT/AI/scripts/lib/brain.sh"; do
    [ -f "$_brainlib" ] && . "$_brainlib" && break
done
if command -v brain_last_anchor >/dev/null 2>&1; then
    _ns=$(brain_repo_name 2>/dev/null)
    if [ -n "$_ns" ] && [ -z "$(brain_last_anchor "$_ns" 2>/dev/null)" ]; then
        printf '   %sanchor:%s %sNONE%s %sfor %s — brain_delta({repo}) will degrade to the compiled brief. Pass an explicit since, and check wrap-up ran brain_merge on a real session branch.%s\n' \
            "$D" "$R" "$Y" "$R" "$D" "$_ns" "$R"
    fi
fi
exit 0
