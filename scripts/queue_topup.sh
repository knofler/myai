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
#   scripts/queue_topup.sh --seed-ledger [--dry-run]
#                                        one-shot backfill: record the title of every
#                                        live-file line before the current cursor in the
#                                        durable ledger (lines consumed before pop-time
#                                        ledger writes existed, task-75e3bb46). Idempotent.
# =============================================================================
set +e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKLOG="$ROOT/config/runner_backlog.jsonl"
# CONSUMED lives in the gateway (backlog_cursor_get/set, task-e9163eb9), NOT a
# local file — a gitignored config/.runner_backlog.cursor file read CONSUMED=0
# on any fresh checkout/worktree regardless of the real consumption state on
# whichever machine actually drives the runner, so --report and the
# low-backlog check disagreed depending on which machine ran them.
FLOOR="${RUNNER_QUEUE_FLOOR:-12}"
BACKLOG_MIN="${RUNNER_BACKLOG_MIN:-6}"
DRY=false
REPORT=false
SUMMARY=false
SEED_LEDGER=false
while [ $# -gt 0 ]; do case "$1" in --dry-run) DRY=true;; --floor) shift; FLOOR="${1:-12}";; --report) REPORT=true;; --summary) REPORT=true; SUMMARY=true;; --seed-ledger) SEED_LEDGER=true;; esac; shift; done

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
  CONSUMED=$(gw_backlog_cursor_get)
  if [ -z "$CONSUMED" ]; then
    if [ "$(gw_classify_failure "http://localhost:3100/mcp" 8)" = "auth-fail" ]; then
      gw_warn_auth_fail "queue_topup --report backlog_cursor_get"
      [ "$SUMMARY" = true ] || log "report: GATEWAY AUTH FAILURE (401/403) — cannot read the backlog cursor; NOT a genuine 0-consumed, fix GATEWAY_LOCAL_TOKEN"
    else
      [ "$SUMMARY" = true ] || log "report: gateway unreachable — cannot read the backlog cursor"
    fi
    return 0
  fi
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

# =============================================================================
# --seed-ledger (task-75e3bb46): one-shot backfill of the durable ledger.
#
# Until task-75e3bb46 the pop loop recorded only DEDUPE-SKIPPED titles in the
# ledger — never the ones it actually enqueued — so the ledger held a sparse
# sample (~280 of 764 consumed lines on 2026-10-22) and the self-heal walk still
# stopped at the first aged-out, never-ledgered line and rewound the cursor.
# Pop-time writes close that for every line consumed from now on; this flag
# closes it for history by trusting the CURRENT cursor (the same trust every
# pop already places in it) for the live file's prefix. Archived lines are not
# seeded: they sit before the live file, so neither walk ever reaches them.
# =============================================================================
if [ "$SEED_LEDGER" = true ]; then
  [ -f "$BACKLOG" ] || { log "seed-ledger: no backlog file ($BACKLOG) — nothing to seed"; exit 0; }
  CONSUMED=$(gw_backlog_cursor_get)
  if [ -z "$CONSUMED" ]; then
    log "seed-ledger: could not read the backlog cursor from the gateway — nothing seeded"
    exit 1
  fi
  SEED_OFFSET=$(( CONSUMED - $(archived_total) )); [ "$SEED_OFFSET" -lt 0 ] && SEED_OFFSET=0
  SEED_FILE="$(mktemp -t queue-topup-seed.XXXXXX)"
  trap 'rm -f "$SEED_FILE"' EXIT
  OFFSET="$SEED_OFFSET" /usr/bin/python3 -c '
import sys, os, json
offset = int(os.environ["OFFSET"])
n = 0
for raw in open(sys.argv[1]):
    s = raw.strip()
    if not s or s.startswith("#"):
        continue
    if n >= offset:
        break
    n += 1
    try:
        t = json.loads(s).get("title", "")
    except Exception:
        t = ""
    if t:
        print(t.replace("\n", " ").replace("\r", " "))
' "$BACKLOG" > "$SEED_FILE"
  SEED_COUNT=$(grep -c . "$SEED_FILE")
  if [ "$DRY" = true ]; then
    log "seed-ledger (dry run): would record $SEED_COUNT title(s) from the first $SEED_OFFSET live backlog line(s) (cursor $CONSUMED)"
    exit 0
  fi
  if [ "$SEED_COUNT" -eq 0 ]; then
    log "seed-ledger: cursor $CONSUMED covers no titled live-file lines — nothing to seed"
    exit 0
  fi
  if gw_backlog_ledger_add "$SEED_FILE" 30; then
    log "seed-ledger: recorded $SEED_COUNT title(s) from the first $SEED_OFFSET live backlog line(s) (cursor $CONSUMED) in the durable ledger"
    exit 0
  fi
  log "seed-ledger: ledger write failed — nothing seeded"
  exit 1
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

# ── backlog cursor: how many lines already consumed (gateway-backed, task-e9163eb9) ──
[ -f "$BACKLOG" ] || { log "no backlog file ($BACKLOG) — nothing to draw from"; exit 0; }
ARCHIVED=$(archived_total)
TOTAL=$(( $(grep -cvE '^\s*(#|$)' "$BACKLOG" 2>/dev/null || echo 0) + ARCHIVED ))
CONSUMED=$(gw_backlog_cursor_get)
if [ -z "$CONSUMED" ]; then
  # PENDING above already proved the gateway was reachable moments ago — a
  # get failure here is a transient race, not "no cursor yet". Bail rather
  # than assume 0, which would re-pop already-consumed items.
  log "could not read backlog cursor from the gateway — skipping top-up this cycle (runner will retry)"
  exit 0
fi
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
# --permission-mode auto`, i.e. classifier-gated but prompt-free Bash + MCP tool access,
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
#
# LEDGER FLOOR (task-aa331af6, durable fix for the 608->957 churn): the
# canary above only catches TOTAL staleness of the list. It does nothing for
# the much more common case where the list is fine for most titles but ONE
# early one has aged out of the limit:2000 window on THIS cycle's fetch —
# that alone stops the confirmed-prefix walk right there, rewinding the
# cursor across a whole span of genuinely-consumed lines. Worse, the cap
# keeps moving as the fleet-wide task table grows, so ANY tasks_list-window
# confirmation has this bug latent in it forever. Fix: consult the durable
# consumed-titles ledger (backlog_ledger_get/add, task-aa331af6) alongside
# tasks_list. A title counts as confirmed if EITHER source has it, and the
# confirmed-prefix computed from the ledger ALONE (never touched by window
# size) is a floor the corrected cursor may never go below. Every title
# newly confirmed this cycle — via the leading-prefix walk OR found anywhere
# else in the file — is written back to the ledger so it can never need
# tasks_list to reconfirm it again.
if [ "$REMAINING" -lt 1 ]; then
  HEAL_TASKS_JSON=$(curl -sf -m 15 -X POST http://localhost:3100/mcp \
    -H 'content-type: application/json' \
    -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"tasks_list","arguments":{"limit":2000}},"id":1}' 2>/dev/null)
  if [ -n "$HEAL_TASKS_JSON" ]; then
    LEDGER_FILE="$(mktemp -t queue-topup-ledger.XXXXXX)"
    gw_backlog_ledger_get 15 > "$LEDGER_FILE" 2>/dev/null
    # shellcheck disable=SC2016  # python body is single-quoted deliberately — values arrive via the env prefix, not shell expansion
    HEAL_RESULT=$(BACKLOG="$BACKLOG" ARCHIVE_DIR="$ROOT/config/archive" LEDGER_FILE="$LEDGER_FILE" /usr/bin/python3 -c '
import sys, os, json, glob
backlog_path = os.environ["BACKLOG"]
archive_dir = os.environ.get("ARCHIVE_DIR", "")
ledger_file = os.environ.get("LEDGER_FILE", "")
tasks_raw = sys.stdin.read()
try:
    payload = json.loads(tasks_raw)
    text = payload["result"]["content"][0]["text"]
    parsed = json.loads(text)
    tasks = parsed if isinstance(parsed, list) else parsed.get("tasks", [])
except Exception:
    tasks = []
known_titles = set(t.get("title", "") for t in tasks if t.get("title"))

# Durable ledger (task-aa331af6) — best-effort, empty set when unreadable
# (gateway not yet carrying this tool, or the fetch failed); the walk then
# falls back to known_titles only, i.e. pre-fix behaviour.
ledger_titles = set()
if ledger_file and os.path.exists(ledger_file):
    with open(ledger_file) as f:
        for line in f:
            line = line.rstrip("\n")
            if line:
                ledger_titles.add(line)

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

# Two walks over the same file:
#  - `confirmed` (ledger ∪ tasks_list): the best current knowledge, used for
#    the cursor correction itself. Must remain a strict, stoppable
#    contiguous-prefix walk — a gap can be a genuinely unconsumed item.
#  - `ledger_floor` (ledger ALONE): a hard floor the correction may never go
#    below, since ledger membership can never age out the way a
#    tasks_list-window confirmation can.
confirmed = 0
ledger_floor = 0
stopped = False
floor_stopped = False
new_ledger_titles = set()
for raw in open(backlog_path):
    s = raw.strip()
    if not s or s.startswith("#"):
        continue
    try:
        obj = json.loads(s)
        title = obj.get("title", "")
    except Exception:
        # a genuinely malformed non-comment line cannot be title-matched —
        # treat as not-yet-confirmed (never counts toward either prefix).
        title = None

    if not floor_stopped:
        if title and title in ledger_titles:
            ledger_floor += 1
        else:
            floor_stopped = True

    if not stopped:
        if title and (title in known_titles or title in ledger_titles):
            confirmed += 1
        else:
            stopped = True

    # Ledger seeding: record EVERY line whose exact title tasks_list can
    # currently confirm, not just the leading contiguous run — this cycle
    # may be the only chance to capture a title before it ages out of a
    # LATER cycle'"'"'s window.
    if title and title in known_titles and title not in ledger_titles:
        new_ledger_titles.add(title)

print("CONFIRMED\x1f%d" % confirmed)
print("LEDGER_FLOOR\x1f%d" % ledger_floor)
for t in sorted(new_ledger_titles):
    print("NEWTITLE\x1f%s" % t.replace("\x1f", " "))
' <<<"$HEAL_TASKS_JSON")
    HEAL_STATUS_LINE="$(printf '%s\n' "$HEAL_RESULT" | head -1 | tr -d '[:space:]')"
    if [ "$HEAL_STATUS_LINE" = "SKIP" ]; then
      log "self-heal check: gateway task list can't confirm even the already-archived titles — treating it as stale/reconciled right now and leaving cursor as-is (see task-fabf3ec4)"
    else
      NEW_LEDGER_TITLES_FILE="$(mktemp -t queue-topup-new-ledger.XXXXXX)"
      HEAL_CONFIRMED=""
      HEAL_LEDGER_FLOOR=""
      # \x1f-delimited "KIND\x1fvalue" lines, same convention as the pop
      # loop's SCANNED/ITEM/MALFORMED parsing below.
      while IFS=$'\x1f' read -r kind val; do
        case "$kind" in
          CONFIRMED) HEAL_CONFIRMED="$val" ;;
          LEDGER_FLOOR) HEAL_LEDGER_FLOOR="$val" ;;
          NEWTITLE) printf '%s\n' "$val" >> "$NEW_LEDGER_TITLES_FILE" ;;
        esac
      done <<<"$HEAL_RESULT"
      if [ -n "$HEAL_CONFIRMED" ] && [ -n "$HEAL_LEDGER_FLOOR" ]; then
        # Never correct below the ledger floor (task-aa331af6) — it is the
        # one number here that cannot regress as the task table grows.
        SAFE_CONFIRMED="$HEAL_CONFIRMED"
        [ "$HEAL_LEDGER_FLOOR" -gt "$SAFE_CONFIRMED" ] && SAFE_CONFIRMED="$HEAL_LEDGER_FLOOR"
        NEW_CONSUMED=$(( SAFE_CONFIRMED + ARCHIVED ))
        if [ "$NEW_CONSUMED" -lt "$CONSUMED" ]; then
          log "self-heal: cursor was $CONSUMED but only $SAFE_CONFIRMED backlog line(s) are confirmed consumed (tasks_list=$HEAL_CONFIRMED, ledger floor=$HEAL_LEDGER_FLOOR) — correcting cursor to $NEW_CONSUMED (file drifted, see task-08dbc72f)"
          CONSUMED="$NEW_CONSUMED"
          gw_backlog_cursor_set "$CONSUMED" || log "self-heal: failed to persist corrected cursor ($CONSUMED) to the gateway — will retry next cycle"
          REMAINING=$(( TOTAL - CONSUMED ))
        fi
        if [ -s "$NEW_LEDGER_TITLES_FILE" ]; then
          if gw_backlog_ledger_add "$NEW_LEDGER_TITLES_FILE" 15; then
            log "self-heal: recorded $(grep -c . "$NEW_LEDGER_TITLES_FILE") newly-confirmed title(s) to the durable ledger (task-aa331af6)"
          else
            log "self-heal: failed to persist newly-confirmed titles to the ledger — will re-derive from tasks_list next cycle"
          fi
        fi
      fi
      rm -f "$NEW_LEDGER_TITLES_FILE"
    fi
    rm -f "$LEDGER_FILE"
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
      "$SCRIPT_DIR/schedule_task.sh" --repo ai_management --priority P1 --agent product-manager --model claude-fable-5 --model-preference \
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

