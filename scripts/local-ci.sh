#!/usr/bin/env bash
# local-ci.sh — Run a repo's required CI checks locally and post commit
# statuses, so PRs can merge when GitHub Actions is unavailable (billing
# exhaustion, outage, offline).
#
# WHY: knofler's personal account shares one 2000-min/mo Actions free tier
# across all private repos. When exhausted, required checks (build, Security
# Audit, Ready to Merge, Enforce branch policy) silently never fire, leaving
# every PR permanently BLOCKED even though the code is fine. This replicates
# those checks locally (Docker-only, per project policy) and, on pass, posts
# success statuses via the GitHub commit-status API — satisfying branch
# protection's required-check list. Proven wire format: connect-hub PR #14.
#
# HONESTY CONTRACT: a `success` status is posted ONLY for a check that
# actually passed locally this run, or that the operator explicitly attested
# via --trust-build. A failed or un-runnable check posts `failure` (or is
# skipped with a warning) — never a fabricated success.
#
# Usage:
#   ./scripts/local-ci.sh                      # run checks for current repo/branch, post on pass
#   ./scripts/local-ci.sh --dry-run            # run checks, print results, post nothing
#   ./scripts/local-ci.sh --repo /path/to/r   # target a different repo
#   ./scripts/local-ci.sh --sha <full-sha>     # override commit (default: HEAD of --branch)
#   ./scripts/local-ci.sh --branch test        # override head branch (default: current)
#   ./scripts/local-ci.sh --trust-build        # skip running `build`, attest manual verification
#   ./scripts/local-ci.sh --history [sha]      # print recent ledger postings (optionally
#                                               # filtered to a sha prefix); reads nothing
#                                               # else, needs no gh/git/docker
#   ./scripts/local-ci.sh -h | --help
#
# AUDIT LEDGER: every status this script actually posts (never --dry-run's
# simulated ones) is appended as one JSONL row to
# ~/.ai-cli-runner/local-ci-ledger.jsonl (override: LOCAL_CI_LEDGER or
# RUNNER_STATE_DIR) — sha, repo, context, result, host, timestamp, whether
# --trust-build was in play, and a path to this run's full log. That's the
# provable record behind the fleet-wide rule "never post over a check that
# didn't genuinely pass." `--history` reads it back. Best-effort, non-fatal
# mirror to the gateway's audit trail when localhost:3100 is reachable.
#
# Exit codes: 0 all required checks passed (and posted unless --dry-run);
#             1 one or more checks failed; 2 usage/precondition error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/ci_check_map.sh
. "$SCRIPT_DIR/lib/ci_check_map.sh"

# ── Args ──────────────────────────────────────────────────────────────────
REPO_ROOT=""
SHA=""
BRANCH=""
DRY_RUN=0
TRUST_BUILD=0
HISTORY_MODE=0
HISTORY_SHA=""
NODE_IMAGE="${LOCAL_CI_NODE_IMAGE:-node:22-alpine}"

usage() { sed -n '2,41p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)        REPO_ROOT="$2"; shift 2 ;;
    --sha)         SHA="$2"; shift 2 ;;
    --branch)      BRANCH="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    --trust-build) TRUST_BUILD=1; shift ;;
    --history)
      HISTORY_MODE=1
      if [ $# -ge 2 ] && [[ "$2" != -* ]]; then HISTORY_SHA="$2"; shift 2; else shift 1; fi
      ;;
    -h|--help)     usage 0 ;;
    *) echo "Unknown arg: $1" >&2; usage 2 ;;
  esac
done

# ── Ledger (auditable posting record) ───────────────────────────────────────
# Every status this script actually posts gets one JSONL row here — the audit
# trail behind "never post over a check that didn't genuinely pass" (the
# fleet-wide admin-merge policy had zero record of what was posted, from which
# machine, or whether --trust-build was used). --dry-run posts nothing to
# GitHub, so it writes nothing here either — there's nothing yet to audit.
LEDGER="${LOCAL_CI_LEDGER:-${RUNNER_STATE_DIR:-$HOME/.ai-cli-runner}/local-ci-ledger.jsonl}"
HOST="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)"
RUNLOG=""

