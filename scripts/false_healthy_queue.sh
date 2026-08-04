#!/usr/bin/env bash
# false_healthy_queue.sh — "false-healthy empty queue" detector.
#
# WHY: runner_repo_staleness.sh already catches the case where a repo's queue
# HAS pending work but the runner-log hasn't advanced (agentFlow sat stalled
# 2026-06-25→2026-07-07 with pending tasks nobody noticed). It says nothing
# about the OPPOSITE case: a repo whose queue shows 0 pending / 0 review / 0
# blocked / 0 working — which reads as "fully caught up" on the dashboard —
# but that repo hasn't shipped a single commit in weeks. An empty queue is
# indistinguishable, at a glance, from a runner that quietly stopped picking
# up work for that repo entirely (the exact blind spot agentFlow's own
# S57/S59 handoffs describe happening to itself for a month, unnoticed).
#
# This script cross-references gateway task totals (tasks_list, all statuses)
# against each managed repo's actual last-commit timestamp (git, on disk —
# the ground truth, not the queue). A repo is "false-healthy" iff BOTH:
#   (a) pending + review + blocked + working == 0 for that repo, AND
#   (b) its newest commit across all local branches/tags is >= STALE_DAYS old
#       (or the repo has no commits at all — treated as maximally stale).
#
# Usage:
#   ./scripts/false_healthy_queue.sh                    # check + write artifact + print table
#   ./scripts/false_healthy_queue.sh --notify            # also ping Telegram on alerts
#   ./scripts/false_healthy_queue.sh --fetch              # git fetch each repo first (freshest, slower)
#   STALE_DAYS=21 ./scripts/false_healthy_queue.sh
#   MANAGED_REPOS_FILE=/tmp/repos.txt FALSE_HEALTHY_OUT=/tmp/out.json ./scripts/false_healthy_queue.sh
#
# Safe to run repeatedly (idempotent — rewrites the artifact). Never fails a
# caller: gateway unreachable/no python3 → writes an "unavailable" artifact (or
# skips) and exits 0. Read-only w.r.t. the gateway (no task mutation) and
# read-only w.r.t. git unless --fetch is passed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

STALE_DAYS="${STALE_DAYS:-14}"
MCP_PORT="${MCP_PORT:-3100}"
MCP_URL="${MCP_URL:-http://localhost:${MCP_PORT}/mcp}"
OUT="${FALSE_HEALTHY_OUT:-$REPO_ROOT/state/false-healthy-queue.json}"
REPOS_FILE="${MANAGED_REPOS_FILE:-$REPO_ROOT/config/managed_repos.txt}"
IGNORE_FILE="${SCHEDULE_IGNORE_FILE:-$REPO_ROOT/config/schedule_ignore.txt}"

NOTIFY=0 DO_FETCH=0
for a in "$@"; do
  case "$a" in
    --notify) NOTIFY=1 ;;
    --fetch)  DO_FETCH=1 ;;
  esac
done

# Host→gateway calls MUST carry x-gateway-local-token (see scripts/lib/gateway.sh).
for _gwlib in "$REPO_ROOT/scripts/lib/gateway.sh" "$REPO_ROOT/AI/scripts/lib/gateway.sh"; do
  [ -f "$_gwlib" ] && . "$_gwlib" && break
done
GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

mkdir -p "$(dirname "$OUT")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "false_healthy_queue: python3 not found — skipping" >&2
  exit 0
fi

write_unavailable() {
  python3 - "$OUT" "$STALE_DAYS" <<'PY'
import json, sys
from datetime import datetime, timezone
out_path, stale_days = sys.argv[1], float(sys.argv[2])
now_iso = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
tmp = out_path + ".tmp"
with open(tmp, "w") as f:
    json.dump({"generatedAt": now_iso, "available": False, "staleDaysThreshold": stale_days,
               "repos": [], "alerts": []}, f, indent=2)
import os
os.replace(tmp, out_path)
PY
}

RESP=""
if command -v curl >/dev/null 2>&1; then
  RESP="$(curl -sf -m 10 -X POST "$MCP_URL" -H 'content-type: application/json' \
    -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
    -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"tasks_list","arguments":{"limit":5000}}}' \
    2>/dev/null)"
fi

if [ -z "$RESP" ]; then
  write_unavailable
  echo "false_healthy_queue: gateway unreachable — wrote unavailable artifact" >&2
  exit 0
fi

if [ ! -f "$REPOS_FILE" ]; then
  write_unavailable
  echo "false_healthy_queue: $REPOS_FILE not found — wrote unavailable artifact" >&2
  exit 0
fi

IGNORE_REPOS=""
[ -f "$IGNORE_FILE" ] && IGNORE_REPOS="$(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$IGNORE_FILE" | tr '\n' ',')"

# ── expand managed repos → unique (name, gitRoot) pairs (mirrors fleet_resume.sh git_roots) ──
git_roots() {
  local line path root
  while IFS= read -r line; do
    line="${line%%#*}"; line="$(echo "$line" | xargs 2>/dev/null)"
    [ -n "$line" ] || continue
    path="${line/#\~/$HOME}"
    [ -d "$path" ] || continue
    root="$(git -C "$path" rev-parse --show-toplevel 2>/dev/null)" || continue
    echo "$root"
  done < "$REPOS_FILE" | sort -u
}

