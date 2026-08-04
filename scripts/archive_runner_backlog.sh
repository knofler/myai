#!/usr/bin/env bash
# =============================================================================
# archive_runner_backlog.sh — bound config/runner_backlog.jsonl the same way
# scripts/rotate_state.sh (AI/scripts/rotate_state.sh) bounds STATE.md: tail
# rotation into month-bucketed, grep-searchable archive files.
#
# The backlog only ever grows — the PLANNER appends, queue_topup.sh pops via a
# machine-local, gitignored cursor (config/.runner_backlog.cursor), and
# nothing ever prunes the file itself. Every PLANNER session pays the cost of
# reading a slightly larger file, and self-check/dupe-check runs get slower
# over time (config/runner_backlog.jsonl line ~1114 flagged this directly).
#
# "Fully consumed, fleet-wide" ground truth: NOT the local cursor file. A
# fresh checkout/worktree has no cursor at all and reads CONSUMED=0 regardless
# of the real state — that's the still-open 'backlog-well cursor visibility'
# gap (config/runner_backlog.jsonl line ~1043). Trying to archive based on any
# one machine's local cursor would risk deleting lines another machine hasn't
# popped yet.
#
# Instead this script reuses the cross-machine source of truth queue_topup.sh
# --report already relies on: the shared gateway's task list (mongo-backed,
# same store every machine reads). schedule_task.sh passes --title through to
# tasks_create verbatim, so if a backlog line's exact title exists as a task
# ANYWHERE in the gateway (any repo, any status), some machine has already
# popped it — it will never be popped again and is safe to remove from the
# well. A line only counts once every line before it in the file also has a
# matching task, so the archived slice is always a contiguous prefix from the
# top (matches how the pop path reads the file in order).
#
# Cursor-shift safety: rewriting the file shifts every remaining line's index
# down by the archived count. Rather than trying to reach into every other
# machine's local (gitignored, unreachable-from-here) cursor file, this script
# does NOT touch them. Instead scripts/queue_topup.sh's TOTAL is computed as
# archived-line-count (summed from config/archive/runner_backlog-*.jsonl) +
# current-file-line-count, and the pop position is CONSUMED minus that same
# archived total — so a machine's CONSUMED counter keeps meaning "lines popped
# over all of history" and never needs adjusting when a rotation happens on a
# different machine. See the matching change in queue_topup.sh.
#
# Usage:
#   scripts/archive_runner_backlog.sh [--dry-run] [--min N]
#     --dry-run   report what would be archived, change nothing
#     --min N     minimum contiguous confirmed-popped prefix required before
#                 archiving anything (default 200) — avoids championing a
#                 handful of lines into a barely-there archive file
#
# Exit: 0 always (informational script, safe to run from a cron/session hook;
# never partially writes — either the full swap happens or nothing does).
# =============================================================================
set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKLOG="$ROOT/config/runner_backlog.jsonl"
ARCHIVE_DIR="$ROOT/config/archive"

. "$SCRIPT_DIR/lib/gateway.sh" 2>/dev/null || true
log(){ echo "[archive-backlog $(TZ=Australia/Sydney date '+%H:%M AEST')] $*"; }

DRY=false
MIN="${ARCHIVE_BACKLOG_MIN:-200}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=true ;;
    --min) shift; MIN="${1:-200}" ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -f "$BACKLOG" ] || { log "no backlog file ($BACKLOG) — nothing to archive"; exit 0; }

TASKS_JSON=$(curl -sf -m 15 -X POST http://localhost:3100/mcp \
  -H 'content-type: application/json' \
  -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"tasks_list","arguments":{"limit":2000}},"id":1}' 2>/dev/null)
if [ -z "$TASKS_JSON" ]; then
  log "gateway unreachable — cannot confirm fleet-wide consumption, skipping (safe no-op)"
  exit 0
fi

