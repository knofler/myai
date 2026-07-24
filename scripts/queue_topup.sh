#!/usr/bin/env bash
# =============================================================================
# queue_topup.sh — keep the runner queue NEVER EMPTY (operator directive 2026-07-05).
#
# The runner idles the moment pending==0. This tops the queue back up from a
# curated backlog well the instant it drops below a floor, so the runner always
# has prioritized work. Two-level "never empty":
#   1. Queue low  (< FLOOR pending) → pop the next batch from config/runner_backlog.jsonl
#      and enqueue via schedule_task.sh (which enforces the consent/ignore list).
#   2. Backlog low (< PLANNER_FLOOR unconsumed) → enqueue ONE planner task that
#      regenerates the backlog from the plan docs + repo state — the infinite well.
#
# Called at the START of every cli_task_runner.sh fire (before the claim), so a
# fire that would have idled tops up and then claims — zero idle gap. Also safe
# to run by hand / from a session hook. Idempotent, non-fatal, respects consent.
#
#   RUNNER_QUEUE_FLOOR   (default 12)  top the pending queue up to at least this
#   RUNNER_BACKLOG_MIN   (default 6)   below this many unconsumed backlog items → planner
#   scripts/queue_topup.sh [--dry-run] [--floor N]
#   scripts/queue_topup.sh --report     drift report only (see report_mode below), no top-up
# =============================================================================
set +e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKLOG="$ROOT/config/runner_backlog.jsonl"
CURSOR="$ROOT/config/.runner_backlog.cursor"   # gitignored — machine-local consumed count
FLOOR="${RUNNER_QUEUE_FLOOR:-12}"
BACKLOG_MIN="${RUNNER_BACKLOG_MIN:-6}"
DRY=false
REPORT=false
while [ $# -gt 0 ]; do case "$1" in --dry-run) DRY=true;; --floor) shift; FLOOR="${1:-12}";; --report) REPORT=true;; esac; shift; done

. "$SCRIPT_DIR/lib/gateway.sh" 2>/dev/null || true
log(){ echo "[queue-topup $(TZ=Australia/Sydney date '+%H:%M AEST')] $*"; }

# =============================================================================
# --report: PLANNER drift report (operator directive 2026-07-24).
#
# The planner path above only ever counts REMAINING = TOTAL - CONSUMED to decide
# whether the backlog well is running low. That tells you how many backlog lines
# haven't been POPPED yet — it says nothing about whether the lines that WERE
# popped actually turned into shipped work. A backlog item can be "consumed"
# (cursor advanced past it) yet: (a) still legitimately in flight (pending/
# working/review/blocked), (b) done — the good outcome, or (c) genuinely stale —
# schedule_task.sh was called for it but no matching task shows up anywhere in
# the gateway (silent enqueue failure, task later pruned without shipping, etc).
# Only (c) is the actual planner blind spot this report exists to surface.
#
# Matching is by exact task title — schedule_task.sh passes --title through to
# tasks_create verbatim (see schedule_task.sh), so a backlog item's "title"
# field is expected to appear unmodified on its corresponding gateway task.
# =============================================================================
report_mode() {
  [ -f "$BACKLOG" ] || { log "report: no backlog file ($BACKLOG) — nothing to report on"; return 0; }
  CONSUMED=$(cat "$CURSOR" 2>/dev/null | tr -cd '0-9'); [ -z "$CONSUMED" ] && CONSUMED=0
  if [ "$CONSUMED" -lt 1 ] 2>/dev/null; then
    log "report: 0 items consumed yet (cursor=$CONSUMED) — nothing to diff"
    return 0
  fi

  # Full task list, every status, every repo — classify consumed backlog items
  # against it client-side (tasks_list has no multi-status filter; omitting
  # "status" returns everything, same as fleet_resume.sh / myai_queue.sh do).
  TASKS_JSON=$(curl -sf -m 15 -X POST http://localhost:3100/mcp \
    -H 'content-type: application/json' \
    -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"tasks_list","arguments":{"limit":1000}},"id":1}' 2>/dev/null)
  if [ -z "$TASKS_JSON" ]; then
    log "report: gateway unreachable — cannot diff consumed backlog against the task log"
    return 0
  fi

  CONSUMED="$CONSUMED" /usr/bin/python3 -c '
import sys, os, json

consumed = int(os.environ["CONSUMED"])
backlog_path, tasks_raw = sys.argv[1], sys.argv[2]

lines = [l for l in open(backlog_path) if l.strip() and not l.strip().startswith("#")]
items = []
for l in lines[:consumed]:
    try:
        items.append(json.loads(l))
    except Exception:
        pass

try:
    payload = json.loads(tasks_raw)
    text = payload["result"]["content"][0]["text"]
    parsed = json.loads(text)
    tasks = parsed if isinstance(parsed, list) else parsed.get("tasks", [])
except Exception:
    tasks = []

by_title = {}
for t in tasks:
    by_title.setdefault(t.get("title", ""), []).append(t.get("status", "unknown"))

done, inflight, stale = [], [], []
for it in items:
    title = it.get("title", "")
    statuses = by_title.get(title)
    if not statuses:
        stale.append(title)
    elif "done" in statuses:
        done.append(title)
    else:
        inflight.append((title, statuses[0]))

print("=== queue_topup PLANNER drift report ===")
print(f"consumed={consumed}  done={len(done)}  in-flight={len(inflight)}  stale(missing)={len(stale)}")
if stale:
    print("--- STALE — consumed but no matching gateway task found anywhere (genuinely stale) ---")
    for t in stale:
        print(f"  - {t}")
if inflight:
    print("--- IN-FLIGHT — consumed, still pending/working/review/blocked (not stale) ---")
    for t, s in inflight:
        print(f"  - [{s}] {t}")
' "$BACKLOG" "$TASKS_JSON"
  return 0
}

