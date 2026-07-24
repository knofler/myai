#!/usr/bin/env bash
# runner_repo_staleness.sh — per-repo runner-log staleness alert.
#
# WHY: the fleet-wide "runner down / no heartbeat" check (queued separately,
# config/runner_backlog.jsonl) only tells you the runner PROCESS is alive. It
# says nothing about a SPECIFIC repo whose queue has pending work that the
# runner keeps not picking — agentFlow sat stalled 2026-06-25→2026-07-07 with
# pending tasks and only a human noticing during a manual session review ever
# caught it. This script closes that gap: for every repo with pending queue
# work, compare "now" against that repo's last runner-log timestamp
# (~/.ai-cli-runner/logs/*-<repo>-task-*.log[.gz] — same glob convention as
# `agent mode -resume`). >STALE_HOURS since that repo's last log while it has
# pending work → alert (state/runner-repo-staleness.json + optional Telegram
# with --notify).
#
# Usage:
#   ./scripts/runner_repo_staleness.sh                 # check + write artifact
#   ./scripts/runner_repo_staleness.sh --notify         # also ping Telegram on alerts
#   RUNNER_LOGS=/tmp/logs STALE_HOURS=48 ./scripts/runner_repo_staleness.sh
#   MCP_URL=http://localhost:3100/mcp ./scripts/runner_repo_staleness.sh
#
# Safe to run repeatedly (idempotent — rewrites the artifact). Never fails a
# caller: gateway unreachable/no python3 → writes an "unavailable" artifact (or
# skips) and exits 0.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RUNNER_LOGS="${RUNNER_LOGS:-$HOME/.ai-cli-runner/logs}"
STALE_HOURS="${STALE_HOURS:-48}"
MCP_PORT="${MCP_PORT:-3100}"
MCP_URL="${MCP_URL:-http://localhost:${MCP_PORT}/mcp}"
OUT="${RUNNER_STALENESS_OUT:-$REPO_ROOT/state/runner-repo-staleness.json}"
IGNORE_FILE="${SCHEDULE_IGNORE_FILE:-$REPO_ROOT/config/schedule_ignore.txt}"

NOTIFY=0
for a in "$@"; do [ "$a" = "--notify" ] && NOTIFY=1; done

# Host→gateway calls MUST carry x-gateway-local-token (see scripts/lib/gateway.sh).
for _gwlib in "$REPO_ROOT/scripts/lib/gateway.sh" "$REPO_ROOT/AI/scripts/lib/gateway.sh"; do
  [ -f "$_gwlib" ] && . "$_gwlib" && break
done
GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

mkdir -p "$(dirname "$OUT")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "runner_repo_staleness: python3 not found — skipping" >&2
  exit 0
fi

RESP=""
if command -v curl >/dev/null 2>&1; then
  RESP="$(curl -sf -m 6 -X POST "$MCP_URL" -H 'content-type: application/json' \
    -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
    -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"tasks_list","arguments":{"status":"pending","limit":2000}}}' \
    2>/dev/null)"
fi

if [ -z "$RESP" ]; then
  python3 - "$OUT" <<'PY'
import json, sys
from datetime import datetime, timezone
out_path = sys.argv[1]
now_iso = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
tmp = out_path + ".tmp"
with open(tmp, "w") as f:
    json.dump({"generatedAt": now_iso, "available": False, "staleThresholdHours": None,
               "repos": [], "alerts": []}, f, indent=2)
import os
os.replace(tmp, out_path)
PY
  echo "runner_repo_staleness: gateway unreachable — wrote unavailable artifact" >&2
  exit 0
fi

IGNORE_REPOS=""
[ -f "$IGNORE_FILE" ] && IGNORE_REPOS="$(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$IGNORE_FILE" | tr '\n' ',')"

RESP="$RESP" RUNNER_LOGS="$RUNNER_LOGS" STALE_HOURS="$STALE_HOURS" OUT_PATH="$OUT" IGNORE_REPOS="$IGNORE_REPOS" \
python3 - <<'PY'
import glob, json, os, re, sys
from datetime import datetime, timezone

