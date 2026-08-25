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
#   scripts/queue_topup.sh --summary    one-line drift summary only, e.g.
#                                        "planner drift: 42 done / 3 in-flight / 1 stale"
#                                        (silent — no output — when there's nothing to
#                                        report yet, so callers like the SCHEDULE banner
#                                        can splice it in without extra noise checks)
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
SUMMARY=false
while [ $# -gt 0 ]; do case "$1" in --dry-run) DRY=true;; --floor) shift; FLOOR="${1:-12}";; --report) REPORT=true;; --summary) REPORT=true; SUMMARY=true;; esac; shift; done

. "$SCRIPT_DIR/lib/gateway.sh" 2>/dev/null || true
log(){ echo "[queue-topup $(TZ=Australia/Sydney date '+%H:%M AEST')] $*"; }

# scripts/archive_runner_backlog.sh tail-rotates fully-fleet-confirmed-popped
# prefixes out of $BACKLOG into config/archive/runner_backlog-YYYY-MM.jsonl.
# CONSUMED (the local cursor) is a count over ALL history, never rewritten by
# a rotation that happens on a different machine — so TOTAL and the pop
# offset both add back the archived count to stay correct against the
# (now-shorter) current file regardless of which machine last rotated it.
archived_total() {
  local total=0 f
  for f in "$ROOT"/config/archive/runner_backlog-*.jsonl; do
    [ -f "$f" ] || continue
    total=$(( total + $(grep -cvE '^\s*(#|$)' "$f" 2>/dev/null || echo 0) ))
  done
  echo "$total"
}

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
  [ -f "$BACKLOG" ] || { [ "$SUMMARY" = true ] || log "report: no backlog file ($BACKLOG) — nothing to report on"; return 0; }
  CONSUMED=$(cat "$CURSOR" 2>/dev/null | tr -cd '0-9'); [ -z "$CONSUMED" ] && CONSUMED=0
  ARCHIVED=$(archived_total)
  CONSUMED=$(( CONSUMED - ARCHIVED )); [ "$CONSUMED" -lt 0 ] && CONSUMED=0
  if [ "$CONSUMED" -lt 1 ] 2>/dev/null; then
    [ "$SUMMARY" = true ] || log "report: 0 items consumed yet (cursor=$CONSUMED) — nothing to diff"
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
    if [ "$(gw_classify_failure "http://localhost:3100/mcp" 15)" = "auth-fail" ]; then
      gw_warn_auth_fail "queue_topup --report tasks_list"
      [ "$SUMMARY" = true ] || log "report: GATEWAY AUTH FAILURE (401/403) — cannot diff consumed backlog; NOT a genuine empty task log, fix GATEWAY_LOCAL_TOKEN"
    else
      [ "$SUMMARY" = true ] || log "report: gateway unreachable — cannot diff consumed backlog against the task log"
    fi
    return 0
  fi

  CONSUMED="$CONSUMED" SUMMARY_ONLY="$SUMMARY" /usr/bin/python3 -c '
import sys, os, json

consumed = int(os.environ["CONSUMED"])
summary_only = os.environ.get("SUMMARY_ONLY") == "true"
# tasks_raw comes from stdin, NOT argv — a full gateway task store (1000s of
# tasks) blows past ARG_MAX as an argument ("Argument list too long"). A
# here-string spills to a temp file, so there is no size limit.
backlog_path = sys.argv[1]
tasks_raw = sys.stdin.read()

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

if summary_only:
    print(f"planner drift: {len(done)} done / {len(inflight)} in-flight / {len(stale)} stale")
    sys.exit(0)

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
' "$BACKLOG" <<<"$TASKS_JSON"
  return 0
}

if [ "$REPORT" = true ]; then
  report_mode
  exit 0
fi

# ── pending count across all repos (gateway; fail-safe to 0 = assume empty) ──
PENDING_RAW=$(curl -sf -m 8 -X POST http://localhost:3100/mcp \
  -H 'content-type: application/json' \
  -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"tasks_list","arguments":{"status":"pending","limit":500}},"id":1}' 2>/dev/null)
