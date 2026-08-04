#!/usr/bin/env bash
# ollama_local_tier.sh — sourceable helper: resource-guarded direct-Ollama
# routing for the runner's TRIVIAL -> LOCAL tier (cli_task_runner.sh).
#
# VERIFIED 2026-07-18: `claude -p --model <ollama-model>` does NOT route to
# Ollama (Claude Code sends the model name straight to Anthropic, which errors
# "model may not exist"). This calls the Ollama HTTP API directly instead, via
# scripts/lib/ollama_agent.py (bounded read/write/list tool loop), and this
# file handles the resource guards + git plumbing around it:
#   - single concurrency: never run local inference in parallel (a second
#     concurrent runner fire would double-load the model in RAM)
#   - short OLLAMA_LOCAL_KEEP_ALIVE so the model unloads shortly after use
#   - a free-RAM preflight so local inference is skipped outright (falling
#     straight through to Sonnet) when the box is already tight
# Not executed directly — sourced by cli_task_runner.sh.

OLLAMA_BASE_URL=${OLLAMA_BASE_URL:-http://localhost:11434}
OLLAMA_LOCAL_KEEP_ALIVE=${OLLAMA_LOCAL_KEEP_ALIVE:-2m}
OLLAMA_LOCAL_MAX_ITERS=${OLLAMA_LOCAL_MAX_ITERS:-6}
OLLAMA_MIN_FREE_RAM_MB=${OLLAMA_MIN_FREE_RAM_MB:-1536}
OLLAMA_LOCK_DIR=${OLLAMA_LOCK_DIR:-/tmp/cli-task-runner.ollama.lock}
OLLAMA_LOCK_WAIT_SEC=${OLLAMA_LOCK_WAIT_SEC:-30}
OLLAMA_LOCK_STALE_SEC=${OLLAMA_LOCK_STALE_SEC:-1200}

# ollama_free_ram_mb — best-effort free system RAM in MB. macOS via vm_stat
# (free + inactive pages, matching the OS's own "memory available" notion),
# Linux via /proc/meminfo MemAvailable. Prints a very large number (never
# blocks local dispatch) when it can't tell — a preflight that fails open is
# safer than one that silently disables the tier forever on an odd host.
ollama_free_ram_mb() {
    if command -v vm_stat >/dev/null 2>&1; then
        vm_stat 2>/dev/null | /usr/bin/python3 -c '
import re, sys
t = sys.stdin.read()
page = 4096
m = re.search(r"page size of (\d+) bytes", t)
if m:
    page = int(m.group(1))
def pages(label):
    mm = re.search(re.escape(label) + r":\s+(\d+)\.", t)
    return int(mm.group(1)) if mm else 0
free_pages = pages("Pages free") + pages("Pages inactive")
print((free_pages * page) // (1024 * 1024))
' 2>/dev/null && return 0
    fi
    if [ -r /proc/meminfo ]; then
        awk '/MemAvailable:/ {print int($2/1024); f=1} END {if (!f) print 999999}' /proc/meminfo
        return 0
    fi
    echo 999999
}

# ollama_ram_ok — rc 0 when there's enough headroom to safely load a local
# model; rc 1 when the box is tight and the caller should skip straight to
# the paid fallback instead of contending for RAM with the rest of the stack.
ollama_ram_ok() {
    local free; free=$(ollama_free_ram_mb 2>/dev/null)
    case "$free" in ''|*[!0-9]*) return 0 ;; esac
    [ "$free" -ge "$OLLAMA_MIN_FREE_RAM_MB" ]
}

# ollama_lock_acquire — mkdir is atomic even under concurrent callers, so this
# is a correct single-concurrency guard: only one local-tier attempt may run
# at a time on this machine. Reaps a stale lock (holder died without cleanup)
# older than OLLAMA_LOCK_STALE_SEC so a crashed run can't wedge the tier shut.
ollama_lock_acquire() {
    local waited=0 age mtime
    while ! mkdir "$OLLAMA_LOCK_DIR" 2>/dev/null; do
        mtime=$(stat -c %Y "$OLLAMA_LOCK_DIR" 2>/dev/null || stat -f %m "$OLLAMA_LOCK_DIR" 2>/dev/null || echo "")  # GNU-first (BSD `stat -f` pollutes stdout on Linux)
        if [ -n "$mtime" ]; then
            age=$(( $(date +%s) - mtime ))
            if [ "$age" -gt "$OLLAMA_LOCK_STALE_SEC" ]; then
                rmdir "$OLLAMA_LOCK_DIR" 2>/dev/null || true
                continue
            fi
        fi
        [ "$waited" -ge "$OLLAMA_LOCK_WAIT_SEC" ] && return 1
        sleep 2; waited=$((waited + 2))
    done
    return 0
}
ollama_lock_release() { rmdir "$OLLAMA_LOCK_DIR" 2>/dev/null || true; }

# ── ANTI-DESTRUCTIVE GUARD (operator directive 2026-07-26) ───────────────────
# A 7B local model overnight wiped CLAUDE.md and clobbered
# GRAND_PRODUCT_ROADMAP.md (reverted by later Fable tasks) — prompt
# instructions alone don't reliably constrain it. This is the mechanical
# backstop: inspect the STAGED diff after `git add -A` and refuse to commit
# when it (a) deletes or truncates a protected file, or (b) stages a
# suspiciously large deletion anywhere. Tunable via env, hermetically
# testable (scripts/tests/test_ollama_local_tier.sh) with no real Ollama.
OLLAMA_GUARD_PROTECTED_GLOBS=${OLLAMA_GUARD_PROTECTED_GLOBS:-"CLAUDE.md plan/*.md plan/**/*.md AI/** package.json */package.json package-lock.json */package-lock.json yarn.lock */yarn.lock pnpm-lock.yaml */pnpm-lock.yaml"}
OLLAMA_GUARD_MAX_TOTAL_DELETIONS=${OLLAMA_GUARD_MAX_TOTAL_DELETIONS:-300}
OLLAMA_GUARD_MAX_FILE_DELETIONS=${OLLAMA_GUARD_MAX_FILE_DELETIONS:-100}

# ollama_guard_check WORKDIR — rc 0 when the CURRENTLY STAGED changes look
# safe; rc 1 + reasons on stdout (one per line) when they don't. Must be
# called AFTER `git add -A`, BEFORE `git commit`.
ollama_guard_check() {
    local workdir="$1" numstat_file rc
    numstat_file=$(mktemp -t ollama-guard-numstat.XXXXXX 2>/dev/null || echo /tmp/ollama-guard-numstat.$$)
    git -C "$workdir" diff --cached --numstat > "$numstat_file" 2>/dev/null
    GLOBS="$OLLAMA_GUARD_PROTECTED_GLOBS" \
    MAXTOTAL="${OLLAMA_GUARD_MAX_TOTAL_DELETIONS:-300}" \
    MAXFILE="${OLLAMA_GUARD_MAX_FILE_DELETIONS:-100}" \
    NAME_STATUS="$(git -C "$workdir" diff --cached --name-status 2>/dev/null)" \
    /usr/bin/python3 - "$numstat_file" <<'PY'
import sys, os, fnmatch

numstat_path = sys.argv[1]
globs = os.environ.get("GLOBS", "").split()
max_total = int(os.environ.get("MAXTOTAL", "300") or "300")
max_file = int(os.environ.get("MAXFILE", "100") or "100")

status_map = {}
for line in os.environ.get("NAME_STATUS", "").splitlines():
    parts = line.split("\t")
    if len(parts) >= 2:
        status_map[parts[-1]] = parts[0][0]

def is_protected(path):
    for g in globs:
        if fnmatch.fnmatch(path, g):
            return True
        if g.endswith("/**") and path.startswith(g[:-3].rstrip("/") + "/"):
            return True
    return False

total_add = 0
total_del = 0
reasons = []
try:
    with open(numstat_path) as f:
        lines = f.readlines()
except Exception:
    lines = []

for line in lines:
    line = line.rstrip("\n")
    if not line:
        continue
    parts = line.split("\t")
    if len(parts) != 3:
        continue
    added, deleted, path = parts
    a = 0 if added == "-" else int(added)
    d = 0 if deleted == "-" else int(deleted)
    total_add += a
    total_del += d
    if is_protected(path):
        st = status_map.get(path, "M")
        if st == "D":
            reasons.append("protected file deleted: %s" % path)
        elif d > 0 and a == 0 and d > 3:
            reasons.append("protected file truncated (-%d/+%d, all removed content): %s" % (d, a, path))
        elif d > max_file and d > a * 3:
            reasons.append("protected file heavily shrunk (-%d/+%d, threshold %d): %s" % (d, a, max_file, path))

if total_del > max_total and total_del > total_add * 2:
    reasons.append("suspiciously large deletion across the diff: -%d/+%d lines (threshold %d)" % (total_del, total_add, max_total))

if reasons:
    print("\n".join(reasons))
    sys.exit(1)
sys.exit(0)
PY
    rc=$?
    rm -f "$numstat_file" 2>/dev/null
    return $rc
}

# ── DIFF-FOR-REVIEW MODE (opt-in) ────────────────────────────────────────────
# When on, a local-tier attempt that passes the guard still does NOT commit
# directly to `test` — it prints the staged diff wrapped in a marker (parsed
# by the runner's runner_local_diff_reason) and discards the working-tree
# change, leaving the task for operator/Sonnet review instead of auto-landing
# unsupervised 7B-model output on a shared branch. Off by default (preserves
# existing commit-directly behavior) — flip on per operator risk tolerance.
OLLAMA_LOCAL_DIFF_ONLY=${OLLAMA_LOCAL_DIFF_ONLY:-off}
OLLAMA_GUARD_DIFF_MAX_CHARS=${OLLAMA_GUARD_DIFF_MAX_CHARS:-4000}

# _ollama_local_run_inner WORKDIR MODEL — the actual attempt, assuming the
# lock is already held. Ensures the 'test' branch, runs the bounded agent,
# and commits+pushes only when it genuinely edited something AND the
# anti-destructive guard (above) passes the staged diff.
_ollama_local_run_inner() {
    local workdir="$1" model="$2" py agent_rc push_ok=false guard_out

    if ! git -C "$workdir" rev-parse --git-dir >/dev/null 2>&1; then
        echo "[ollama-local] workdir is not a git repo — falling back"
        return 1
    fi
    py="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ollama_agent.py"

    git -C "$workdir" fetch origin --quiet >/dev/null 2>&1 || true
    if git -C "$workdir" rev-parse -q --verify origin/test >/dev/null 2>&1; then
        git -C "$workdir" checkout -B test origin/test --quiet 2>/dev/null || git -C "$workdir" checkout -B test --quiet
    else
        git -C "$workdir" checkout -B test --quiet
    fi

    /usr/bin/python3 "$py" --workdir "$workdir" --model "$model" \
        --base-url "$OLLAMA_BASE_URL" --keep-alive "$OLLAMA_LOCAL_KEEP_ALIVE" \
        --max-iters "$OLLAMA_LOCAL_MAX_ITERS"
    agent_rc=$?
    if [ "$agent_rc" -ne 0 ]; then
        echo "[ollama-local] agent did not land a fix locally — falling back"
        return 1
    fi

    if [ -z "$(git -C "$workdir" status --porcelain 2>/dev/null)" ]; then
        echo "[ollama-local] agent reported done but left no changes — falling back"
        return 1
    fi

    git -C "$workdir" add -A

    if ! guard_out="$(ollama_guard_check "$workdir")"; then
        echo "[ollama-local-GUARD-BLOCKED] anti-destructive guard REJECTED this local-tier attempt (task-4f813e39-style guard, operator directive 2026-07-26):"
        echo "$guard_out" | sed 's/^/  - /'
        git -C "$workdir" reset --quiet >/dev/null 2>&1 || true
        git -C "$workdir" checkout -- . >/dev/null 2>&1 || true
        git -C "$workdir" clean -fd -- . >/dev/null 2>&1 || true
        return 2
    fi

    if [ "${OLLAMA_LOCAL_DIFF_ONLY:-off}" = "on" ]; then
        echo "[ollama-local-DIFF-FOR-REVIEW] guard passed but OLLAMA_LOCAL_DIFF_ONLY=on — producing a diff for review instead of committing directly:"
        git -C "$workdir" diff --cached 2>/dev/null | head -c "$OLLAMA_GUARD_DIFF_MAX_CHARS"
        echo
        echo "[/ollama-local-DIFF-FOR-REVIEW]"
        git -C "$workdir" reset --quiet >/dev/null 2>&1 || true
        git -C "$workdir" checkout -- . >/dev/null 2>&1 || true
        git -C "$workdir" clean -fd -- . >/dev/null 2>&1 || true
        return 3
    fi

    if ! git -C "$workdir" -c user.email="runner@myai.local" -c user.name="myai-runner" \
        commit --quiet -m "chore: local-tier automated fix (Ollama $model)"; then
        echo "[ollama-local] commit failed — falling back"
        return 1
    fi

    if git -C "$workdir" push origin test --quiet 2>/dev/null; then
        push_ok=true
    else
        git -C "$workdir" fetch origin --quiet >/dev/null 2>&1 || true
        if git -C "$workdir" rebase origin/test --quiet 2>/dev/null \
            && git -C "$workdir" push origin test --quiet 2>/dev/null; then
            push_ok=true
        fi
    fi

    if [ "$push_ok" != true ]; then
        echo "[ollama-local] push to origin/test failed after rebase retry — falling back"
        return 1
    fi
    echo "[ollama-local] pushed local-tier fix to origin/test"
    return 0
}

# ollama_local_run WORKDIR MODEL — public entry point. rc meanings:
#   0 — genuine push to origin/test
#   1 — ordinary decline/failure (RAM preflight, lock contention, agent gave
#       up, nothing to commit, push conflict) → caller falls back to Sonnet
#   2 — anti-destructive guard REJECTED the staged diff (protected-file
#       delete/truncate or oversized deletion) → caller should BLOCK the
#       task with the guard's reason, not silently retry on Sonnet
#   3 — OLLAMA_LOCAL_DIFF_ONLY=on: guard passed, diff printed for review,
#       nothing committed/pushed → caller should surface the diff, not retry
ollama_local_run() {
    local workdir="$1" model="$2" rc
    if ! ollama_ram_ok; then
        echo "[ollama-local] system RAM below ${OLLAMA_MIN_FREE_RAM_MB}MB free — skipping local tier this run"
        return 1
    fi
    if ! ollama_lock_acquire; then
        echo "[ollama-local] another local inference is already in flight — skipping (never run local in parallel)"
        return 1
    fi
    _ollama_local_run_inner "$workdir" "$model"
    rc=$?
    ollama_lock_release
    return $rc
}