# ── exact-title dedupe set (task-e0047396, 2026-09-14 — found on the SEVENTH
# dispatch of the same already-resolved item): cursor position ≥ CONSUMED is
# NOT proof a line was never popped. The self-heal above can only
# title-confirm lines still visible in tasks_list (hard-capped at limit:2000 —
# older records age out of the window), so its "confirmed prefix" stops at the
# first aged-out title and rewinds the cursor across a span of
# genuinely-consumed lines; every later top-up then re-enqueues those lines as
# brand-new task UUIDs. Observed in runner.out 2026-09-12..14: cursor rewound
# 957→608 on seven consecutive exhaustion cycles, re-dispatching the
# mongo-mirror-status.json decision 7×, gateway-contract 4×, webhook
# idempotency 3× — one full LLM session burned per re-pop. The pop loop below
# therefore checks each candidate's EXACT title against the gateway list (any
# status, any repo — schedule_task.sh passes --title through to tasks_create
# verbatim, the same positive proof the self-heal's own prefix walk relies
# on) and SKIPS lines that already have a task record instead of
# re-dispatching them. The cursor still advances by SCANNED, so a skipped
# line is walked past permanently. Fail-open: list unfetchable → empty set →
# behavior unchanged (this is a guard against re-pops, never a gate that can
# starve the queue; a title aged out of the 2000-window re-pops once, and its
# fresh record then blocks every subsequent re-pop).
KNOWN_TITLES_FILE="$(mktemp -t queue-topup-known-titles.XXXXXX)"
# Titles to record in the durable ledger (task-aa331af6) at the end of this
# cycle: every line the dedupe gate skips because tasks_list positively shows
# its task, AND (task-75e3bb46) every line this cycle actually enqueues. The
# second half is the durable fix: before it, a line consumed by a normal pop
# was never ledgered, so once its task aged out of the limit:2000 window the
# self-heal walk could not confirm it and rewound the cursor across it
# (957->608 churn, ~1 re-added line per 10-min cycle).
POP_LEDGER_FILE="$(mktemp -t queue-topup-pop-ledger.XXXXXX)"
# The ledger itself, so the dedupe gate also skips titles consumed long ago
# whose tasks are no longer in the window — a rewind can then never re-dispatch
# a consumed line, it can only walk past it.
LEDGER_TITLES_FILE="$(mktemp -t queue-topup-ledger-titles.XXXXXX)"
trap 'rm -f "$KNOWN_TITLES_FILE" "$POP_LEDGER_FILE" "$LEDGER_TITLES_FILE"' EXIT
gw_backlog_ledger_get 15 > "$LEDGER_TITLES_FILE" 2>/dev/null || : > "$LEDGER_TITLES_FILE"
DEDUPE_RAW="${HEAL_TASKS_JSON:-}"   # reuse the self-heal's fetch when it ran this cycle
if [ -z "$DEDUPE_RAW" ]; then
  DEDUPE_RAW=$(curl -sf -m 15 -X POST http://localhost:3100/mcp \
    -H 'content-type: application/json' \
    -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"tasks_list","arguments":{"limit":2000}},"id":1}' 2>/dev/null)
