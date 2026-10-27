#!/usr/bin/env bash
# ingest_runner_history.sh — backfill/refresh the searchable runner job-history
# archive (task-1873b3be) from the raw job logs in ~/.ai-cli-runner/logs.
#
# WHY: cli_task_runner.sh writes one log per fire, machine-local, and
# runner_log_rotate.sh eventually deletes them — so "which overnight run
# touched repo X?" / "when did that error last appear?" meant SSHing into
# whichever Mac ran the job and grepping. This script parses each log's
# filename (fire timestamp, repo, task id) and content (RESULT line, outcome,
# error/postmortem excerpt) and records ONE summary row per fire into the
# gateway's tenant-scoped job-history store via the `job_history_record` MCP
# tool. The dashboard /runs page (and `job_history_search`) query that store.
#
# IDEMPOTENT: the store upserts by logFile (per-tenant unique), so re-running
# over the same directory refreshes rows instead of duplicating them — safe to
# run after every fire (cli_task_runner.sh tail does) AND as a manual backfill.
# Handles both plain .log and rotated .log.gz files.
#
# Retention lives server-side (JOB_HISTORY_RETENTION_DAYS / _MAX_PER_TENANT,
# applied on write) — this script never deletes anything, local or remote.
#
#   ./scripts/ingest_runner_history.sh                 # ingest $HOME/.ai-cli-runner/logs
#   ./scripts/ingest_runner_history.sh --dry-run       # parse + report, no gateway writes
#   LOG_ROOT=/tmp/x GATEWAY_MCP=http://localhost:3100/mcp ./scripts/ingest_runner_history.sh
#
# Non-fatal by design: a missing directory, an unparseable filename, or an
# unreachable gateway must never break the runner that invokes it.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
LOG_ROOT="${LOG_ROOT:-$HOME/.ai-cli-runner/logs}"
GATEWAY_MCP="${GATEWAY_MCP:-http://localhost:3100/mcp}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

. "$SCRIPT_DIR/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

if [ ! -d "$LOG_ROOT" ]; then
  echo "ingest_runner_history: no log dir at $LOG_ROOT — nothing to ingest"
  exit 0
fi

# All parsing + JSON + HTTP in one python3 pass (gzip module handles .log.gz,
# no curl quoting hazards for RESULT lines that embed quotes/backticks).
GW_URL="$GATEWAY_MCP" GW_TOKEN="$GATEWAY_LOCAL_TOKEN" LOG_ROOT="$LOG_ROOT" DRY_RUN="$DRY_RUN" \
/usr/bin/python3 <<'PYEOF'
import calendar, gzip, json, os, re, socket, sys, time, urllib.request

log_root = os.environ["LOG_ROOT"]
dry = os.environ.get("DRY_RUN") == "1"
gw_url = os.environ["GW_URL"]
machine = socket.gethostname().split(".")[0]

# 20260824-201522-<repo>-task-<uuid>.log[.gz] — the '-task-' delimiter splits
# repo (may itself contain hyphens/underscores) from the queue task id, which
# keeps its 'task-' prefix (that's how ids appear in the fleet queue).
NAME_RE = re.compile(r"^(\d{8})-(\d{6})-(.+?)-(task-[0-9a-f-]+)\.log(\.gz)?$")

def read_text(path):
    opener = gzip.open if path.endswith(".gz") else open
    try:
        with opener(path, "rt", errors="replace") as f:
            return f.read()
    except OSError as e:
        print(f"  skip (unreadable): {os.path.basename(path)} — {e}")
        return None

def parse(name, text):
    """Derive the summary row for one job log."""
    result_line = ""
    for line in reversed(text.splitlines()):
        if line.startswith("RESULT: "):
            result_line = line
            break
    # 3-strikes postmortem block (see CLAUDE.md YOLO §4): from the marker line
    # through the numbered attempts — the highest-signal error excerpt a run has.
    excerpt = ""
    m = re.search(r"^3-strikes stop\s*$", text, re.MULTILINE)
    if m:
        block = text[m.start():]
        lines = [block.splitlines()[0]] + [l for l in block.splitlines()[1:] if re.match(r"^Attempt \d+:", l)]
        excerpt = "\n".join(lines)[:4000]
    if m:
        status = "failed"
    elif "BLOCKED" in result_line:
        status = "blocked"
    elif result_line:
        status = "done"
    else:
        status = "no-result"
        excerpt = excerpt or text[-2000:]
    return result_line, status, excerpt

def call(tool, args):
    body = json.dumps({"jsonrpc": "2.0", "method": "tools/call", "id": 1,
                       "params": {"name": tool, "arguments": args}}).encode()
    req = urllib.request.Request(gw_url, data=body, headers={
        "content-type": "application/json",
        "x-gateway-local-token": os.environ["GW_TOKEN"],
    })
    with urllib.request.urlopen(req, timeout=15) as res:
        out = json.loads(res.read())
    if out.get("error"):
        raise RuntimeError(out["error"])
    text = out["result"]["content"][0]["text"]
    inner = json.loads(text)
    if isinstance(inner, dict) and inner.get("error"):
        raise RuntimeError(inner["error"])
    return inner

ok = skipped = failed = 0
for name in sorted(os.listdir(log_root)):
    m = NAME_RE.match(name)
    if not m:
        continue
    date_s, time_s, repo, task_id, _gz = m.groups()
    try:
        started_ms = int(calendar.timegm(time.strptime(date_s + time_s, "%Y%m%d%H%M%S")) * 1000)  # log-name stamps are UTC
    except ValueError:
        skipped += 1
        continue
    text = read_text(os.path.join(log_root, name))
    if text is None:
        skipped += 1
        continue
    result_line, status, excerpt = parse(name, text)
    # Canonical dedupe key is the PLAIN filename — rotation gzips a .log into
    # .log.gz, and the re-ingest of the gzipped copy must hit the same row.
    log_file = name[:-3] if name.endswith(".gz") else name
    args = {"repo": repo, "taskId": task_id, "status": status, "resultLine": result_line[:2000],
            "errorExcerpt": excerpt, "machine": machine, "logFile": log_file, "startedAtMs": started_ms}
    if dry:
        print(f"  would record: {log_file} -> {repo} {task_id} [{status}]")
        ok += 1
        continue
    try:
        call("job_history_record", args)
        ok += 1
    except Exception as e:
        failed += 1
        print(f"  record failed: {log_file} — {e}")

verb = "parsed" if dry else "recorded"
print(f"ingest_runner_history: {verb} {ok}, skipped {skipped}, failed {failed} (root {log_root})")
sys.exit(0)
PYEOF
exit 0