# gateway_audit_post <json-row> — best-effort mirror of the ledger row to the
# master gateway's audit trail via its MCP endpoint. Never fatal: a down or
# missing gateway must never affect local-ci's own pass/fail decision or the
# ledger file, which stays the source of truth.
gateway_audit_post() {
  command -v curl >/dev/null 2>&1 || return 0
  local row="$1" token="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
  curl -sf -m 2 -X POST "http://localhost:3100/mcp" \
    -H 'content-type: application/json' \
    -H "x-gateway-local-token: $token" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"audit_log_append\",\"arguments\":{\"source\":\"local-ci\",\"entry\":${row}}}}" \
    >/dev/null 2>&1 || true
}

# record_posting <ctx> <state> <posted 0|1> — append one ledger row for an
# actual (non-dry-run) posting attempt, then best-effort mirror it.
record_posting() {
  local ctx="$1" state="$2" posted="$3" row
  row="$(python3 - "$SHA" "$NWO" "$ctx" "$state" "$posted" "$TRUST_BUILD" "$HOST" "$RUNLOG" <<'PY'
import json, sys
from datetime import datetime, timezone
sha, repo, ctx, state, posted, trust, host, logtail = sys.argv[1:9]
print(json.dumps({
    "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "sha": sha,
    "repo": repo,
    "context": ctx,
    "result": state,
    "posted": posted == "1",
    "trust_build": trust == "1",
    "host": host,
    "log_tail": logtail,
}, sort_keys=True))
PY
)"
  [ -n "$row" ] || return 0
  mkdir -p "$(dirname "$LEDGER")" 2>/dev/null || true
  printf '%s\n' "$row" >> "$LEDGER" 2>/dev/null || true
  gateway_audit_post "$row"
}