fi
if [ -n "$DEDUPE_RAW" ]; then
  printf '%s' "$DEDUPE_RAW" | /usr/bin/python3 -c '
import sys, json
try:
    d = json.loads(json.load(sys.stdin)["result"]["content"][0]["text"])
    tasks = d if isinstance(d, list) else d.get("tasks", [])
except Exception:
    tasks = []
for t in tasks:
    ti = t.get("title", "")
    if ti:
        sys.stdout.write(ti.replace("\n", " ").replace("\r", " ") + "\n")
' > "$KNOWN_TITLES_FILE" 2>/dev/null
fi

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
SKIPPED_DUP=0
# \x1f (unit separator), NOT tab: tab is IFS whitespace, so bash collapses a
# run of tabs into one delimiter and drops empty fields — an item with an empty
# agent or desc would shift every later field left, landing the draft date in
# the wrong variable. (Same defect fixed in reconcile_review_tasks.sh, where it
# silently broke the per-task ancestor check.) \x1f is not IFS whitespace.
while IFS=$'\x1f' read -r kind a b c d e f; do
  case "$kind" in
    MALFORMED)
      log "backlog line #$((a)) is not valid JSON, skipping (logged, not treated as end-of-backlog): $b — ${c:0:100}"
      ;;
    ITEM)
      repo="$a"; title="$b"; priority="$c"; agent="$d"; desc="$e"; drafted="${f:-}"
      [ -n "$title" ] || continue
      # ── exact-title dedupe gate (task-e0047396): a task record with this
      # exact title already exists in the gateway (any status) — this line is
      # a re-pop of consumed work (cursor rewind / stale file), not new work.
      # Skip the enqueue; SCANNED still advances the cursor past it.
      if [ -s "$LEDGER_TITLES_FILE" ] && grep -Fxq -- "$title" "$LEDGER_TITLES_FILE" 2>/dev/null; then
        SKIPPED_DUP=$(( SKIPPED_DUP + 1 ))
        log "skip (title already in the consumed ledger): [$repo/$priority] $title"
        continue
      fi
      if [ -s "$KNOWN_TITLES_FILE" ] && grep -Fxq -- "$title" "$KNOWN_TITLES_FILE" 2>/dev/null; then
        SKIPPED_DUP=$(( SKIPPED_DUP + 1 ))
        printf '%s\n' "$title" >> "$POP_LEDGER_FILE"
        log "skip (exact-title task already in gateway): [$repo/$priority] $title"
        continue
      fi
      # ── prior-art check (the duplicate-dispatch gate) ───────────────────
      # A well line is dupe-checked by the PLANNER at DRAFT time and consumed
      # weeks later; nothing re-checked in between, so work shipped in the gap
      # reached the runner as live work (2026-09-03: 4 of 5 sessions burned
      # re-verifying already-shipped items; 6f438513 the cycle before).
      # ADVISORY ONLY — it never drops an item: measured on this repo the
      # metric ranks the true shipping commit #1 but at only 0.50-0.80, while
      # many genuinely-new lines also score high, so it is too noisy to carry
      # a silent skip. Instead the top-ranked commit is attached to the
      # description so the agent checks ONE commit and stops early if covered.
      if [ -x "$SCRIPT_DIR/backlog_prior_art.py" ]; then
        _pa_args=""
        [ -n "$drafted" ] && _pa_args="--since $drafted"
        # shellcheck disable=SC2086
        _pa=$(/usr/bin/python3 "$SCRIPT_DIR/backlog_prior_art.py" --repo "$repo" --title "$title" $_pa_args --json 2>/dev/null)
        if [ -n "$_pa" ]; then
          _pre=$(printf '%s' "$_pa" | /usr/bin/python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
    sys.stdout.write(d.get("preamble","") if d.get("match") else "")
except Exception:
    pass' 2>/dev/null)
          if [ -n "$_pre" ]; then
            # $( ) strips the preamble's trailing blank line, so re-add the
            # separator explicitly — otherwise the hint runs into the first
            # sentence of the real description.
            desc="${_pre}"$'\n\n'"${desc}"
            log "prior-art hint attached to [$repo] $title"
          fi
        fi
      fi
      if [ "$DRY" = true ]; then log "would enqueue [$repo/$priority] $title"
      else
        if "$SCRIPT_DIR/schedule_task.sh" --repo "$repo" --title "$title" --priority "$priority" --agent "$agent" --model claude-fable-5 --model-preference --desc "$desc" >/dev/null 2>&1; then
          log "enqueued [$repo/$priority] $title"
          printf '%s\n' "$title" >> "$POP_LEDGER_FILE"   # consumed — record it durably (task-75e3bb46)
        fi
      fi
      POPPED=$(( POPPED + 1 ))
      ;;
    SCANNED)
      SCANNED="$a"
      ;;
  esac