if [ "$REPORT" = true ]; then
  report_mode
  exit 0
fi

# ── pending count across all repos (gateway; fail-safe to 0 = assume empty) ──
PENDING=$(curl -sf -m 8 -X POST http://localhost:3100/mcp \
  -H 'content-type: application/json' \
  -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"tasks_list","arguments":{"status":"pending","limit":500}},"id":1}' 2>/dev/null \
  | /usr/bin/python3 -c 'import sys,json
try:
    t=json.load(sys.stdin)["result"]["content"][0]["text"]
    d=json.loads(t); print(len(d if isinstance(d,list) else d.get("tasks",[])))
except Exception: print(-1)' 2>/dev/null)
[ -z "$PENDING" ] && PENDING=-1

if [ "$PENDING" = "-1" ]; then log "gateway unreachable — skipping top-up (runner will retry)"; exit 0; fi
if [ "$PENDING" -ge "$FLOOR" ] 2>/dev/null; then exit 0; fi   # queue healthy — nothing to do

log "queue low: $PENDING pending (floor $FLOOR) — topping up"

# ── backlog cursor: how many lines already consumed ──
[ -f "$BACKLOG" ] || { log "no backlog file ($BACKLOG) — nothing to draw from"; exit 0; }
TOTAL=$(grep -cvE '^\s*(#|$)' "$BACKLOG" 2>/dev/null || echo 0)
CONSUMED=$(cat "$CURSOR" 2>/dev/null | tr -cd '0-9'); [ -z "$CONSUMED" ] && CONSUMED=0
REMAINING=$(( TOTAL - CONSUMED ))