# print_history [sha-prefix] — read the ledger back, most-recent last (tail
# semantics), optionally filtered to a sha prefix. No gh/git/docker needed —
# this is a plain reader, so it must work even when Actions/gh auth is the
# very thing that's broken.
print_history() {
  local filter="${1:-}"
  if [ ! -f "$LEDGER" ]; then
    echo "No ledger at $LEDGER — no postings recorded yet."
    return 0
  fi
  python3 - "$LEDGER" "$filter" <<'PY'
import json, sys
path = sys.argv[1]
filt = sys.argv[2] if len(sys.argv) > 2 else ""
rows = []
with open(path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
if filt:
    rows = [r for r in rows if str(r.get("sha", "")).startswith(filt)]
rows = rows[-50:]
if not rows:
    print("No matching ledger entries.")
    sys.exit(0)
for r in rows:
    print("{ts}  {sha:<12} {repo:<28} {ctx:<22} {result:<8} host={host:<12} trust_build={trust!s:<5} posted={posted!s}".format(
        ts=r.get("timestamp", "?"),
        sha=str(r.get("sha", "?"))[:12],
        repo=r.get("repo", "?"),
        ctx=r.get("context", "?"),
        result=r.get("result", "?"),
        host=r.get("host", "?"),
        trust=r.get("trust_build", False),
        posted=r.get("posted", False),
    ))
    lt = r.get("log_tail")
    if lt:
        print("    log: " + lt)
PY
}

if [ "$HISTORY_MODE" = 1 ]; then
  echo "── local-ci history ──────────────────────────────────────"
  echo "  ledger : $LEDGER"
  [ -n "$HISTORY_SHA" ] && echo "  filter : sha startswith $HISTORY_SHA"
  echo "──────────────────────────────────────────────────────────"
  print_history "$HISTORY_SHA"
  exit 0
fi

# ── Preconditions ───────────────────────────────────────────────────────────
command -v gh   >/dev/null 2>&1 || { echo "ERROR: gh CLI not found." >&2; exit 2; }
command -v git  >/dev/null 2>&1 || { echo "ERROR: git not found." >&2; exit 2; }
gh auth status >/dev/null 2>&1  || { echo "ERROR: gh not authenticated (run: gh auth login)." >&2; exit 2; }

# Resolve repo root (project root = git toplevel; works in master and managed
# repos since AI/ is a subdir of the project's git repo, not its own repo).
if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" \
    || { echo "ERROR: not inside a git repo and no --repo given." >&2; exit 2; }
fi
cd "$REPO_ROOT"

NWO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" \
  || { echo "ERROR: could not resolve owner/repo (no GitHub remote?)." >&2; exit 2; }
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
SHA="${SHA:-$(git rev-parse "$BRANCH" 2>/dev/null || git rev-parse HEAD)}"

# Capture this run's full output to a log file so ledger rows can point at it
# ("gate log tail path") — real evidence behind a posted status, not just an
# assertion. Skipped for --dry-run: nothing gets posted, so nothing to back up.
if [ "$DRY_RUN" != 1 ]; then
  LOG_DIR="${RUNNER_STATE_DIR:-$HOME/.ai-cli-runner}/local-ci-logs"
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  if [ -d "$LOG_DIR" ]; then
    RUNLOG="$LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:12}.log"
    exec > >(tee -a "$RUNLOG") 2>&1 || RUNLOG=""
  fi
fi

echo "── local-ci ──────────────────────────────────────────────"
echo "  repo   : $NWO"
echo "  root   : $REPO_ROOT"
echo "  branch : $BRANCH"
echo "  sha    : $SHA"
echo "  mode   : $([ "$DRY_RUN" = 1 ] && echo 'dry-run (no posting)' || echo 'post on pass')"
echo "──────────────────────────────────────────────────────────"

# ── Discover required contexts from branch protection ───────────────────────
# Authoritative source: exactly the checks blocking a PR to main.
contexts_json="$(gh api "repos/${NWO}/branches/main/protection/required_status_checks" 2>/dev/null || echo '{}')"
CONTEXTS=()
while IFS= read -r line; do
  [ -n "$line" ] && CONTEXTS+=("$line")
done < <(printf '%s' "$contexts_json" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
out = list(d.get("contexts") or [])
for c in d.get("checks") or []:
    if c.get("context") and c["context"] not in out:
        out.append(c["context"])
print("\n".join(out))
' 2>/dev/null)

if [ "${#CONTEXTS[@]}" -eq 0 ]; then
  echo "No required status checks on ${NWO}:main — nothing to post. Exiting clean."
  exit 0
fi
echo "Required contexts: ${CONTEXTS[*]}"
echo

# `overall` accumulates failures across every gate below (incl. the §3.4
# tenant-scoping gate, which is invoked after its definition — see below).
overall=0

# ── Docker helper (Docker-only policy — no host npm) ────────────────────────
run_node() {
  # run_node "<sh command>"  — runs in throwaway node container with repo mounted
  command -v docker >/dev/null 2>&1 || { echo "    docker unavailable"; return 3; }
  docker run --rm -v "$REPO_ROOT":/app -w /app "$NODE_IMAGE" sh -lc "$1"
}

# Find this repo's running DB sidecar (mongo/postgres/mysql) so DB-backed build/
# test steps can reach it via a shared network namespace. Returns name or empty.
repo_db_sidecar() {
  local base; base="$(basename "$REPO_ROOT" | tr '[:upper:]' '[:lower:]')"
  docker ps --format '{{.Names}}' 2>/dev/null \
    | grep -iE "^${base}[-_].*(mongo|db|postgres|mysql|redis)" | head -1 || true
}

# Detect a devDeps-bearing build stage in the repo's Dockerfile. Production
# standalone runner images strip devDeps (no `next`/`tsc`/`vitest`), so we build
# the *builder* stage instead — it has the full toolchain. Stage name varies
# across blueprints: builder | build | dev. Echoes the stage name or empty.
repo_build_stage() {
  [ -f "$REPO_ROOT/Dockerfile" ] || return 0
  local st
  for st in builder build dev; do
    if grep -iqE "AS[[:space:]]+${st}([[:space:]]|$)" "$REPO_ROOT/Dockerfile"; then
      echo "$st"; return 0
    fi
  done
}

# ── Check runners — each prints detail, returns 0 pass / non-0 fail ─────────
check_branch_policy() {
  echo "  [Enforce branch policy] head=$BRANCH"
  if [ "$BRANCH" = "test" ] || [[ "$BRANCH" =~ ^hotfix/ ]]; then
    echo "    PASS — branch '$BRANCH' permitted into main"; return 0
  fi
  echo "    FAIL — PRs to main must come from 'test' or 'hotfix/*' (got '$BRANCH')"; return 1
}

check_security_audit() {
  echo "  [Security Audit] secret scan + npm audit"
  # 1) committed-secret scan (same pattern as merge-gate.yml)
  if git grep -nE '(JWT_SECRET|ADMIN_API_KEY|RESEND_API_KEY|MONGODB_URI)\s*=\s*["'"'"'][^"'"'"']{8,}' \
       -- ':!*.example' ':!*.md' ':!.github/' ':!docker-compose.yml' >/dev/null 2>&1; then
    echo "    FAIL — hardcoded secret-shaped string in tracked files"; return 1
  fi
  echo "    ok — no committed secrets"
  # 2) npm audit (production deps) inside Docker — needs package-lock.json
  if [ -f package-lock.json ]; then
    if run_node 'npm audit --omit=dev --audit-level=high'; then
      echo "    PASS — npm audit clean (no high+ in prod deps)"; return 0
    else
      echo "    FAIL — npm audit found high+ severity in prod deps"; return 1
    fi
  fi
  echo "    PASS — no package-lock.json (audit n/a), secret scan clean"; return 0
}

check_build() {
  echo "  [build] lint + typecheck + build + test"
  if [ "$TRUST_BUILD" = 1 ]; then
    echo "    PASS — build trusted via --trust-build (operator manual verification)"; return 0
  fi
  [ -f package.json ] || { echo "    SKIP — no package.json"; return 2; }
  # Assemble the script chain from whatever scripts the repo actually defines.
  local steps="" s
  for s in lint typecheck build test; do
    if python3 -c "import json,sys; sys.exit(0 if '$s' in json.load(open('package.json')).get('scripts',{}) else 1)" 2>/dev/null; then
      steps="${steps}${steps:+ && }npm run $s"
    fi
  done
  [ -n "$steps" ] || { echo "    SKIP — no lint/typecheck/build/test scripts"; return 2; }
  command -v docker >/dev/null 2>&1 || { echo "    docker unavailable"; return 3; }

  # DB sidecar → share its network namespace so DB-backed build/test reach it.
  local netarg="" dbctr
  dbctr="$(repo_db_sidecar)"
  if [ -n "$dbctr" ]; then
    netarg="--network container:$dbctr"
    echo "    DB sidecar '$dbctr' detected — sharing its network for DB-backed steps"
  fi
  local dbenv="-e MONGODB_URI=${MONGODB_URI:-mongodb://localhost:27017/localci} -e CI=1"

  # ── Production-faithful path: build the Dockerfile's *builder* stage ──────
  # NEVER `docker exec` into the running container — it's a production STANDALONE
  # image (devDeps stripped → `next: not found`), the silent verify gap that
  # stalled the whole fleet's review backlog (can't verify → can't ship). The
  # builder stage carries the full toolchain and builds in an isolated layer (no
  # host node_modules/.next pollution). Build verifies the BUILD; we then run the
  # remaining gates (lint/typecheck/test) inside that built image.
  local stage; stage="$(repo_build_stage)"
  if [ -n "$stage" ]; then
    local base img; base="$(basename "$REPO_ROOT" | tr '[:upper:]' '[:lower:]')"
    img="localci-verify-${base}:latest"
    echo "    production-faithful build — docker build --target $stage ($img)"
    if ! DOCKER_BUILDKIT=1 docker build --target "$stage" -t "$img" "$REPO_ROOT"; then
      echo "    FAIL — builder-stage image build failed (real npm ci + npm run build)"; return 1
    fi
    # Remaining gates that the image build didn't already cover (build ran in the
    # docker build above). Run them in the built image (devDeps + source present).
    local gates="" g
    for g in lint typecheck test; do
      if python3 -c "import json,sys; sys.exit(0 if '$g' in json.load(open('package.json')).get('scripts',{}) else 1)" 2>/dev/null; then
        gates="${gates}${gates:+ && }npm run $g"
      fi
    done
    if [ -z "$gates" ]; then
      echo "    PASS — build chain green (builder stage; no lint/typecheck/test scripts to add)"; return 0
    fi
    echo "    running gates in built image: $gates"
    # shellcheck disable=SC2086
    if docker run --rm $netarg $dbenv -w /app "$img" sh -lc "$gates"; then
      echo "    PASS — build chain green (production-faithful: builder image + $gates)"; return 0
    fi
    echo "    FAIL — lint/typecheck/test failed in builder image"; return 1
  fi

  # ── Fallback: no Dockerfile builder stage → ephemeral node image w/ devDeps ──
  echo "    no builder stage; ephemeral $NODE_IMAGE (npm ci + devDeps): $steps"
  # shellcheck disable=SC2086
  if docker run --rm $netarg $dbenv -v "$REPO_ROOT":/app -w /app "$NODE_IMAGE" sh -lc "npm ci && $steps"; then
    echo "    PASS — build chain green (ephemeral, production-faithful)"; return 0
  fi
  echo "    FAIL — build chain failed (ephemeral)"; return 1
}

# ── Generic single-script / audit checks for non-standard context names ─────
# (e.g. agentFlow's "Lint" / "Type-check" / "Test" / "Audit" jobs — see
# lib/ci_check_map.sh for the name→script mapping). Mirrors check_build's
# builder-stage / ephemeral-image logic for a single npm script instead of the
# whole lint+typecheck+build+test chain.
check_npm_script() {
  local candidates="$1" ctx="$2" script="" c
  echo "  [$ctx] npm run <${candidates// /|}>"
  [ -f package.json ] || { echo "    SKIP — no package.json"; return 2; }
  for c in $candidates; do
    if python3 -c "import json,sys; sys.exit(0 if '$c' in json.load(open('package.json')).get('scripts',{}) else 1)" 2>/dev/null; then
      script="$c"; break
    fi
  done
  [ -n "$script" ] || { echo "    SKIP — no matching script ($candidates) in package.json"; return 2; }
  command -v docker >/dev/null 2>&1 || { echo "    docker unavailable"; return 3; }

  local netarg="" dbctr; dbctr="$(repo_db_sidecar)"
  if [ -n "$dbctr" ]; then
    netarg="--network container:$dbctr"
    echo "    DB sidecar '$dbctr' detected — sharing its network for DB-backed steps"
  fi
  local dbenv="-e MONGODB_URI=${MONGODB_URI:-mongodb://localhost:27017/localci} -e CI=1"

  local stage; stage="$(repo_build_stage)"
  if [ -n "$stage" ]; then
    local base img; base="$(basename "$REPO_ROOT" | tr '[:upper:]' '[:lower:]')"
    img="localci-verify-${base}:latest"
    if ! docker image inspect "$img" >/dev/null 2>&1; then
      echo "    production-faithful build — docker build --target $stage ($img)"
      DOCKER_BUILDKIT=1 docker build --target "$stage" -t "$img" "$REPO_ROOT" \
        || { echo "    FAIL — builder-stage image build failed"; return 1; }
    fi
    # shellcheck disable=SC2086
    if docker run --rm $netarg $dbenv -w /app "$img" sh -lc "npm run $script"; then
      echo "    PASS — npm run $script green (builder image)"; return 0
    fi
    echo "    FAIL — npm run $script failed in builder image"; return 1
  fi

  echo "    no builder stage; ephemeral $NODE_IMAGE (npm ci + devDeps): npm run $script"
  # shellcheck disable=SC2086
  if docker run --rm $netarg $dbenv -v "$REPO_ROOT":/app -w /app "$NODE_IMAGE" sh -lc "npm ci && npm run $script"; then
    echo "    PASS — npm run $script green (ephemeral)"; return 0
  fi
  echo "    FAIL — npm run $script failed (ephemeral)"; return 1
}

check_audit_generic() {
  echo "  [Audit] npm audit"
  if [ -f package-lock.json ]; then
    if run_node 'npm audit --omit=dev --audit-level=high'; then
      echo "    PASS — npm audit clean (no high+ in prod deps)"; return 0
    fi
    echo "    FAIL — npm audit found high+ severity in prod deps"; return 1
  fi
  echo "    SKIP — no package-lock.json"; return 2
}

# ── ADR-010 §3.4 tenant-scoping gate (distributed multi-tenancy rule) ────────
# Flags any raw query on a SCOPED collection model that lacks a tenant filter —
# a silent cross-tenant data-leak class. The compile-time defenses (mandatory
# tenantId store params + scoped-query helper) are primary; this gate is the
# regression backstop in CI. CRITICAL — blocks the merge. Logic now lives in
# scripts/check_tenant_scoping.sh (shared with .github/workflows/tenant-isolation.yml
# — the normal ship-blocking path; this call is the billing-outage fallback).
check_tenant_scoping() {
  local rc=0 out=""
  out="$("$SCRIPT_DIR/check_tenant_scoping.sh" --repo "$REPO_ROOT" 2>&1)" || rc=$?
  printf '%s\n' "$out" | sed 's/^/  /'
  return "$rc"
}

# ── runtime/ coverage gate (task-fa7872ba) ──────────────────────────────────
# vitest.config.ts's coverage.thresholds (global + per-src-directory + tighter
# floors on rbac.ts/task-store.ts/router.ts) is the regression backstop for the
# gateway's real line/branch coverage — previously configured (provider: v8)
# but never enforced anywhere. Runs `npm run test:coverage` (vitest run
# --coverage) in an ephemeral node image; several tests shell out to `git`
# (brain_* tools) so it's installed into the image first, not just npm deps.
check_runtime_coverage() {
  local rt="$REPO_ROOT/runtime"
  echo "  [runtime coverage] npm run test:coverage (vitest --coverage + thresholds)"
  [ -f "$rt/package.json" ] || { echo "    SKIP — no runtime/package.json"; return 2; }
  python3 -c "import json,sys; sys.exit(0 if 'test:coverage' in json.load(open('$rt/package.json')).get('scripts',{}) else 1)" 2>/dev/null \
    || { echo "    SKIP — no test:coverage script in runtime/package.json"; return 2; }
  command -v docker >/dev/null 2>&1 || { echo "    docker unavailable"; return 3; }
  # Mount the WHOLE repo (not just runtime/) at /app, cwd'd into runtime/ —
  # several tests reach up past runtime/ to repo-root fixtures (e.g.
  # tests/unit/standing-agents.test.ts reads the top-level agents/ dir); a
  # runtime/-only mount 404s those and misreports them as coverage failures.
  # Deliberately ignores $NODE_IMAGE (default node:22-alpine) — several tests
  # spawn the CLI through tsx/esbuild, whose musl (alpine) binary segfaults
  # silently to a bare non-zero exit with no stderr, misreported as a coverage
  # regression; a glibc image matches actual CI (ubuntu-latest) and is stable.
  if docker run --rm -v "$REPO_ROOT":/app -w /app/runtime node:22 sh -lc \
      "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git >/dev/null 2>&1; npm ci && npm run test:coverage"; then
    echo "    PASS — coverage thresholds met"; return 0
  fi
  echo "    FAIL — coverage below threshold, or a non-excluded test failed"; return 1
}

# ── ADR-010 §3.4 tenant-scoping gate (invoked here, after its definition) ────
# CRITICAL distributed-rule block (documentation/AI_RULES.md): a violation must
# prevent a green run regardless of branch-protection contexts. A failure flips
# `overall`, so the "Ready to Merge" aggregator below reports failure and the
# script exits non-zero — no success status is posted. (Must follow the function
# definition above; bash resolves calls at runtime but the name must be defined.)
# NB: set -e-safe — check_tenant_scoping returns 2 on SKIP (non-gateway repos
# with no runtime/src) and 1 on FAIL; a bare `check_tenant_scoping; ts_rc=$?`
# would let `set -e` abort the whole script before $? is captured, so the gate
# (and ALL downstream checks) silently never run in every non-gateway repo.
ts_rc=0; check_tenant_scoping || ts_rc=$?
if [ "$ts_rc" -eq 1 ]; then overall=1; fi
echo

# ── Tracked-file hygiene gate (commit 4ece268 regression backstop) ──────────
# CRITICAL block, same contract as the tenant gate above: machine-local
# ledgers/state (state/ dotfiles, pool-capacity.json, runner ledgers, .env*)
# in the git index fail the run regardless of branch-protection contexts.
# .gitignore only guards while it exists — 4ece268 gutted it and six ledgers
# were pushed to test unnoticed; this checks what is ACTUALLY tracked. Logic
# lives in scripts/check_tracked_hygiene.sh (shared with the pre-push hook and
# script-unit-tests.yml's ungated `hygiene` job). set -e-safe rc capture.
check_tracked_hygiene() {
  local rc=0 out=""
  out="$("$SCRIPT_DIR/check_tracked_hygiene.sh" --repo "$REPO_ROOT" 2>&1)" || rc=$?
  printf '%s\n' "$out" | sed 's/^/  /'
  return "$rc"
}
th_rc=0; check_tracked_hygiene || th_rc=$?
if [ "$th_rc" -eq 1 ]; then overall=1; fi
echo

# Same set -e-safe pattern as the tenant-scoping gate above: rc 2 is SKIP (no
# runtime/ in this repo), rc 1 is a genuine FAIL that must flip `overall`.
cov_rc=0; check_runtime_coverage || cov_rc=$?
if [ "$cov_rc" -eq 1 ]; then overall=1; fi
echo

# ── Run required checks (Ready to Merge is an aggregator — evaluate last) ────
# bash-3.2 safe: no associative arrays. Results stored as "state<TAB>context"
# lines; set_result/get_result read/write that string.
RESULTS=""
set_result() { RESULTS="${RESULTS}${2}"$'\t'"${1}"$'\n'; }   # set_result <ctx> <state>
get_result() { printf '%s' "$RESULTS" | awk -F'\t' -v c="$1" '$2==c{print $1; exit}'; }
# apply_rc <ctx> <rc> — rc: 0 pass, 2 skip, anything else fail (+ overall=1).
# Callers must capture rc via `cmd || rc=$?` (set -e-safe — see the "build"
# case's note below) before calling this.
apply_rc() {
  if [ "$2" -eq 0 ]; then set_result "$1" pass
  elif [ "$2" -eq 2 ]; then set_result "$1" skip
  else set_result "$1" fail; overall=1; fi
}
# NB: do NOT reset `overall` here — the tenant-scoping gate above may already
# have set it to 1, and that CRITICAL block must survive into "Ready to Merge".
HAS_READY=0

for ctx in "${CONTEXTS[@]}"; do
  case "$ctx" in
    "Ready to Merge") HAS_READY=1; continue ;;
    "Enforce branch policy")
      if check_branch_policy; then set_result "$ctx" pass; else set_result "$ctx" fail; overall=1; fi ;;
    "Security Audit")
      if check_security_audit; then set_result "$ctx" pass; else set_result "$ctx" fail; overall=1; fi ;;
    "build")
      # set -e-safe: check_build returns 2 on SKIP (no package.json / no
      # build scripts) and 1 on FAIL. A bare `check_build; rc=$?` lets
      # `set -euo pipefail` abort the whole script before $? is captured —
      # the same class of bug as the tenant gate above (PR #256). Invisible
      # at the master (it HAS package.json → build returns 0) but it killed
      # local-ci on any repo whose build SKIPs. Caught by fleet_smoke.sh.
      rc=0; check_build || rc=$?
      apply_rc "$ctx" "$rc" ;;
    *)
      # Non-standard context name (e.g. agentFlow's "Lint"/"Type-check"/
      # "Test"/"Audit") — see lib/ci_check_map.sh. Falls through to the old
      # "no local runner mapped" SKIP only when nothing matches, instead of
      # for every check whose name isn't one of this repo's own.
      script="$(ci_map_npm_scripts "$ctx")"
      if [ -n "$script" ]; then
        rc=0; check_npm_script "$script" "$ctx" || rc=$?
        apply_rc "$ctx" "$rc"
      elif ci_map_audit "$ctx"; then
        rc=0; check_audit_generic || rc=$?
        apply_rc "$ctx" "$rc"
      else
        echo "  [$ctx] no local runner mapped — SKIP (will not post)"; set_result "$ctx" skip
      fi ;;
  esac
  echo
