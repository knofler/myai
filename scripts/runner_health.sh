#!/usr/bin/env bash
# runner_health.sh — parse the CLI task-runner log (runner.out) into a compact
# JSON health artifact the dashboard can render.
#
# WHY: the dashboard runs in Docker and reads MongoDB + the repo (mounted RO at
# AI_ROOT). It cannot see ~/.ai-cli-runner/runner.out, which lives on the host
# outside the repo. This host-side script bridges that gap: it parses runner.out
# and writes state/runner-health.json INTO the repo, where the dashboard reads it
# via AI_ROOT. Queue-depth-by-status comes straight from the gateway task store
# (Mongo) in the dashboard — this artifact carries the runner-fire signal only.
#
# Emits per-repo: last fire time, last RESULT, fire/zero-work counts, and the
# trailing consecutive-zero-work streak. Emits a global zero-work STALL flag when
# N consecutive fires did 0 work — the "content_api head-of-line" signature where
# a stuck head-of-queue task makes the runner fire repeatedly but ship nothing.
#
# Usage:
#   ./scripts/runner_health.sh                 # parse default log → repo state/
#   RUNNER_OUT=/path/to/runner.out ./scripts/runner_health.sh
#   RUNNER_HEALTH_OUT=/tmp/h.json ./scripts/runner_health.sh
#   RUNNER_STALL_N=3 ./scripts/runner_health.sh   # stall threshold (default 3)
#
# Safe to run repeatedly (idempotent — rewrites the artifact). Never fails a
# caller: missing log → writes an "unavailable" artifact and exits 0.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RUNNER_OUT="${RUNNER_OUT:-$HOME/.ai-cli-runner/runner.out}"
RUNNER_HEALTH_OUT="${RUNNER_HEALTH_OUT:-$REPO_ROOT/state/runner-health.json}"
RUNNER_STALL_N="${RUNNER_STALL_N:-3}"

mkdir -p "$(dirname "$RUNNER_HEALTH_OUT")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "runner_health: python3 not found — skipping" >&2
  exit 0
fi

RUNNER_OUT="$RUNNER_OUT" RUNNER_HEALTH_OUT="$RUNNER_HEALTH_OUT" RUNNER_STALL_N="$RUNNER_STALL_N" \
python3 - <<'PY'
import os, re, json, sys
from datetime import datetime, timezone

log_path   = os.environ["RUNNER_OUT"]
out_path   = os.environ["RUNNER_HEALTH_OUT"]
threshold  = int(os.environ.get("RUNNER_STALL_N", "3"))
now_iso    = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")

def write(obj):
    tmp = out_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, out_path)

if not os.path.isfile(log_path):
    write({
        "generatedAt": now_iso, "source": log_path, "available": False,
        "stallThreshold": threshold,
        "global": {"totalFires": 0, "firesLast24h": 0, "consecutiveZeroWork": 0,
                   "stall": False, "stalledRepo": None, "lastFireAt": None,
                   "lastRepo": None, "lastResult": None},
        "repos": [],
    })
    print(f"runner_health: no log at {log_path} — wrote unavailable artifact", file=sys.stderr)
    sys.exit(0)

# ── Line grammar (see runner.out) ──────────────────────────────────────────
RE_PICKED  = re.compile(r"\] picked:\s*\[([^\]]+)\]\s*(.*)$")
RE_TASK    = re.compile(r"\btask\s*:\s*(task-[0-9a-f-]+)")
RE_AGENT   = re.compile(r"\bagent\s*:\s*([A-Za-z0-9_-]+)")
RE_LOG     = re.compile(r"\blog\s*:\s*.*/(\d{8})-(\d{6})-")
RE_PUSHED  = re.compile(r'\[pushed-shas\].*?"count"\s*:\s*(\d+)')
RE_REVIEW  = re.compile(r"task → REVIEW\b.*?RESULT:\s*(.*)$")
RE_BLOCKED = re.compile(r"task → BLOCKED\b(.*)$")

ZERO_WORK_RE = re.compile(
    r"no commit|nothing to commit|no change|no code changes|already complete|"
    r"nothing to apply|no changes needed|already (done|shipped|landed|complete)|"
    r"no action needed|verified.*no change",
    re.IGNORECASE,
)

fires = []  # chronological, in file order
cur = None