# Backlog running low → enqueue the planner task to regenerate it (once).
# THROTTLE (2026-07-06 fix): the planner completes pending→working→review within a
# fire window, so the "already-pending" guard alone let it re-fire every cycle
# (observed 20× in one morning, burning Opus tokens on redundant regenerations).
# Cap planner enqueues to once per PLANNER_THROTTLE_HRS via a stamp file, in
# ADDITION to the pending-guard. Belt-and-suspenders.
#
# OPT-IN GATE + HARD BOUNDARY (2026-07-20 fix — root cause of the connect overnight
# incident, observed 2026-07-06 and again 2026-07-07): the planner task runs as a
# fully-autonomous LLM session (cli_task_runner.sh spawns it with `claude -p
# --permission-mode bypassPermissions`, i.e. unrestricted Bash + MCP tool access,
# same as any other queued task). Its charter was only ever "append lines to
# config/runner_backlog.jsonl", but nothing stopped the session from instead
# calling tasks_create/tasks_update directly against the live gateway queue —
# which is exactly what happened: it wrote a 14-task speculative roadmap straight
# into connect's queue and mass-flipped connect's 20 curated pending tasks to
# `blocked`, displacing them and idling the runner overnight, both times. It was
# never a cron schedule (schedules_list showed 0 jobs) — it was this auto-enqueued
# task overreaching its own instructions. Two independent fixes:
#   1. Auto-generation is now opt-in (RUNNER_PLANNER_AUTOGEN=1). By default the
#      runner only LOGS that the backlog is low and leaves it for a human to
#      regenerate deliberately — no unattended write access is granted overnight.
#   2. When explicitly enabled, the prompt now carries an explicit hard boundary
#      forbidding tasks_create/tasks_update and any status change to existing
#      tasks — the only writes it may make are to the backlog file + its commit.
PLANNER_AUTOGEN="${RUNNER_PLANNER_AUTOGEN:-0}"
PLANNER_STAMP="$ROOT/config/.runner_planner.stamp"
PLANNER_THROTTLE_HRS="${RUNNER_PLANNER_THROTTLE_HRS:-6}"
if [ "$REMAINING" -le "$BACKLOG_MIN" ]; then
  if [ "$PLANNER_AUTOGEN" != "1" ]; then
    log "backlog low ($REMAINING left) but planner auto-generation is opt-in (set RUNNER_PLANNER_AUTOGEN=1 to enable) — skipping; regenerate config/runner_backlog.jsonl by hand or opt in."
  else
  _throttled=false
  if [ -f "$PLANNER_STAMP" ]; then
    _age=$(( $(date +%s) - $(cat "$PLANNER_STAMP" 2>/dev/null | tr -cd '0-9' || echo 0) ))
    [ "$_age" -lt $(( PLANNER_THROTTLE_HRS * 3600 )) ] 2>/dev/null && _throttled=true
  fi
  if [ "$DRY" = true ]; then log "would enqueue PLANNER (backlog remaining=$REMAINING ≤ $BACKLOG_MIN; throttled=$_throttled)"
  elif [ "$_throttled" = true ]; then
    log "backlog low ($REMAINING) but planner throttled (< ${PLANNER_THROTTLE_HRS}h since last) — skipping regen"
  else
    PLANNER_TITLE="PLANNER: regenerate config/runner_backlog.jsonl from plan docs + repo state (keep the well full)"
    # avoid duplicate planner tasks: skip if one is already pending
    EXISTS=$(curl -sf -m 8 -X POST http://localhost:3100/mcp -H 'content-type: application/json' -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
      -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"tasks_list","arguments":{"repo":"ai_management","status":"pending","limit":500}},"id":1}' 2>/dev/null \
      | /usr/bin/python3 -c 'import sys,json
try:
    d=json.loads(json.load(sys.stdin)["result"]["content"][0]["text"])
    print(sum(1 for t in (d if isinstance(d,list) else d.get("tasks",[])) if "PLANNER: regenerate" in t.get("title","")))