if [ -z "$PENDING_RAW" ]; then
  if [ "$(gw_classify_failure "http://localhost:3100/mcp" 8)" = "auth-fail" ]; then
    gw_warn_auth_fail "queue_topup tasks_list(status=pending)"
    log "gateway AUTH FAILURE (401/403) — skipping top-up; this is NOT a genuinely empty queue, fix GATEWAY_LOCAL_TOKEN"
  else
    log "gateway unreachable — skipping top-up (runner will retry)"
  fi
  exit 0
fi
PENDING=$(printf '%s' "$PENDING_RAW" | /usr/bin/python3 -c 'import sys,json
try:
    t=json.load(sys.stdin)["result"]["content"][0]["text"]
    d=json.loads(t); print(len(d if isinstance(d,list) else d.get("tasks",[])))
except Exception: print(-1)' 2>/dev/null)
[ -z "$PENDING" ] && PENDING=-1

if [ "$PENDING" = "-1" ]; then log "gateway response unparseable — skipping top-up (runner will retry)"; exit 0; fi
if [ "$PENDING" -ge "$FLOOR" ] 2>/dev/null; then exit 0; fi   # queue healthy — nothing to do

log "queue low: $PENDING pending (floor $FLOOR) — topping up"

# ── backlog cursor: how many lines already consumed ──
[ -f "$BACKLOG" ] || { log "no backlog file ($BACKLOG) — nothing to draw from"; exit 0; }
ARCHIVED=$(archived_total)
TOTAL=$(( $(grep -cvE '^\s*(#|$)' "$BACKLOG" 2>/dev/null || echo 0) + ARCHIVED ))
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

# ── SELF-HEAL (task-08dbc72f): position-based REMAINING can go silently wrong
# without any malformed JSON involved. CONSUMED is a bare integer index into
# "non-comment/blank lines, file order" — it has no memory of WHICH lines it
# walked past. If the file is later edited so that lines earlier than CONSUMED
# get annotated as `#`-prefixed comments (e.g. a "STALE ENTRIES FOUND FOR
# HUMAN REVIEW" block marking already-shipped items) while new real items are
# appended elsewhere, the non-comment/blank count can net out to the SAME
# total — new, never-popped items then land at filtered-list positions the
# cursor already considers "before CONSUMED", so REMAINING reads 0 (matching
# TOTAL) while real work sits unconsumed. grep-based TOTAL and the cursor
# already agree with EACH OTHER here (that's not the bug) — they just don't
# agree with the FILE'S true state.
#
# Recompute a title-verified prefix the same way archive_runner_backlog.sh
# already does for its "confirmed contiguous prefix": walk the file in order
# and count how many leading JSON lines have an exact-title match already in
# the gateway (any repo, any status) — schedule_task.sh passes --title through
# to tasks_create verbatim, so a match means SOME machine already popped it.
# That confirmed count is the one true consumed offset; correct the cursor
# down to it when it disagrees. Only ever lowers the cursor (never raises it
# past what the file can support), so worst case on a false correction is a
# harmless duplicate re-enqueue, not lost/skipped work. Gateway-unreachable →
# skip self-heal and fall through to the pre-existing exhaustion message.
#
# CANARY (task-fabf3ec4, P0 regression fix): "title absent from the gateway
# list" is NOT proof a line was never popped — tasks get reconciled/cleaned
# server-side, and tasks_list is capped at limit:2000, so a genuinely-old
# consumed item can simply have aged out of what the gateway can still show
# us. Treating that absence as "never consumed" caused a false correction
# that re-popped 2 already-consumed items after an archive rotation (18
# phantom tasks on 2026-08-10). Before trusting the list's silence about the
# LIVE file's leading lines, sanity-check the list against titles we already
# have independent, positive proof were consumed: everything in
# config/archive/runner_backlog-*.jsonl was gateway-confirmed at archive time
# (archive_runner_backlog.sh applies this exact same title-match gate before
# rotating a line out). If NONE of those known-good archived titles are still
# findable in the CURRENT gateway list, the list itself is stale/reconciled
# right now — its silence carries no evidence either way — so skip the heal
# entirely rather than act on it. Only skip when we have archived history to
# canary against; with none (ARCHIVED=0, the original task-08dbc72f bug this
# self-heal targets), behavior is unchanged.
if [ "$REMAINING" -lt 1 ]; then
  HEAL_TASKS_JSON=$(curl -sf -m 15 -X POST http://localhost:3100/mcp \
    -H 'content-type: application/json' \
    -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"tasks_list","arguments":{"limit":2000}},"id":1}' 2>/dev/null)
  if [ -n "$HEAL_TASKS_JSON" ]; then
    HEAL_RESULT=$(BACKLOG="$BACKLOG" ARCHIVE_DIR="$ROOT/config/archive" /usr/bin/python3 -c '
import sys, os, json, glob
backlog_path = os.environ["BACKLOG"]
archive_dir = os.environ.get("ARCHIVE_DIR", "")
tasks_raw = sys.stdin.read()
try:
    payload = json.loads(tasks_raw)
    text = payload["result"]["content"][0]["text"]
    parsed = json.loads(text)
    tasks = parsed if isinstance(parsed, list) else parsed.get("tasks", [])
except Exception:
    tasks = []
known_titles = set(t.get("title", "") for t in tasks if t.get("title"))

# Canary: titles already rotated into the archive were gateway-confirmed at
# archive time. If the CURRENT list cant confirm any of them anymore, its
# silence about the live files leading lines is not trustworthy either —
# bail out with SKIP instead of a false "confirmed" count.
archived_titles = []
for fn in sorted(glob.glob(os.path.join(archive_dir, "runner_backlog-*.jsonl"))):
    try:
        for raw in open(fn):
            s = raw.strip()
            if not s or s.startswith("#"):
                continue
            try:
                t = json.loads(s).get("title", "")
            except Exception:
                t = None
            if t:
                archived_titles.append(t)
    except Exception:
        pass

if archived_titles and not any(t in known_titles for t in archived_titles):
    print("SKIP")
    sys.exit(0)

confirmed = 0
stopped = False
for raw in open(backlog_path):
    s = raw.strip()
    if not s or s.startswith("#"):
        continue
    if stopped:
        continue
    try:
        obj = json.loads(s)
        title = obj.get("title", "")
    except Exception:
        # a genuinely malformed non-comment line cannot be title-matched —
        # treat as not-yet-confirmed (never counts toward the safe prefix).
        title = None
    if title and title in known_titles:
        confirmed += 1
    else:
        stopped = True
print(confirmed)
' <<<"$HEAL_TASKS_JSON")
    HEAL_RESULT="$(printf '%s' "$HEAL_RESULT" | tr -d '[:space:]')"
    if [ "$HEAL_RESULT" = "SKIP" ]; then
      log "self-heal check: gateway task list can't confirm even the already-archived titles — treating it as stale/reconciled right now and leaving cursor as-is (see task-fabf3ec4)"
    elif [ -n "$HEAL_RESULT" ]; then
      HEAL_CONFIRMED="$(printf '%s' "$HEAL_RESULT" | tr -cd '0-9')"
      if [ -n "$HEAL_CONFIRMED" ]; then
        NEW_CONSUMED=$(( HEAL_CONFIRMED + ARCHIVED ))
        if [ "$NEW_CONSUMED" -lt "$CONSUMED" ]; then
          log "self-heal: cursor was $CONSUMED but only $HEAL_CONFIRMED backlog line(s) are gateway-confirmed consumed — correcting cursor to $NEW_CONSUMED (file drifted, see task-08dbc72f)"
          CONSUMED="$NEW_CONSUMED"
          echo "$CONSUMED" > "$CURSOR"
          REMAINING=$(( TOTAL - CONSUMED ))
        fi
      fi
    fi
  else
    log "self-heal check: gateway unreachable — cannot verify true exhaustion, trusting cursor as-is"
  fi
fi

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
    # Avoid duplicate planner tasks: skip if one is already in flight.
    # BUG FIX (2026-08-02, task-a7c44276): this used to filter status=pending
    # only. A PLANNER task spends nearly all of its life as working (claimed
    # by the runner) or review (finished, awaiting a test->main merge before
    # reconcile_review_tasks.sh's ancestor check can flip it to done) — pending
    # is just the brief moment before it's claimed. So the old guard almost
    # always saw zero matches and let the next PLANNER_THROTTLE_HRS window
    # enqueue a fresh duplicate on top of one still sitting in working/review,
    # which is exactly how multiple simultaneous PLANNER tasks piled up in
    # review for ai_management. Fetch the repo's full task list (no status
    # filter — tasks_list has no multi-status filter) and count matches whose
    # status hasn't reached a terminal state (done/dead_letter).
    EXISTS_RAW=$(curl -sf -m 8 -X POST http://localhost:3100/mcp -H 'content-type: application/json' -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
      -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"tasks_list","arguments":{"repo":"ai_management","limit":500}},"id":1}' 2>/dev/null)
    if [ -z "$EXISTS_RAW" ]; then
      if [ "$(gw_classify_failure "http://localhost:3100/mcp" 8)" = "auth-fail" ]; then
        gw_warn_auth_fail "queue_topup PLANNER dedupe-check tasks_list"
        log "backlog low ($REMAINING left) but gateway AUTH FAILURE (401/403) on the dedupe check — skipping planner enqueue this cycle rather than risk a duplicate"
      else
        log "backlog low ($REMAINING left) but gateway unreachable on dedupe check — skipping planner enqueue this cycle"
      fi
      EXISTS=1   # fail-safe: treat as "already exists" so a failed check never enqueues a possible duplicate
    else
      EXISTS=$(printf '%s' "$EXISTS_RAW" | /usr/bin/python3 -c 'import sys,json
try:
    d=json.loads(json.load(sys.stdin)["result"]["content"][0]["text"])
    inflight={"pending","working","review","blocked"}
    print(sum(1 for t in (d if isinstance(d,list) else d.get("tasks",[])) if "PLANNER: regenerate" in t.get("title","") and t.get("status") in inflight))
except Exception: print(0)' 2>/dev/null)
    fi
    if [ "${EXISTS:-0}" = "0" ]; then
      date +%s > "$PLANNER_STAMP"
      "$SCRIPT_DIR/schedule_task.sh" --repo ai_management --priority P1 --agent product-manager --model claude-fable-5 \
        --title "$PLANNER_TITLE" \
        --desc "The runner-backlog well (config/runner_backlog.jsonl) is running low. Read plan/BACKLOG_POLICY.md FIRST — it is the source of truth for routing policy (core-repos-first, playground's P2 cap, config/schedule_ignore.txt) and for what else to read/do before drafting. Then read plan/GRAND_PRODUCT_ROADMAP.md, plan/PRODUCTION_MVP_SPRINT.md, plan/GAP_BACKLOG_SCHEDULE.md, each core repo's AI/state + AI/plan, and the current queue; APPEND 20-40 fresh, runner-sized, prioritized {repo,title,priority,agent,desc} JSONL lines to config/runner_backlog.jsonl following plan/BACKLOG_POLICY.md's routing policy. Do NOT duplicate already-queued or already-shipped work. Before appending, draft your batch to a JSONL file and run 'python3 scripts/backlog_dupe_check.py --candidates <your-draft.jsonl>' — it flags likely near-duplicate titles already in the backlog (token-overlap check) so you can drop them before appending; it does not catch everything, use judgement on what it flags. This keeps the runner never-empty (operator directive). Commit the backlog append. HARD BOUNDARY (non-negotiable, see AI/documentation/AI_RULES.md §7 for the durable record): the ONLY write actions this task may take are (1) appending JSONL lines to config/runner_backlog.jsonl and (2) committing that file. You MUST NOT call the tasks_create or tasks_update MCP tools, MUST NOT run schedule_task.sh or curl the gateway to create or modify tasks, and MUST NOT change the status of any existing task — pending, blocked, or otherwise — in this or any other repo. New backlog items reach the live queue later, ONLY via this same queue_topup.sh script's own pop path. If an existing pending task looks stale or superseded, say so in your commit message for a human to review — never touch its status yourself." >/dev/null 2>&1 \
        && log "backlog low ($REMAINING left) → enqueued PLANNER to regenerate it"
    fi
  fi
  fi
fi

# ── pop the next (FLOOR - PENDING) items from the backlog and enqueue ──
NEED=$(( FLOOR - PENDING )); [ "$NEED" -lt 1 ] && exit 0
[ "$REMAINING" -lt 1 ] && { log "backlog exhausted (planner queued) — no items to pop this cycle"; exit 0; }
[ "$NEED" -gt "$REMAINING" ] && NEED="$REMAINING"

# emit the next $NEED non-comment lines starting after $CONSUMED, as TSV the shell can read.
# OFFSET is CONSUMED with the archived-away prefix subtracted back out, since
# CONSUMED counts over all history but the current (possibly rotated) file
# only holds what's left — see archived_total() above.
#
# SCANNED vs POPPED: the python side walks the filtered (non-comment/blank)
# list one line at a time from OFFSET, and for each line either emits an ITEM
# (valid JSON) or logs a MALFORMED marker and moves on — it never aborts on a
# bad line, and it never silently drops one uncounted either. It stops once
# NEED valid items are emitted or the list runs out, then reports SCANNED =
# the number of filtered-list lines it walked through (valid + malformed).
# The cursor must advance by SCANNED, not by POPPED (valid-only count) — if
# it only advanced by POPPED, any malformed line in the window would never
# get walked past on the next run, and the popper would re-scan (and re-skip)
# the same malformed line forever without making progress.
OFFSET=$(( CONSUMED - ARCHIVED )); [ "$OFFSET" -lt 0 ] && OFFSET=0
POPPED=0
SCANNED=0
while IFS=$'\t' read -r kind a b c d e; do
  case "$kind" in
    MALFORMED)
      log "backlog line #$((a)) is not valid JSON, skipping (logged, not treated as end-of-backlog): $b — ${c:0:100}"
      ;;
    ITEM)
      repo="$a"; title="$b"; priority="$c"; agent="$d"; desc="$e"
      [ -n "$title" ] || continue
      if [ "$DRY" = true ]; then log "would enqueue [$repo/$priority] $title"
      else
        "$SCRIPT_DIR/schedule_task.sh" --repo "$repo" --title "$title" --priority "$priority" --agent "$agent" --model claude-fable-5 --desc "$desc" >/dev/null 2>&1 \
          && log "enqueued [$repo/$priority] $title"
      fi
      POPPED=$(( POPPED + 1 ))
      ;;
    SCANNED)
      SCANNED="$a"
      ;;
  esac