# ── one row per repo: name<TAB>lastCommitEpoch(or empty) ─────────────────────
REPO_ROWS=""
while IFS= read -r root; do
  [ -n "$root" ] || continue
  name="$(basename "$root")"
  case "$name" in
    api|app|docker|web|frontend|backend|server|client)
      name="$(basename "$(dirname "$root")")-$name" ;;
  esac
  [ "$DO_FETCH" = "1" ] && timeout 20 git -C "$root" fetch --quiet --all 2>/dev/null
  epoch="$(git -C "$root" log -1 --all --format=%ct 2>/dev/null || true)"
  REPO_ROWS="${REPO_ROWS}${name}	${epoch}
"
done < <(git_roots)

if [ -z "$REPO_ROWS" ]; then
  write_unavailable
  echo "false_healthy_queue: no resolvable git repos in $REPOS_FILE — wrote unavailable artifact" >&2
  exit 0
fi

RESP="$RESP" REPO_ROWS="$REPO_ROWS" STALE_DAYS="$STALE_DAYS" OUT_PATH="$OUT" IGNORE_REPOS="$IGNORE_REPOS" \
python3 - <<'PY'
import json, os, sys
from datetime import datetime, timezone

resp        = os.environ["RESP"]
repo_rows_raw = os.environ["REPO_ROWS"]
threshold_d = float(os.environ["STALE_DAYS"])
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
    write({"generatedAt": now_iso, "available": False, "staleDaysThreshold": threshold_d,
           "repos": [], "alerts": []})
    print("false_healthy_queue: malformed gateway response — wrote unavailable artifact",
          file=sys.stderr)
    sys.exit(0)

QUEUE_STATUSES = ("pending", "review", "blocked", "working")
counts = {}  # repo -> {status: n}
for t in tasks:
    r = t.get("repo")
    s = t.get("status")
    if not r or s not in QUEUE_STATUSES:
        continue
    counts.setdefault(r, {k: 0 for k in QUEUE_STATUSES})
    counts[r][s] += 1

repo_rows = []
alerts = []
for line in repo_rows_raw.splitlines():
    if not line.strip():
        continue
    name, epoch_s = line.split("\t", 1)
    if name in ignore:
        continue
    c = counts.get(name, {k: 0 for k in QUEUE_STATUSES})
    queue_empty = sum(c.values()) == 0

    epoch_s = epoch_s.strip()
    if epoch_s:
        last_ts = float(epoch_s)
        age_d = round((now_ts - last_ts) / 86400, 1)
        last_iso = datetime.fromtimestamp(last_ts, tz=timezone.utc).astimezone().isoformat(timespec="seconds")
        stale = age_d >= threshold_d
    else:
        age_d, last_iso, stale = None, None, True  # no commits at all — maximally stale

    false_healthy = queue_empty and stale
    row = {
        "repo": name,
        "pending": c["pending"], "review": c["review"], "blocked": c["blocked"], "working": c["working"],
        "queueEmpty": queue_empty,
        "lastCommitAt": last_iso, "ageDays": age_d,
        "falseHealthy": false_healthy,
    }
    repo_rows.append(row)
    if false_healthy:
        alerts.append(row)

repo_rows.sort(key=lambda r: r["repo"])
alerts.sort(key=lambda r: r["repo"])

write({
    "generatedAt": now_iso,
    "available": True,
    "staleDaysThreshold": threshold_d,
    "repos": repo_rows,
    "alerts": alerts,
})

w = max((len(r["repo"]) for r in repo_rows), default=4)
print(f"\n  FALSE-HEALTHY EMPTY QUEUE — threshold {threshold_d:g}d\n", file=sys.stdout)
print(f"  {'REPO':<{w}}  {'Q':^3}  {'AGE(d)':>7}  FLAG", file=sys.stdout)
print(f"  {'-'*w}  {'-'*3}  {'-'*7}  {'-'*20}", file=sys.stdout)
for r in repo_rows:
    q = "0" if r["queueEmpty"] else str(r["pending"] + r["review"] + r["blocked"] + r["working"])
    age = f"{r['ageDays']:.1f}" if r["ageDays"] is not None else "never"
    flag = "⚠ FALSE-HEALTHY" if r["falseHealthy"] else ("· idle" if r["queueEmpty"] else "")
    print(f"  {r['repo']:<{w}}  {q:^3}  {age:>7}  {flag}", file=sys.stdout)

if alerts:
    print(f"\nfalse_healthy_queue: ALERT — {len(alerts)} repo(s) look caught up (empty queue) "
          f"but have shipped nothing in >= {threshold_d:g}d: "
          + ", ".join(a["repo"] for a in alerts), file=sys.stderr)
else:
    print(f"false_healthy_queue: {len(repo_rows)} repo(s) checked, none false-healthy", file=sys.stderr)
PY

# ── optional Telegram notification on alerts (best-effort, never fatal) ──────
if [ "$NOTIFY" = "1" ] && [ -f "$OUT" ]; then
  ALERT_LINES="$(python3 -c "
import json
try:
    d = json.load(open('$OUT'))
except Exception:
    d = {}
for a in d.get('alerts', []):
    age = f\"{a['ageDays']}d\" if a.get('ageDays') is not None else 'never'
    print(f\"{a['repo']}: empty queue, last commit {age} old\")
" 2>/dev/null)"
  if [ -n "$ALERT_LINES" ]; then
    NOTIFY_SCRIPT="${NOTIFY_TELEGRAM_SCRIPT:-$SCRIPT_DIR/notify-telegram.sh}"
    "$NOTIFY_SCRIPT" "false-healthy-queue" "$ALERT_LINES" >/dev/null 2>&1 || true
  fi
fi

exit 0