resp        = os.environ["RESP"]
logs_dir    = os.environ["RUNNER_LOGS"]
threshold_h = float(os.environ["STALE_HOURS"])
out_path    = os.environ["OUT_PATH"]
ignore      = set(x for x in os.environ.get("IGNORE_REPOS", "").split(",") if x)

now_iso = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
now_ts  = datetime.now(timezone.utc).timestamp()

def write(obj):
    tmp = out_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, out_path)

try:
    data  = json.loads(json.loads(resp)["result"]["content"][0]["text"])
    tasks = data.get("tasks", [])
except Exception:
    write({"generatedAt": now_iso, "available": False, "staleThresholdHours": threshold_h,
           "repos": [], "alerts": []})
    print("runner_repo_staleness: malformed gateway response — wrote unavailable artifact",
          file=sys.stderr)
    sys.exit(0)

pending = {}
for t in tasks:
    if t.get("status") != "pending":
        continue
    r = t.get("repo")
    if not r or r in ignore:
        continue
    pending[r] = pending.get(r, 0) + 1

TS_RE = re.compile(r"^(\d{8})-(\d{6})-")

def last_log_ts(repo):
    best = None
    for pattern in (f"*-{repo}-task-*.log", f"*-{repo}-task-*.log.gz"):
        for path in glob.glob(os.path.join(logs_dir, pattern)):
            m = TS_RE.match(os.path.basename(path))
            if not m:
                continue
            try:
                ts = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").timestamp()
            except ValueError:
                continue
            if best is None or ts > best:
                best = ts
    return best

repo_rows = []
alerts = []
for repo, count in sorted(pending.items()):
    last_ts = last_log_ts(repo)
    if last_ts is None:
        age_h, stale, last_iso = None, True, None
    else:
        age_h = round((now_ts - last_ts) / 3600, 1)
        stale = age_h > threshold_h
        last_iso = datetime.fromtimestamp(last_ts, tz=timezone.utc).astimezone().isoformat(timespec="seconds")
    row = {"repo": repo, "pending": count, "lastRunnerLogAt": last_iso,
           "ageHours": age_h, "stale": stale}
    repo_rows.append(row)
    if stale:
        alerts.append(row)

write({
    "generatedAt": now_iso,
    "available": True,
    "staleThresholdHours": threshold_h,
    "repos": repo_rows,
    "alerts": alerts,
})

if alerts:
    for a in alerts:
        age_s = f"{a['ageHours']}h" if a["ageHours"] is not None else "never seen"
        print(f"runner_repo_staleness: ALERT — {a['repo']} has {a['pending']} pending task(s) "
              f"but last runner log is {age_s} old (threshold {threshold_h}h)", file=sys.stderr)
else:
    print(f"runner_repo_staleness: {len(repo_rows)} repo(s) with pending work, none stale",
          file=sys.stderr)
PY

# ── optional Telegram notification on stale repos (best-effort, never fatal) ──
if [ "$NOTIFY" = "1" ] && [ -f "$OUT" ]; then
  ALERT_LINES="$(python3 -c "
import json
try:
    d = json.load(open('$OUT'))
except Exception:
    d = {}
for a in d.get('alerts', []):
    age = f\"{a['ageHours']}h\" if a.get('ageHours') is not None else 'never seen'
    print(f\"{a['repo']}: {a['pending']} pending, last runner log {age} old\")
" 2>/dev/null)"
  if [ -n "$ALERT_LINES" ]; then
    NOTIFY_SCRIPT="${NOTIFY_TELEGRAM_SCRIPT:-$SCRIPT_DIR/notify-telegram.sh}"
    "$NOTIFY_SCRIPT" "repo-stall" "$ALERT_LINES" >/dev/null 2>&1 || true
  fi
fi

exit 0