done < <(OFFSET="$OFFSET" NEED="$NEED" /usr/bin/python3 -c '
import sys, os, json
consumed=int(os.environ["OFFSET"]); need=int(os.environ["NEED"])
lines=[l for l in open(sys.argv[1]) if l.strip() and not l.strip().startswith("#")]
emitted=0
scanned=0
i=consumed
while i < len(lines) and emitted < need:
    l = lines[i]; i += 1; scanned += 1
    try:
        o = json.loads(l)
        title = o.get("title", "")
        if not title:
            raise ValueError("missing/empty title")
    except Exception as e:
        print("MALFORMED\t%d\t%s\t%s" % (consumed + scanned, str(e).replace("\t", " "), l.strip().replace("\t", " ")))
        continue
    print("ITEM\t" + "\t".join([o.get("repo","ai_management"), title.replace("\t"," "), o.get("priority","P2"), o.get("agent","dev-fullstack"), o.get("desc","").replace("\t"," ").replace("\n"," ")]))
    emitted += 1
print("SCANNED\t%d" % scanned)
' "$BACKLOG")

if [ "$DRY" != true ] && [ "$SCANNED" -gt 0 ]; then echo $(( CONSUMED + SCANNED )) > "$CURSOR"; fi
log "topped up: $POPPED item(s) enqueued (backlog cursor now $(( CONSUMED + SCANNED ))/$TOTAL)"
exit 0