done

# Ready to Merge mirrors `needs: [...]` — passes only if no required check failed.
if [ "$HAS_READY" = 1 ]; then
  if [ "$overall" -eq 0 ]; then
    set_result "Ready to Merge" pass; echo "  [Ready to Merge] PASS — all prerequisite checks green"
  else
    set_result "Ready to Merge" fail; echo "  [Ready to Merge] FAIL — a prerequisite check failed"
  fi
  echo
fi

# ── Post statuses ────────────────────────────────────────────────────────────
post_status() {
  local ctx="$1" state="$2" desc="$3"
  if [ "$DRY_RUN" = 1 ]; then
    printf '  would post: %-22s %-7s "%s"\n' "$ctx" "$state" "$desc"; return 0
  fi
  local posted=0
  if gh api -X POST "repos/${NWO}/statuses/${SHA}" \
       -f state="$state" -f context="$ctx" -f description="$desc" >/dev/null 2>&1; then
    printf '  posted: %-22s %s\n' "$ctx" "$state"
    posted=1
  else
    printf '  POST FAILED: %-22s %s\n' "$ctx" "$state"; overall=1
  fi
  record_posting "$ctx" "$state" "$posted"
}

echo "── posting statuses ──────────────────────────────────────"
for ctx in "${CONTEXTS[@]}"; do
  state="$(get_result "$ctx")"; state="${state:-skip}"
  case "$state" in
    pass) post_status "$ctx" success "local-ci: passed locally $(date -u +%Y-%m-%dT%H:%M:%SZ)" ;;
    fail) post_status "$ctx" failure "local-ci: failed locally — not merge-ready" ;;
    skip) echo "  skipped (not posted): $ctx — no local verification available" ;;
  esac
done
echo "──────────────────────────────────────────────────────────"

if [ "$overall" -eq 0 ]; then
  echo "RESULT: all required checks satisfied$([ "$DRY_RUN" = 1 ] && echo ' (dry-run — nothing posted)')."
  exit 0
fi
echo "RESULT: one or more required checks failed — PR is NOT merge-ready."
exit 1