def finalize(f):
    if f is None:
        return
    outcome = f.get("outcome")
    pushed  = f.get("pushedCount")
    result  = f.get("result") or ""
    if outcome == "blocked":
        zero = True
    elif pushed is not None and pushed > 0:
        zero = False
    elif pushed == 0:
        zero = True
    elif ZERO_WORK_RE.search(result):
        zero = True
    else:
        # review with no pushed-shas stamp + no zero-work phrase → assume worked
        zero = False
    f["zeroWork"] = zero
    fires.append(f)

with open(log_path, encoding="utf-8", errors="replace") as fh:
    for line in fh:
        m = RE_PICKED.search(line)
        if m:
            finalize(cur)
            cur = {"repo": m.group(1).strip(), "title": m.group(2).strip(),
                   "taskId": None, "agent": None, "fireAt": None,
                   "pushedCount": None, "outcome": None, "result": None}
            continue
        if cur is None:
            continue
        m = RE_TASK.search(line)
        if m and cur["taskId"] is None:
            cur["taskId"] = m.group(1); continue
        m = RE_AGENT.search(line)
        if m and cur["agent"] is None:
            cur["agent"] = m.group(1); continue
        m = RE_LOG.search(line)
        if m and cur["fireAt"] is None:
            try:
                dt = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")
                cur["fireAt"] = dt.astimezone().isoformat(timespec="seconds")
            except ValueError:
                pass
            continue
        m = RE_PUSHED.search(line)
        if m:
            cur["pushedCount"] = int(m.group(1)); continue
        m = RE_REVIEW.search(line)
        if m:
            cur["outcome"] = "review"; cur["result"] = m.group(1).strip()[:400]; continue
        m = RE_BLOCKED.search(line)
        if m:
            cur["outcome"] = "blocked"
            cur["result"] = ("BLOCKED" + m.group(1)).strip()[:400]; continue
finalize(cur)

# ── Per-repo aggregation ────────────────────────────────────────────────────
def epoch(iso):
    if not iso:
        return 0.0
    try:
        return datetime.fromisoformat(iso).timestamp()
    except ValueError:
        return 0.0

repos = {}
for f in fires:
    r = repos.setdefault(f["repo"], {"repo": f["repo"], "fires": [], "_order": []})
    r["fires"].append(f)

repo_rows = []
for name, r in repos.items():
    rf = r["fires"]                       # already chronological
    last = rf[-1]
    zero_total = sum(1 for x in rf if x["zeroWork"])
    streak = 0
    for x in reversed(rf):
        if x["zeroWork"]:
            streak += 1
        else:
            break
    repo_rows.append({
        "repo": name,
        "lastFireAt": last["fireAt"],
        "lastOutcome": last["outcome"],
        "lastResult": last["result"],
        "lastAgent": last["agent"],
        "fires": len(rf),
        "zeroWork": zero_total,
        "consecutiveZeroWork": streak,
        "stalled": streak >= threshold,
    })

repo_rows.sort(key=lambda x: (epoch(x["lastFireAt"])), reverse=True)

# ── Global stall: trailing consecutive zero-work across ALL fires ───────────
global_streak = 0
for f in reversed(fires):
    if f["zeroWork"]:
        global_streak += 1
    else:
        break

now_ts = datetime.now(timezone.utc).timestamp()
fires_24h = sum(1 for f in fires if f["fireAt"] and now_ts - epoch(f["fireAt"]) <= 86400)

last_fire = fires[-1] if fires else None
stalled_repo = last_fire["repo"] if (last_fire and global_streak >= threshold) else None

write({
    "generatedAt": now_iso,
    "source": log_path,
    "available": True,
    "stallThreshold": threshold,
    "global": {
        "totalFires": len(fires),
        "firesLast24h": fires_24h,
        "consecutiveZeroWork": global_streak,
        "stall": global_streak >= threshold,
        "stalledRepo": stalled_repo,
        "lastFireAt": last_fire["fireAt"] if last_fire else None,
        "lastRepo": last_fire["repo"] if last_fire else None,
        "lastResult": last_fire["result"] if last_fire else None,
    },
    "repos": repo_rows,
})
print(f"runner_health: {len(fires)} fires across {len(repo_rows)} repos → {out_path}"
      f" (consecutive zero-work={global_streak}, stall={global_streak >= threshold})",
      file=sys.stderr)
PY