done < <(OFFSET="$OFFSET" NEED="$NEED" /usr/bin/python3 -c '
import sys, os, json, re
consumed=int(os.environ["OFFSET"]); need=int(os.environ["NEED"])
# Walk the file once, keeping the filtered (non-comment/blank) list EXACTLY as
# before so the cursor keeps indexing it identically — but remember, per kept
# line, the date of the most recent "PLANNER refill YYYY-MM-DD" comment above
# it. That comment is the line DRAFT date, and it bounds the prior-art scan to
# commits that landed AFTER drafting (see scripts/backlog_prior_art.py).
_DATE=re.compile(r"(\d{4}-\d{2}-\d{2})")
lines=[]; dates=[]; cur=""
for l in open(sys.argv[1]):
    s=l.strip()
    if not s:
        continue
    if s.startswith("#"):
        if "refill" in s.lower():
            m=_DATE.search(s)
            if m: cur=m.group(1)
        continue
    lines.append(l); dates.append(cur)
emitted=0
scanned=0
i=consumed
while i < len(lines) and emitted < need:
    l = lines[i]; d = dates[i]; i += 1; scanned += 1
    try:
        o = json.loads(l)
        title = o.get("title", "")
        if not title:
            raise ValueError("missing/empty title")
    except Exception as e:
        print("MALFORMED\x1f%d\x1f%s\x1f%s" % (consumed + scanned, str(e).replace("\x1f", " "), l.strip().replace("\x1f", " ")))
        continue
    print("ITEM\x1f" + "\x1f".join([o.get("repo","ai_management"), title.replace("\x1f"," "), o.get("priority","P2"), o.get("agent","dev-fullstack"), o.get("desc","").replace("\x1f"," ").replace("\n"," "), d]))
    emitted += 1
print("SCANNED\x1f%d" % scanned)
' "$BACKLOG")

# Ledger BEFORE cursor: if the cursor write then fails, the next cycle re-scans
# this window and the dedupe gate skips every title recorded here instead of
# re-enqueueing it.
if [ "$DRY" != true ] && [ -s "$POP_LEDGER_FILE" ]; then
  gw_backlog_ledger_add "$POP_LEDGER_FILE" 15 || log "failed to persist $(grep -c . "$POP_LEDGER_FILE") consumed title(s) to the ledger — the next self-heal may rewind across them"
fi
if [ "$DRY" != true ] && [ "$SCANNED" -gt 0 ]; then
  gw_backlog_cursor_set $(( CONSUMED + SCANNED )) || log "failed to persist backlog cursor ($(( CONSUMED + SCANNED ))) to the gateway — next cycle will re-scan this window"
fi
DUP_NOTE=""; [ "$SKIPPED_DUP" -gt 0 ] && DUP_NOTE=", $SKIPPED_DUP duplicate(s) skipped"
log "topped up: $POPPED item(s) enqueued$DUP_NOTE (backlog cursor now $(( CONSUMED + SCANNED ))/$TOTAL)"
exit 0