except Exception: print(0)' 2>/dev/null)
    if [ "${EXISTS:-0}" = "0" ]; then
      date +%s > "$PLANNER_STAMP"
      "$SCRIPT_DIR/schedule_task.sh" --repo ai_management --priority P1 --agent product-manager --model claude-fable-5 \
        --title "$PLANNER_TITLE" \
        --desc "The runner-backlog well (config/runner_backlog.jsonl) is running low. Read plan/GRAND_PRODUCT_ROADMAP.md, plan/PRODUCTION_MVP_SPRINT.md, plan/GAP_BACKLOG_SCHEDULE.md, each core repo's AI/state + AI/plan, and the current queue; APPEND 20-40 fresh, runner-sized, prioritized {repo,title,priority,agent,desc} JSONL lines to config/runner_backlog.jsonl (core repos first: ai_management/agentFlow/connect; playground P2-capped; respect config/schedule_ignore.txt). Do NOT duplicate already-queued or already-shipped work. Before appending, draft your batch to a JSONL file and run 'python3 scripts/backlog_dupe_check.py --candidates <your-draft.jsonl>' — it flags likely near-duplicate titles already in the backlog (token-overlap check) so you can drop them before appending; it does not catch everything, use judgement on what it flags. This keeps the runner never-empty (operator directive). Commit the backlog append. HARD BOUNDARY (non-negotiable): the ONLY write actions this task may take are (1) appending JSONL lines to config/runner_backlog.jsonl and (2) committing that file. You MUST NOT call the tasks_create or tasks_update MCP tools, MUST NOT run schedule_task.sh or curl the gateway to create or modify tasks, and MUST NOT change the status of any existing task — pending, blocked, or otherwise — in this or any other repo. New backlog items reach the live queue later, ONLY via this same queue_topup.sh script's own pop path. If an existing pending task looks stale or superseded, say so in your commit message for a human to review — never touch its status yourself." >/dev/null 2>&1 \
        && log "backlog low ($REMAINING left) → enqueued PLANNER to regenerate it"
    fi
  fi
  fi
fi

# ── pop the next (FLOOR - PENDING) items from the backlog and enqueue ──
NEED=$(( FLOOR - PENDING )); [ "$NEED" -lt 1 ] && exit 0
[ "$REMAINING" -lt 1 ] && { log "backlog exhausted (planner queued) — no items to pop this cycle"; exit 0; }
[ "$NEED" -gt "$REMAINING" ] && NEED="$REMAINING"

# emit the next $NEED non-comment lines starting after $CONSUMED, as TSV the shell can read
POPPED=0
while IFS=$'\t' read -r repo title priority agent desc; do
  [ -n "$title" ] || continue
  if [ "$DRY" = true ]; then log "would enqueue [$repo/$priority] $title"
  else
    "$SCRIPT_DIR/schedule_task.sh" --repo "$repo" --title "$title" --priority "$priority" --agent "$agent" --model claude-fable-5 --desc "$desc" >/dev/null 2>&1 \
      && log "enqueued [$repo/$priority] $title"
  fi
  POPPED=$(( POPPED + 1 ))
done < <(CONSUMED="$CONSUMED" NEED="$NEED" /usr/bin/python3 -c '
import sys, os, json
consumed=int(os.environ["CONSUMED"]); need=int(os.environ["NEED"])
lines=[l for l in open(sys.argv[1]) if l.strip() and not l.strip().startswith("#")]
for l in lines[consumed:consumed+need]:
    try:
        o=json.loads(l)
        print("\t".join([o.get("repo","ai_management"),o.get("title","").replace("\t"," "),o.get("priority","P2"),o.get("agent","dev-fullstack"),o.get("desc","").replace("\t"," ").replace("\n"," ")]))
    except Exception: pass
' "$BACKLOG")

if [ "$DRY" != true ] && [ "$POPPED" -gt 0 ]; then echo $(( CONSUMED + POPPED )) > "$CURSOR"; fi
log "topped up: $POPPED item(s) enqueued (backlog cursor now $(( CONSUMED + POPPED ))/$TOTAL)"
exit 0