YYYY_MM=$(date +%Y-%m)
ARCHIVE_FILE="$ARCHIVE_DIR/runner_backlog-${YYYY_MM}.jsonl"
# NOTE: ARCHIVE_DIR is created lazily by the python block below, only on the
# real (non-dry-run, above --min) archive path — so --min-skip and --dry-run
# never leave a stray empty config/archive/ behind.

RESULT=$(BACKLOG="$BACKLOG" MIN="$MIN" ARCHIVE_FILE="$ARCHIVE_FILE" DRY="$DRY" /usr/bin/python3 -c '
import json, os, sys

backlog_path = os.environ["BACKLOG"]
min_prefix = int(os.environ["MIN"])
archive_file = os.environ["ARCHIVE_FILE"]
dry = os.environ["DRY"] == "true"
# Read the (potentially very large) tasks_list JSON from stdin, NOT argv — a
# full gateway task store (1000s of tasks) blows past ARG_MAX as an argument
# ("Argument list too long"). A here-string spills to a temp file, no limit.
tasks_raw = sys.stdin.read()

try:
    payload = json.loads(tasks_raw)
    text = payload["result"]["content"][0]["text"]
    parsed = json.loads(text)
    tasks = parsed if isinstance(parsed, list) else parsed.get("tasks", [])
except Exception:
    tasks = []

known_titles = set(t.get("title", "") for t in tasks if t.get("title"))

raw_lines = open(backlog_path).readlines()

# Walk in file order. Comment/blank lines never count toward the prefix and
# are always kept in place. JSON lines count in order; the confirmed prefix
# stops at the first JSON line whose title is not (yet) a known gateway task.
confirmed = 0
json_seen = 0
stopped = False
for line in raw_lines:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        continue
    json_seen += 1
    if stopped:
        continue
    try:
        obj = json.loads(stripped)
        title = obj.get("title", "")
    except Exception:
        title = None
    if title and title in known_titles:
        confirmed += 1
    else:
        stopped = True

if confirmed < min_prefix:
    print(f"SKIP confirmed={confirmed} total_json_lines={json_seen} min={min_prefix}")
    sys.exit(0)

if dry:
    print(f"WOULD_ARCHIVE confirmed={confirmed} total_json_lines={json_seen}")
    sys.exit(0)

archived_lines = []
kept_lines = []
json_idx = 0
for line in raw_lines:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        kept_lines.append(line)
        continue
    if json_idx < confirmed:
        archived_lines.append(line if line.endswith("\n") else line + "\n")
    else:
        kept_lines.append(line)
    json_idx += 1

os.makedirs(os.path.dirname(archive_file), exist_ok=True)
archive_is_new = not os.path.exists(archive_file)
with open(archive_file, "a") as f:
    if archive_is_new:
        f.write(f"# Archived from config/runner_backlog.jsonl by scripts/archive_runner_backlog.sh\n")
        f.write(f"# Lines here have a confirmed gateway task (fully popped fleet-wide) and will\n")
        f.write(f"# never be popped again. Searchable via grep; safe to delete once ancient.\n")
    f.writelines(archived_lines)

tmp_path = backlog_path + ".tmp"
with open(tmp_path, "w") as f:
    f.writelines(kept_lines)
os.replace(tmp_path, backlog_path)

print(f"ARCHIVED confirmed={confirmed} total_json_lines={json_seen} archive_file={archive_file}")
' <<<"$TASKS_JSON")

case "$RESULT" in
  SKIP*) log "$RESULT — leaving backlog untouched (need >= $MIN confirmed-popped lines from the top)" ;;
  WOULD_ARCHIVE*) log "dry-run: $RESULT" ;;
  ARCHIVED*) log "$RESULT"; log "new backlog line count: $(grep -cvE '^\s*(#|$)' "$BACKLOG" 2>/dev/null || echo 0)" ;;
  *) log "unexpected result: $RESULT" ;;
esac
exit 0
