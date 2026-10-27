#!/usr/bin/env bash
# local-ci.sh — Run a repo's required CI checks locally and post commit
# statuses, so PRs can merge when GitHub Actions is unavailable (billing
# exhaustion, outage, offline).
#
# WHY: a personal GitHub account shares one 2000-min/mo Actions free tier
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
#   ./scripts/local-ci.sh --base test          # PR base branch (default: the base of the open
#                                               # PR for --branch, else main). Required checks
#                                               # come from THIS branch's protection, and
#                                               # 'Enforce branch policy' (merge-gate.yml) only
#                                               # applies when the base is main.
#   ./scripts/local-ci.sh --trust-build        # skip running `build`, attest manual verification
#   ./scripts/local-ci.sh --dry-run --no-branch-policy
#                                               # report 'Enforce branch policy' as skipped:
#                                               # it checks a PR head NAME, not code, so a
#                                               # health check on `main` (the boot) must not
#                                               # FAIL on it. Refused without --dry-run.
#   ./scripts/local-ci.sh --history [sha]      # print recent ledger postings (optionally
#                                               # filtered to a sha prefix); reads nothing
#                                               # else, needs no gh/git/docker
#   ./scripts/local-ci.sh -h | --help
#
# Environment:
#   LOCAL_CI_MODE=runner|docker   force the Node/tsc/vitest/coverage gates into
#                                 the warm self-hosted gh-runner (docker exec) or
#                                 into ad-hoc throwaway containers. Default: auto
#                                 — the runner when a free myai-gh-runner is up
#                                 with the toolchain, else ad-hoc (unchanged).
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
# Exit codes: 0 every check that ran genuinely passed (and posted unless
#             --dry-run) — the exit code IS the verdict, safe to script on;
#             1 any required check or CRITICAL gate failed OR could not run
#             (docker unavailable, gate script missing/crashed);
#             2 usage/precondition error (gh/git missing, unauthenticated,
#             required-checks query failed — never masked as a green 0).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/ci_check_map.sh
. "$SCRIPT_DIR/lib/ci_check_map.sh"

# Runner mode — run the Node/tsc/vitest/coverage gates inside the warm
# self-hosted gh-runner via `docker exec`, instead of an ad-hoc `docker run
# node:22` per gate (one env matching real CI; the runner has NO docker socket
# and never gets one — we drive it from the host's docker CLI). [ -f ] guard:
# this lib may not yet be in update_all's propagation set, so a managed repo's
# propagated local-ci.sh must still run — degrade to docker-only (today's
# behaviour) rather than hard-fail "No such file or directory" (task-e6d1325e).
if [ -f "$SCRIPT_DIR/lib/local_ci_runner.sh" ]; then
  # shellcheck source=lib/local_ci_runner.sh
  . "$SCRIPT_DIR/lib/local_ci_runner.sh"
else
  LCR_RUNNER_CONTAINER="${LOCAL_CI_RUNNER_CONTAINER:-myai-gh-runner}"
  LCR_MODE="docker"
  LCR_MODE_REASON="runner lib not shipped in this repo → ad-hoc containers"
  lcr_resolve_mode() { LCR_MODE=docker; }
fi

# ── Args ──────────────────────────────────────────────────────────────────
REPO_ROOT=""
SHA=""
BRANCH=""
BASE=""
DRY_RUN=0
TRUST_BUILD=0
NO_BRANCH_POLICY=0
HISTORY_MODE=0
HISTORY_SHA=""
NODE_IMAGE="${LOCAL_CI_NODE_IMAGE:-node:22-alpine}"

# Resource caps for every throwaway container this script starts.
#
# WHY: these are ad-hoc `docker run`s, not compose services, and they were
# previously launched with no --memory/--cpus at all (docker inspect showed
# memLimit=0, cpus=0). Two consequences, both observed on 2026-09-04:
#   1. `npm ci && npm run test:coverage` in one of them reached 626 MiB /
#      450% CPU / 101 PIDs, starving the box. That contention made a
#      SYNCHRONOUS, spawnSync('git')-chaining brain test blow its 10s
#      per-test timeout, producing a CI "failure" that was pure flake
#      (it passed 50/50 on the gh-runner at the same SHA).
#   2. hooks/session/13-ram-guard.sh sums only DEFAULT-PROFILE COMPOSE
#      services, so an ad-hoc container is invisible to the 2 GB project
#      ceiling — the guard reported "403 MB / 2048 MB (under ceiling)"
#      while that single container was using 626 MiB.
# Capping here does not make the guard see them (that is the other half of
# task-6cd9d9c4), but it does stop one local-ci run from eating the machine.
#
# Defaults leave real headroom: npm ci + vitest peaked ~660 MiB, so 1500m is
# ~2.3x that. Override per-run when a heavier gate needs it.
# An ARRAY, not a string: the two flags must reach docker as two separate
# words, and an array expands that way under "${CTR_LIMITS[@]}" without
# relying on unquoted word-splitting (which SC2086 flags, and which zsh
# would not split at all). Always non-empty, so bash 3.2's empty-array +
# `set -u` quirk cannot bite.
CTR_MEMORY="${LOCAL_CI_MEMORY:-1500m}"
CTR_CPUS="${LOCAL_CI_CPUS:-4}"
CTR_LIMITS=(--memory="$CTR_MEMORY" --cpus="$CTR_CPUS")

usage() { sed -n '2,57p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)        REPO_ROOT="$2"; shift 2 ;;
    --sha)         SHA="$2"; shift 2 ;;
    --branch)      BRANCH="$2"; shift 2 ;;
    --base)        BASE="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    --trust-build) TRUST_BUILD=1; shift ;;
    --no-branch-policy) NO_BRANCH_POLICY=1; shift ;;
    --history)
      HISTORY_MODE=1
      if [ $# -ge 2 ] && [[ "$2" != -* ]]; then HISTORY_SHA="$2"; shift 2; else shift 1; fi
      ;;
    -h|--help)     usage 0 ;;
    *) echo "Unknown arg: $1" >&2; usage 2 ;;
  esac
done

if [ "$NO_BRANCH_POLICY" = 1 ] && [ "$DRY_RUN" != 1 ]; then
  echo "local-ci: --no-branch-policy is only allowed with --dry-run (a real run must enforce it)" >&2
  exit 2
fi

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
# PR base: explicit --base wins; else the base of the open PR whose head is
# $BRANCH; else main. Before 2026-10-04 local-ci assumed main, so a lane → test
# PR got a bogus 'Enforce branch policy: failure' status posted on its commit
# (PR #485) — merge-gate.yml only governs PRs INTO main.
BASE_SRC="--base"
if [ -z "$BASE" ]; then
  # Same-repo PRs only (a fork PR with the same branch name must not decide);
  # several open PRs with different bases → main wins (stricter checks).
  pr_bases="" pr_rc=0
  pr_bases="$(gh pr list --repo "$NWO" --head "$BRANCH" --state open --limit 5 \
    --json baseRefName,isCrossRepository -q '.[] | select(.isCrossRepository | not) | .baseRefName' 2>&1)" || pr_rc=$?
  if [ "$pr_rc" -ne 0 ]; then
    BASE="main"; BASE_SRC="default — PR lookup failed: $(printf '%s' "$pr_bases" | head -1)"
  else
    pr_bases="$(printf '%s\n' "$pr_bases" | awk 'NF' | sort -u)"
    case "$(printf '%s' "$pr_bases" | grep -c . || true)" in
      0) BASE="main"; BASE_SRC="default — no open PR for $BRANCH" ;;
      1) BASE="$pr_bases"; BASE_SRC="open PR for $BRANCH" ;;
      *) BASE="main"; BASE_SRC="open PRs into several bases ($(printf '%s' "$pr_bases" | tr '\n' ' ')) — main is stricter" ;;
    esac
  fi
fi
echo "local-ci: head=$BRANCH base=$BASE ($BASE_SRC)"

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

# ── Resolve gate execution mode (runner vs ad-hoc docker) ───────────────────
# The warm self-hosted runner, when one is free, is the env real CI uses — so
# prefer it for the Node/tsc/vitest/coverage gates (one warm toolchain matching
# ubuntu-latest). Falls back to today's ad-hoc throwaway containers when there
# is no free runner, or LOCAL_CI_MODE forces docker. Resolved once; every gate
# honours it and names its own row's mode. See lib/local_ci_runner.sh.
# Plain call (NOT "$(...)"): lcr_resolve_mode sets LCR_MODE + LCR_MODE_REASON as
# globals in THIS shell — a command substitution would lose the reason.
# Several runners per repo (runner slots): pick a free one of THIS repo's.
if [ -z "${LOCAL_CI_RUNNER_CONTAINER:-}" ] && command -v lcr_pick_container >/dev/null 2>&1; then
  LCR_RUNNER_CONTAINER="$(lcr_pick_container "$NWO")"
fi
lcr_resolve_mode "${LCR_RUNNER_CONTAINER:-myai-gh-runner}" "$NWO"
LCR_STAGED_DIR=""   # memo: the checkout is staged into the runner once per run

# lcr_stage_once — stage SHA's committed tree into the runner EXACTLY once per
# run (the gates share one checkout). Sets the GLOBAL LCR_STAGED_DIR (callers
# read it, rather than $(lcr_stage_once) — a command substitution would run in a
# subshell and the memo would never persist, re-staging per gate). rc 0 on
# success (dir in LCR_STAGED_DIR), non-zero on failure.
lcr_stage_once() {
  [ -n "$LCR_STAGED_DIR" ] && return 0
  local d
  d="$(lcr_stage "$REPO_ROOT" "$SHA" "${LCR_RUNNER_CONTAINER:-myai-gh-runner}")" || return 1
  LCR_STAGED_DIR="$d"
}

echo "── local-ci ──────────────────────────────────────────────"
echo "  repo   : $NWO"
echo "  root   : $REPO_ROOT"
echo "  branch : $BRANCH"
echo "  sha    : $SHA"
echo "  mode   : $([ "$DRY_RUN" = 1 ] && echo 'dry-run (no posting)' || echo 'post on pass')"
echo "  gates  : $LCR_MODE — $LCR_MODE_REASON"
echo "──────────────────────────────────────────────────────────"

# ── Blueprint freshness (warn-only, informational) ──────────────────────────
# Only fires in the master AI repo itself (guarded on templates/blueprint/
# package.json existing) — a no-op everywhere else, including every project
# scaffolded from the blueprint. Never touches `overall`/exit code: this is
# "is the canonical scaffold falling behind npm", not a merge gate.
if [ -f "$SCRIPT_DIR/blueprint_freshness.sh" ] && [ -f "$REPO_ROOT/templates/blueprint/package.json" ]; then
  echo "── blueprint freshness (warn-only — template vs npm registry) ─────"
  bash "$SCRIPT_DIR/blueprint_freshness.sh" || echo "  (non-blocking — see table above; not a merge gate)"
  echo "─────────────────────────────────────────────────────────────────"
  echo
fi

# ── Discover required contexts from branch protection ───────────────────────
# Authoritative source: exactly the checks blocking a PR to $BASE.
# HTTP 404 ("branch not protected") is a legitimate clean no-op; ANY other gh
# failure (network, auth, rate limit) is a precondition error → exit 2. The
# old `|| echo '{}'` collapsed both into "nothing to post. Exiting clean." —
# a network blip produced a green exit 0 that verified nothing, the exact
# lying-exit-code class this task exists to close (task-44f717c4).
gh_ctx_rc=0
contexts_json="$(gh api "repos/${NWO}/branches/${BASE}/protection/required_status_checks" 2>&1)" || gh_ctx_rc=$?
if [ "$gh_ctx_rc" -ne 0 ]; then
  if printf '%s' "$contexts_json" | grep -q 'HTTP 404'; then
    contexts_json='{}'
  else
    echo "ERROR: could not query required status checks for ${NWO}:${BASE} — refusing to guess (exit 2, never a green 0)." >&2
    printf '%s\n' "$contexts_json" | sed 's/^/  gh: /' >&2
    exit 2
  fi
fi
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

# Nothing required on this base (e.g. `test`) → nothing to POST, but the gates
# still run: a lane→test PR deserves the same local verification. This used to
# `exit 0` here — and said ":main" whatever the base — so `--base test` ran NO
# gates at all, the always-run ones included (2026-10-04). Run the default
# local set instead (each maps to an npm script or is skipped) and post nothing.
LOCAL_ONLY=0
if [ "${#CONTEXTS[@]}" -eq 0 ]; then
  LOCAL_ONLY=1
  CONTEXTS=("Lint" "Type-check" "Test" "build")
  echo "No required status checks on ${NWO}:${BASE} — nothing to post; running the default local gates anyway: ${CONTEXTS[*]}"
else
  echo "Required contexts: ${CONTEXTS[*]}"
fi
echo

# `overall` accumulates failures across every gate below (incl. the §3.4
# tenant-scoping gate, which is invoked after its definition — see below).
overall=0

# One-line failure recap, re-printed next to the final RESULT: line. Callers
# habitually pipe this script through `tail`, which hides per-check FAIL lines
# hundreds of lines up — that's how a red run got misread live as green.
FAIL_RECAP=""
add_fail_recap() { FAIL_RECAP="${FAIL_RECAP}  FAIL: $1"$'\n'; }

# gate_rc <label> <rc> — fold a CRITICAL gate's rc into `overall`.
# rc 0 = pass; rc 2 = SKIP (gate not applicable on this repo/machine).
# ANY other rc fails the run — not just 1: rc 3 (docker unavailable) and
# 126/127 (gate script missing/crashed) mean the gate VERIFIED NOTHING, and
# the HONESTY CONTRACT forbids turning "could not run" into a green exit.
gate_rc() {
  case "$2" in
    0|2) return 0 ;;
  esac
  overall=1
  add_fail_recap "$1 (rc $2)"
}

# ── Docker helper (Docker-only policy — no host npm) ────────────────────────
run_node() {
  # run_node "<sh command>"  — run against the repo in a Node environment.
  # Runner mode: docker exec into the warm gh-runner (staged checkout, no mount).
  # Docker mode: a throwaway node container with the repo mounted (unchanged).
  if [ "${LCR_MODE:-docker}" = runner ]; then
    lcr_stage_once || { echo "    runner staging failed"; return 3; }
    lcr_exec "$LCR_STAGED_DIR" "$1" "$LCR_RUNNER_CONTAINER"
    return
  fi
  command -v docker >/dev/null 2>&1 || { echo "    docker unavailable"; return 3; }
  docker run --rm "${CTR_LIMITS[@]}" -v "$REPO_ROOT":/app -w /app "$NODE_IMAGE" sh -lc "$1"
}

# Find this repo's running DB sidecar (mongo/postgres/mysql) so DB-backed build/
# test steps can reach it via a shared network namespace. Returns name or empty.
repo_db_sidecar() {
  local base rname pat
  base="$(basename "$REPO_ROOT" | tr '[:upper:]' '[:lower:]')"
  rname="$(printf '%s' "${NWO:-}" | sed 's#.*/##' | tr '[:upper:]' '[:lower:]')"
  pat="^(${base}${rname:+|${rname}})[-_].*(mongo|db|postgres|mysql|redis)"
  docker ps --format '{{.Names}}' 2>/dev/null \
    | grep -iE "$pat" | head -1 || true
}

# Compute a per-repo + worktree + SHA builder image tag so two repos whose
# worktrees share a directory basename (e.g. ~/.myai/worktrees/<repo>/agy-ship-wave1)
# or two commits in the same worktree never collide on `localci-verify-<base>:latest`
# (2026-10-21).
localci_builder_image_tag() {
  local rname base ssha
  rname="$(printf '%s' "${NWO:-}" | sed 's#.*/##' | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9._-' '-')"
  base="$(basename "$REPO_ROOT" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9._-' '-')"
  ssha="$(printf '%s' "${SHA:-latest}" | cut -c1-12 | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9._-' '-')"
  rname="${rname%-}"
  base="${base%-}"
  ssha="${ssha%-}"
  if [ -n "$rname" ] && [ "$rname" != "$base" ]; then
    printf 'localci-verify-%s-%s:%s' "$rname" "$base" "${ssha:-latest}"
  else
    printf 'localci-verify-%s:%s' "${base:-repo}" "${ssha:-latest}"
  fi
}

LOCALCI_BUILT_IMAGES=""
LOCALCI_PRUNE_AGE_H="${LOCALCI_PRUNE_AGE_H:-6}"

# Write ${LOCALCI_ACTIVE_DIR:-$HOME/.myai/localci-active}/<tag>.<pid> while this
# run holds <tag>. Never use TMPDIR: sandboxed sessions get private TMPDIR paths
# (e.g. /private/tmp/claude-504/...), so two lanes would miss each other's
# markers. A fully-cached rebuild keeps its original (old) CreatedAt timestamp,
# so age-only pruning could delete an image held by another concurrent run
# unless guarded by a shared per-user live-pid marker (2026-10-21).
localci_active_dir() {
  printf '%s' "${LOCALCI_ACTIVE_DIR:-$HOME/.myai/localci-active}"
}

localci_mark_active_image() {
  local img="$1" adir
  adir="$(localci_active_dir)"
  mkdir -p "$adir" 2>/dev/null || true
  printf '%s\n' "$img" > "$adir/${img}.$$" 2>/dev/null || true
  case " ${LOCALCI_BUILT_IMAGES:-} " in
    *" $img "*) ;;
    *) LOCALCI_BUILT_IMAGES="${LOCALCI_BUILT_IMAGES:-} $img" ;;
  esac
}

# shellcheck disable=SC2329
localci_cleanup_builder_images() {
  local rc=$?
  local adir mfile mbase mpid mtag active_tags=" "
  adir="$(localci_active_dir)"
  if [ -d "$adir" ]; then
    rm -f "$adir/"*".$$" 2>/dev/null || true
    for mfile in "$adir"/*.*; do
      [ -e "$mfile" ] || continue
      mbase="$(basename "$mfile")"
      mpid="${mbase##*.}"
      mtag="${mbase%.*}"
      case "$mpid" in ''|*[!0-9]*) continue ;; esac
      if kill -0 "$mpid" 2>/dev/null; then
        active_tags="${active_tags}${mtag} "
      else
        rm -f "$mfile" 2>/dev/null || true
      fi
    done
  fi
  command -v docker >/dev/null 2>&1 || return "$rc"
  local img in_use stale raw_images stale_list
  if [ "${LOCALCI_KEEP_IMAGE:-0}" != "1" ]; then
    for img in ${LOCALCI_BUILT_IMAGES:-}; do
      [ -n "$img" ] || continue
      case "$active_tags" in *" $img "*) continue ;; esac
      docker image rm -f "$img" >/dev/null 2>&1 || true
    done
  fi
  # Prune leftover localci-verify-* images whose CreatedAt is older than
  # LOCALCI_PRUNE_AGE_H hours (default 6h). Fresh foreign images (<6h) and any
  # image with a live marker in ${TMPDIR}/localci-active/<tag>.<pid> survive so
  # a concurrent local-ci in another lane (even on a cached image with old
  # CreatedAt) is never stripped of its image between gates. Never removes an
  # image backing a running container or this run's kept image.
  in_use=" $(docker ps --format '{{.Image}}' 2>/dev/null | tr '\n' ' ') "
  raw_images="$(docker images --format '{{.Repository}}:{{.Tag}}	{{.CreatedAt}}' 'localci-verify-*' 2>/dev/null || true)"
  if [ -n "$raw_images" ] && command -v python3 >/dev/null 2>&1; then
    stale_list="$(RAW_IMAGES="$raw_images" python3 - "${LOCALCI_PRUNE_AGE_H:-6}" <<'PY'
import os, re, sys
from datetime import datetime, timezone, timedelta
try:
    age_h = float(sys.argv[1])
except Exception:
    age_h = 6.0
cutoff = datetime.now(timezone.utc) - timedelta(hours=age_h)
for raw in os.environ.get("RAW_IMAGES", "").splitlines():
    line = raw.strip()
    if not line:
        continue
    parts = re.split(r"\t+|\s{2,}", line, maxsplit=1)
    if len(parts) < 2:
        parts = line.split(" ", 1)
    if len(parts) < 2:
        continue
    tag, created = parts[0].strip(), parts[1].strip()
    m = re.match(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:\s*([+-]\d{2}):?(\d{2})|Z)?", created)
    if not m:
        continue
    tz = f"{m.group(3)}:{m.group(4)}" if (m.group(3) and m.group(4)) else "+00:00"
    try:
        dt = datetime.fromisoformat(f"{m.group(1)}T{m.group(2)}{tz}")
    except Exception:
        continue
    if dt < cutoff:
        print(tag)
PY
    )"
    for stale in $stale_list; do
      [ -n "$stale" ] || continue
      case "$stale" in *"<none>"*) continue ;; esac
      case " ${LOCALCI_BUILT_IMAGES:-} " in *" $stale "*) continue ;; esac
      case "$active_tags" in *" $stale "*) continue ;; esac
      case "$in_use" in *" $stale "*) continue ;; esac
      docker image rm -f "$stale" >/dev/null 2>&1 || true
    done
  fi
  return "$rc"
}
trap localci_cleanup_builder_images EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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

# Detect whether the repo's test harness honours MONGODB_MEMORY_SERVER=1 for
# in-process MongoDB (e.g. vitest/jest global-setup or CI workflow env).
# Never scans AI/, state/, logs/, docs/, or *.md so propagated framework
# files and handoff notes cannot self-match.
repo_supports_memory_mongo() {
  local p
  for p in tests test src .github/workflows; do
    if [ -d "$REPO_ROOT/$p" ] && grep -rqE 'MONGODB_MEMORY_SERVER' "$REPO_ROOT/$p" 2>/dev/null; then
      return 0
    fi
  done
  for p in "$REPO_ROOT"/vitest.config.* "$REPO_ROOT"/jest.config.*; do
    if [ -f "$p" ] && grep -qE 'MONGODB_MEMORY_SERVER' "$p" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

repo_builder_is_alpine() {
  [ -f "$REPO_ROOT/Dockerfile" ] && grep -iqE '^FROM[[:space:]]+[^[:space:]]*alpine' "$REPO_ROOT/Dockerfile"
}

# ── Check runners — each prints detail, returns 0 pass / non-0 fail ─────────
check_branch_policy() {
  echo "  [Enforce branch policy] head=$BRANCH base=$BASE"
  if [ "$BASE" != "main" ]; then
    # SKIP, never PASS: commit statuses are per SHA+context, so a posted success
    # here could later satisfy main's required check on the same SHA (PR #489 review).
    echo "    SKIP — n/a: the policy (merge-gate.yml) governs PRs into main only; '$BRANCH' → '$BASE' is allowed"; return 2
  fi
  if [ "$BRANCH" = "test" ] || [[ "$BRANCH" =~ ^hotfix/ ]]; then
    echo "    PASS — branch '$BRANCH' permitted into main"; return 0
  fi
  echo "    FAIL — PRs to main must come from 'test' or 'hotfix/*' (got '$BRANCH')"; return 1
}

# run_repo_secret_steps — run the repo's OWN secret-scan step(s) from its
# workflows (lib/ci_workflow_steps.py), verbatim, on LINUX git in Docker: the
# steps use `\s`, which macOS git's regex does not support, so on the host they
# silently match nothing (connect #60, 2026-10-21: local-ci green, hosted
# Security Audit red). The repo and its git common dir are mounted at their own
# paths so a worktree's .git pointer still resolves. rc 0 pass / 1 fail /
# 2 no such step / 3 docker unavailable.
run_repo_secret_steps() {
  local d f common rc=0 any=0
  d="$(mktemp -d -t localci-secret.XXXXXX)"
  python3 "$SCRIPT_DIR/lib/ci_workflow_steps.py" secret-steps "$REPO_ROOT" "$d" > "$d/list" 2>/dev/null || true
  [ -s "$d/list" ] || { rm -rf "$d"; return 2; }
  command -v docker >/dev/null 2>&1 || { rm -rf "$d"; return 3; }
  common="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  while IFS= read -r f; do
    any=1
    echo "    repo step: $(head -1 "$f" | sed 's/^# from //') (Linux git)"
    if ! docker run --rm "${CTR_LIMITS[@]}" -v "$REPO_ROOT":"$REPO_ROOT" \
         ${common:+-v "$common":"$common"} -v "$f":/localci-secret-step.sh:ro \
         -w "$REPO_ROOT" --entrypoint sh "${LOCAL_CI_GIT_IMAGE:-alpine/git}" \
         -c 'git config --global --add safe.directory "*" && sh -e /localci-secret-step.sh'; then
      rc=1
    fi
  done < "$d/list"
  rm -rf "$d"
  [ "$any" = 1 ] || return 2
  return "$rc"
}

check_security_audit() {
  echo "  [Security Audit] secret scan + npm audit"
  # 1) committed-secret scan (same pattern as merge-gate.yml). [[:space:]], not
  #    \s: macOS git's ERE has no \s, so the old pattern never matched on a Mac.
  if git grep -nE '(JWT_SECRET|ADMIN_API_KEY|RESEND_API_KEY|MONGODB_URI)[[:space:]]*=[[:space:]]*["'"'"'][^"'"'"']{8,}' \
       -- ':!*.example' ':!*.md' ':!.github/' ':!docker-compose.yml'; then
    echo "    FAIL — hardcoded secret-shaped string in tracked files"; return 1
  fi
  echo "    ok — no committed secrets (built-in pattern)"
  # 1b) the repo's own secret-scan step, exactly as its CI runs it
  local srs=0; run_repo_secret_steps || srs=$?
  case "$srs" in
    0) echo "    ok — repo's own secret-scan step passes on Linux" ;;
    1) echo "    FAIL — repo's own secret-scan step failed (as its CI would)"; return 1 ;;
    3) echo "    FAIL — repo defines a secret-scan step but docker is unavailable to run it"; return 1 ;;
  esac
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
  echo "  [build] lint + typecheck + openapi:check + build + test"
  if [ "$TRUST_BUILD" = 1 ]; then
    echo "    PASS — build trusted via --trust-build (operator manual verification)"; return 0
  fi
  [ -f package.json ] || { echo "    SKIP — no package.json"; return 2; }
  # Say which `npm run` steps the repo's own CI runs that this chain does not —
  # a green local-ci is only as wide as what it ran (connect #60: openapi:check).
  local unrun
  unrun="$(python3 "$SCRIPT_DIR/lib/ci_workflow_steps.py" npm-runs "$REPO_ROOT" 2>/dev/null \
    | grep -vxE 'lint|typecheck|openapi:check|build|test' | tr '\n' ' ' | sed 's/ $//')"
  [ -z "$unrun" ] || echo "    note — repo CI also runs (not run here): $unrun"
  # Assemble the script chain from whatever scripts the repo actually defines.
  # openapi:check = the Rule 7 drift guard where a repo ships one.
  local steps="" s
  for s in lint typecheck openapi:check build test; do
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
  local mem_mongo=0 mem_env=""
  if repo_supports_memory_mongo; then
    mem_mongo=1
    dbenv="$dbenv -e MONGODB_MEMORY_SERVER=${MONGODB_MEMORY_SERVER:-1} -e MONGOMS_DISTRO=${MONGOMS_DISTRO:-ubuntu-22.04}"
    mem_env="MONGODB_MEMORY_SERVER=${MONGODB_MEMORY_SERVER:-1} MONGOMS_DISTRO=${MONGOMS_DISTRO:-ubuntu-22.04} "
    echo "    in-process Mongo detected — exporting MONGODB_MEMORY_SERVER=${MONGODB_MEMORY_SERVER:-1}"
    steps="${steps/npm run test/${mem_env}npm run test}"
  fi

  # ── Production-faithful path: build the Dockerfile's *builder* stage ──────
  # NEVER `docker exec` into the running container — it's a production STANDALONE
  # image (devDeps stripped → `next: not found`), the silent verify gap that
  # stalled the whole fleet's review backlog (can't verify → can't ship). The
  # builder stage carries the full toolchain and builds in an isolated layer (no
  # host node_modules/.next pollution). Build verifies the BUILD; we then run the
  # remaining gates (lint/typecheck/test) inside that built image.
  local stage; stage="$(repo_build_stage)"
  if [ -n "$stage" ]; then
    local img; img="$(localci_builder_image_tag)"
    localci_mark_active_image "$img"
    echo "    production-faithful build — docker build --target $stage ($img)"
    if ! DOCKER_BUILDKIT=1 docker build --target "$stage" -t "$img" "$REPO_ROOT"; then
      echo "    FAIL — builder-stage image build failed (real npm ci + npm run build)"; return 1
    fi
    # Remaining gates that the image build didn't already cover (build ran in the
    # docker build above). Run them in the built image (devDeps + source present).
    local gates="" g
    for g in lint typecheck openapi:check test; do
      if python3 -c "import json,sys; sys.exit(0 if '$g' in json.load(open('package.json')).get('scripts',{}) else 1)" 2>/dev/null; then
        if [ "$g" = "test" ] && [ "$mem_mongo" = 1 ]; then
          gates="${gates}${gates:+ && }${mem_env}npm run $g"
        else
          gates="${gates}${gates:+ && }npm run $g"
        fi
      fi
    done
    if [ -z "$gates" ]; then
      echo "    PASS — build chain green (builder stage; no lint/typecheck/test scripts to add)"; return 0
    fi
    echo "    running gates in built image: $gates"
    # shellcheck disable=SC2086
    if docker run --rm "${CTR_LIMITS[@]}" $netarg $dbenv -w /app "$img" sh -lc "$gates"; then
      echo "    PASS — build chain green (production-faithful: builder image + $gates)"; return 0
    fi
    echo "    FAIL — lint/typecheck/test failed in builder image"; return 1
  fi

  # ── Fallback: no Dockerfile builder stage → warm runner / ephemeral node ──
  # Runner mode runs the chain via docker exec in the warm gh-runner (the CI
  # TOOLCHAIN container — not the repo's own production image this function
  # warns against exec-ing into above). Gated on NO DB sidecar: a sidecar means
  # DB-backed steps need `--network container:<db>`, which docker exec can't add
  # to the already-running runner — so those stay ad-hoc and say so per row.
  if [ "${LCR_MODE:-docker}" = runner ] && [ -z "$dbctr" ]; then
    lcr_stage_once || { echo "    FAIL — runner staging failed"; return 1; }
    echo "    no builder stage; runner exec $LCR_RUNNER_CONTAINER (npm ci + devDeps): $steps"
    if lcr_exec "$LCR_STAGED_DIR" "npm ci && $steps" "$LCR_RUNNER_CONTAINER"; then
      echo "    PASS — build chain green (runner)"; return 0
    fi
    echo "    FAIL — build chain failed (runner)"; return 1
  fi
  [ -n "$dbctr" ] && [ "${LCR_MODE:-docker}" = runner ] \
    && echo "    (DB sidecar network required — ad-hoc container, not the runner)"
  local eph_img="$NODE_IMAGE"
  if [ "$mem_mongo" = 1 ] && [ -z "${LOCAL_CI_NODE_IMAGE:-}" ]; then
    eph_img="node:22"
  fi
  echo "    no builder stage; ephemeral $eph_img (npm ci + devDeps): $steps"
  # shellcheck disable=SC2086
  if docker run --rm "${CTR_LIMITS[@]}" $netarg $dbenv -v "$REPO_ROOT":/app -w /app "$eph_img" sh -lc "npm ci && $steps"; then
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
  local mem_mongo=0 mem_env=""
  case "$script" in
    test|test:*)
      if repo_supports_memory_mongo; then
        mem_mongo=1
        dbenv="$dbenv -e MONGODB_MEMORY_SERVER=${MONGODB_MEMORY_SERVER:-1} -e MONGOMS_DISTRO=${MONGOMS_DISTRO:-ubuntu-22.04}"
        mem_env="MONGODB_MEMORY_SERVER=${MONGODB_MEMORY_SERVER:-1} MONGOMS_DISTRO=${MONGOMS_DISTRO:-ubuntu-22.04} "
        echo "    in-process Mongo detected — exporting MONGODB_MEMORY_SERVER=${MONGODB_MEMORY_SERVER:-1}"
      fi
      ;;
  esac

  local stage; stage="$(repo_build_stage)"
  if [ -n "$stage" ] && { [ "$mem_mongo" = 0 ] || [ -n "$dbctr" ] || ! repo_builder_is_alpine; }; then
    local img; img="$(localci_builder_image_tag)"
    # Rebuild ONCE PER RUN, never "only if missing": an existing tag is a
    # snapshot of whatever tree last built it, and gating on it posted green
    # statuses for code the image did not contain (one fleet repo, 2026-09-29: a
    # 2-month-old image ran 3 of 5 test files). Layer cache keeps this cheap.
    case " ${LOCALCI_BUILT_IMAGES:-} " in
      *" $img "*) ;;
      *)
        localci_mark_active_image "$img"
        echo "    production-faithful build — docker build --target $stage ($img)"
        DOCKER_BUILDKIT=1 docker build --target "$stage" -t "$img" "$REPO_ROOT" \
          || { echo "    FAIL — builder-stage image build failed"; return 1; }
        ;;
    esac
    # shellcheck disable=SC2086
    if docker run --rm "${CTR_LIMITS[@]}" $netarg $dbenv -w /app "$img" sh -lc "${mem_env}npm run $script"; then
      echo "    PASS — npm run $script green (builder image)"; return 0
    fi
    echo "    FAIL — npm run $script failed in builder image"; return 1
  fi
  if [ -n "$stage" ] && [ "$mem_mongo" = 1 ] && [ -z "$dbctr" ] && repo_builder_is_alpine; then
    echo "    builder stage '$stage' is Alpine (no official MongoDB binary for musl) — running '$script' on glibc"
  fi

  # Runner mode when no DB sidecar is needed (see check_build for the rationale).
  if [ "${LCR_MODE:-docker}" = runner ] && [ -z "$dbctr" ]; then
    lcr_stage_once || { echo "    FAIL — runner staging failed"; return 1; }
    echo "    no builder stage; runner exec $LCR_RUNNER_CONTAINER (npm ci + devDeps): ${mem_env}npm run $script"
    if lcr_exec "$LCR_STAGED_DIR" "npm ci && ${mem_env}npm run $script" "$LCR_RUNNER_CONTAINER"; then
      echo "    PASS — npm run $script green (runner)"; return 0
    fi
    echo "    FAIL — npm run $script failed (runner)"; return 1
  fi
  [ -n "$dbctr" ] && [ "${LCR_MODE:-docker}" = runner ] \
    && echo "    (DB sidecar network required — ad-hoc container, not the runner)"
  local eph_img="$NODE_IMAGE"
  if [ "$mem_mongo" = 1 ] && [ -z "${LOCAL_CI_NODE_IMAGE:-}" ]; then
    eph_img="node:22"
  fi
  echo "    no builder stage; ephemeral $eph_img (npm ci + devDeps): ${mem_env}npm run $script"
  # shellcheck disable=SC2086
  if docker run --rm "${CTR_LIMITS[@]}" $netarg $dbenv -v "$REPO_ROOT":/app -w /app "$eph_img" sh -lc "npm ci && ${mem_env}npm run $script"; then
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
  # ── Runner mode: docker exec in the warm gh-runner ────────────────────────
  # The runner is ubuntu 24.04 (glibc, matching ubuntu-latest) with git already
  # installed — so it needs NEITHER the ad-hoc apt-get git step below NOR the
  # explicit glibc-image pin: it IS the glibc env, and the whole staged repo is
  # present so the repo-root fixtures those tests reach up to resolve too.
  if [ "${LCR_MODE:-docker}" = runner ]; then
    lcr_stage_once || { echo "    FAIL — runner staging failed"; return 1; }
    echo "    mode: runner — docker exec $LCR_RUNNER_CONTAINER (glibc, git preinstalled; matches ubuntu-latest)"
    if lcr_exec "$LCR_STAGED_DIR/runtime" "npm ci && npm run test:coverage" "$LCR_RUNNER_CONTAINER"; then
      echo "    PASS — coverage thresholds met (runner)"; return 0
    fi
    echo "    FAIL — coverage below threshold, or a non-excluded test failed (runner)"; return 1
  fi
  # ── Docker mode: ad-hoc glibc node:22 (unchanged) ─────────────────────────
  # Mount the WHOLE repo (not just runtime/) at /app, cwd'd into runtime/ —
  # several tests reach up past runtime/ to repo-root fixtures (e.g.
  # tests/unit/standing-agents.test.ts reads the top-level agents/ dir); a
  # runtime/-only mount 404s those and misreports them as coverage failures.
  # Deliberately ignores $NODE_IMAGE (default node:22-alpine) — several tests
  # spawn the CLI through tsx/esbuild, whose musl (alpine) binary segfaults
  # silently to a bare non-zero exit with no stderr, misreported as a coverage
  # regression; a glibc image matches actual CI (ubuntu-latest) and is stable.
  echo "    mode: docker — ad-hoc node:22 (glibc, deliberately not alpine)"
  if docker run --rm "${CTR_LIMITS[@]}" -v "$REPO_ROOT":/app -w /app/runtime node:22 sh -lc \
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
gate_rc "tenant-scoping gate (ADR-010 §3.4)" "$ts_rc"
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
  # [ -f ] guard (same contract as check_capability_counts_gate): this static
  # gate's script is master-CI tooling and is NOT in update_all's propagation
  # set, so in a managed repo the propagated local-ci.sh must SKIP (rc 2), not
  # hard-fail "No such file or directory" (task-e6d1325e — the same
  # unpropagated-sibling class as ci_check_map.sh/task-29df1165).
  [ -f "$SCRIPT_DIR/check_tracked_hygiene.sh" ] \
    || { echo "  SKIP — check_tracked_hygiene.sh not shipped in this repo"; return 2; }
  out="$("$SCRIPT_DIR/check_tracked_hygiene.sh" --repo "$REPO_ROOT" 2>&1)" || rc=$?
  printf '%s\n' "$out" | sed 's/^/  /'
  return "$rc"
}
th_rc=0; check_tracked_hygiene || th_rc=$?
gate_rc "tracked-file hygiene gate" "$th_rc"
echo

# ── Stat-ordering gate (AI_RULES §4 regression backstop) ────────────────────
# CRITICAL block, same contract as the gates above: a BSD-first
# `stat -f ... || stat -c ...` fallback chain is a silent-corruption bug on
# Linux (GNU `-f` means `--file-system`, so the BSD form succeeds with garbage
# instead of failing over) — it has recurred multiple times fleet-wide
# (473a19a, b5a6a8bd). Logic lives in scripts/check_stat_ordering.sh (shared
# with script-unit-tests.yml). set -e-safe rc capture.
check_stat_ordering() {
  local rc=0 out=""
  [ -f "$SCRIPT_DIR/check_stat_ordering.sh" ] \
    || { echo "  SKIP — check_stat_ordering.sh not shipped in this repo"; return 2; }
  out="$("$SCRIPT_DIR/check_stat_ordering.sh" --repo "$REPO_ROOT" 2>&1)" || rc=$?
  printf '%s\n' "$out" | sed 's/^/  /'
  return "$rc"
}
so_rc=0; check_stat_ordering || so_rc=$?
gate_rc "stat-ordering gate (AI_RULES §4)" "$so_rc"
echo

# ── Shellcheck gate (baseline-suppressed) ───────────────────────────────────
# CRITICAL block, same contract as the gates above: a NEW shellcheck finding
# (one not already in scripts/ci/shellcheck-baseline.txt) fails the run
# regardless of branch-protection contexts. Logic lives in
# scripts/check_shellcheck.sh (shared with script-unit-tests.yml's
# `static-lint` job). rc 2 = shellcheck not installed on this machine -> SKIP,
# not FAIL, so local-ci stays usable on a box without it. set -e-safe rc
# capture (same reason as the tenant-scoping gate above).
check_shellcheck_gate() {
  local rc=0 out=""
  [ -f "$SCRIPT_DIR/check_shellcheck.sh" ] \
    || { echo "  SKIP — check_shellcheck.sh not shipped in this repo"; return 2; }
  out="$("$SCRIPT_DIR/check_shellcheck.sh" --repo "$REPO_ROOT" 2>&1)" || rc=$?
  printf '%s\n' "$out" | sed 's/^/  /'
  return "$rc"
}
shc_rc=0; check_shellcheck_gate || shc_rc=$?
gate_rc "shellcheck gate" "$shc_rc"
echo

# ── Bash 3.2 array-safety gate (baseline-suppressed) ────────────────────────
# CRITICAL block: an empty-array "${NAME[@]}" expansion unguarded under
# `set -u` is a silent macOS-only crash (bash 3.2 is /bin/bash on every Mac in
# the fleet) — fixed 3x already (d49145f2, 773028eb, 6911067f). Logic lives in
# scripts/check_bash32_arrays.sh (shared with script-unit-tests.yml's
# `static-lint` job). set -e-safe rc capture.
check_bash32_arrays_gate() {
  local rc=0 out=""
  [ -f "$SCRIPT_DIR/check_bash32_arrays.sh" ] \
    || { echo "  SKIP — check_bash32_arrays.sh not shipped in this repo"; return 2; }
  out="$("$SCRIPT_DIR/check_bash32_arrays.sh" --repo "$REPO_ROOT" 2>&1)" || rc=$?
  printf '%s\n' "$out" | sed 's/^/  /'
  return "$rc"
}
b32_rc=0; check_bash32_arrays_gate || b32_rc=$?
gate_rc "bash-3.2 array-safety gate" "$b32_rc"
echo

# ── Capability-count gate (task-70ef2d84) ────────────────────────────────────
# CRITICAL block, same contract as the gates above: README/SHOWCASE/package.json
# capability-count claims (agents/skills/MCP tools/hooks) must match the shipped
# artifacts on EVERY PR, not only at release time. Previously the script was
# wired only into publish_guard.sh step 0, so drift accumulated silently across
# weeks of PRs and the eventual --fix diff spanned dozens of unrelated changes.
# rc 2 = scanner precondition missing (no agents//skills//runtime/ — i.e. a
# managed repo, not the master) -> SKIP, not FAIL, so fleet-rolled local-ci
# stays usable everywhere. set -e-safe rc capture.
check_capability_counts_gate() {
  local rc=0 out=""
  echo "  [capability counts] README/SHOWCASE/package.json vs shipped artifacts"
  [ -f "$SCRIPT_DIR/check_capability_counts.sh" ] \
    || { echo "    SKIP — check_capability_counts.sh not shipped in this repo"; return 2; }
  out="$(bash "$SCRIPT_DIR/check_capability_counts.sh" --root "$REPO_ROOT" 2>&1)" || rc=$?
  printf '%s\n' "$out" | sed 's/^/    /'
  return "$rc"
}
cc_rc=0; check_capability_counts_gate || cc_rc=$?
gate_rc "capability-count gate" "$cc_rc"
echo

# ── Tool-surface gate (task-ffafa43f) ────────────────────────────────────────
# CRITICAL block, same contract as the gates above: the MCP tool-NAME surface
# (runtime/src/mcp/tools.ts TOOL_DEFINITIONS) must match the committed
# scripts/tool_surface_baseline.txt on EVERY local-ci run. Found shipping
# PR #454 (26db2989): adding two MCP tools required updating FOUR independent
# guards, and this one — enforced in CI via test_check_tool_surface.sh under
# the "Shell unit tests (scripts/tests)" check — was the only one local-ci did
# not run, so --dry-run printed "all required checks satisfied" while the PR's
# shell-unit-tests check was red. Hermetic (python3 only, <1s). rc 2 = scanner
# precondition missing (no runtime/src/mcp/tools.ts — a managed repo, not the
# master) -> SKIP, not FAIL, same as the capability-count gate above. The
# [ -f ] guard is the unpropagated-sibling protection (task-e6d1325e class).
# set -e-safe rc capture.
check_tool_surface_gate() {
  local rc=0 out=""
  echo "  [tool surface] TOOL_DEFINITIONS vs scripts/tool_surface_baseline.txt"
  [ -f "$SCRIPT_DIR/check_tool_surface.sh" ] \
    || { echo "    SKIP — check_tool_surface.sh not shipped in this repo"; return 2; }
  out="$(bash "$SCRIPT_DIR/check_tool_surface.sh" --root "$REPO_ROOT" 2>&1)" || rc=$?
  printf '%s\n' "$out" | sed 's/^/    /'
  return "$rc"
}
tsf_rc=0; check_tool_surface_gate || tsf_rc=$?
gate_rc "tool-surface gate (baseline)" "$tsf_rc"
echo

# Same set -e-safe pattern as the tenant-scoping gate above: rc 2 is SKIP (no
# runtime/ in this repo); any other non-zero rc — incl. 3 "docker unavailable",
# which previously read as green — must flip `overall` (gate_rc).
cov_rc=0; check_runtime_coverage || cov_rc=$?
gate_rc "runtime coverage gate" "$cov_rc"
echo

# ── Brain token SLO gate (BRAIN W2.4) ────────────────────────────────────────
# The brain's core claim — "a blank agent boots for a few hundred tokens, not
# tens of thousands, because it reads the compiled brief + only-what-changed
# instead of STATE.md + the handoff in full" (scripts/brain_token_eval.py) —
# was previously just a number someone had to remember to check. This turns
# it into an enforced SLO: fail the build if cold-start or smart-returning
# boot cost regresses past budget. Degrades to SKIP (not FAIL) when this
# machine has no brain store (fresh clone / CI runner with no ~/.myai/brain)
# so CI stays green there — the gate only bites once a brain exists to regress.
check_brain_token_slo() {
  local cold_budget=500 smart_budget=3000
  echo "  [Brain Token SLO] cold-start <${cold_budget} tok, smart-returning <${smart_budget} tok"
  command -v python3 >/dev/null 2>&1 || { echo "    SKIP — python3 unavailable"; return 2; }
  [ -f "$SCRIPT_DIR/brain_token_eval.py" ] || { echo "    SKIP — brain_token_eval.py not found"; return 2; }
  local json_out
  if ! json_out="$(python3 "$SCRIPT_DIR/brain_token_eval.py" --json 2>&1)"; then
    echo "    SKIP — brain_token_eval.py errored: $json_out"; return 2
  fi
  BRAIN_SLO_COLD_BUDGET="$cold_budget" BRAIN_SLO_SMART_BUDGET="$smart_budget" \
    python3 - "$json_out" <<'PY'
import json, os, sys
cold_budget = int(os.environ["BRAIN_SLO_COLD_BUDGET"])
smart_budget = int(os.environ["BRAIN_SLO_SMART_BUDGET"])
try:
    data = json.loads(sys.argv[1])
except Exception as e:
    print(f"    SKIP — could not parse brain_token_eval.py output ({e})")
    sys.exit(2)

cold = data.get("cold_start", {}).get("new_tokens", -1)
smart = data.get("smart_returning", {}).get("tokens", -1)

if cold < 0 or smart < 0:
    print("    SKIP — no brain store on this machine (brief.md/working.md absent)")
    sys.exit(2)

print(f"    cold-start   : {cold} tok  (budget < {cold_budget})")
print(f"    smart-return : {smart} tok  (budget < {smart_budget})")

ok = True
if cold >= cold_budget:
    print(f"    FAIL — cold-start {cold} tok >= budget {cold_budget} tok (regression)")
    ok = False
if smart >= smart_budget:
    print(f"    FAIL — smart-returning {smart} tok >= budget {smart_budget} tok (regression)")
    ok = False
if not ok:
    sys.exit(1)
print("    PASS — brain token SLO within budget")
sys.exit(0)
PY
}
bts_rc=0; check_brain_token_slo || bts_rc=$?
gate_rc "brain token SLO gate" "$bts_rc"
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
      if [ "$NO_BRANCH_POLICY" = 1 ]; then
        echo "  [Enforce branch policy] head=$BRANCH — skipped (--no-branch-policy: PR metadata, not code)"
        set_result "$ctx" skip
      else
        bp_rc=0; check_branch_policy || bp_rc=$?
        case "$bp_rc" in
          0) set_result "$ctx" pass ;;
          2) set_result "$ctx" skip ;;   # n/a for a non-main base — never posted
          *) set_result "$ctx" fail; overall=1 ;;
        esac
      fi ;;
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
    add_fail_recap "posting '$ctx' status to GitHub"
  fi
  record_posting "$ctx" "$state" "$posted"
}

echo "── posting statuses ──────────────────────────────────────"
for ctx in "${CONTEXTS[@]}"; do
  state="$(get_result "$ctx")"; state="${state:-skip}"
  if [ "$LOCAL_ONLY" = 1 ]; then
    echo "  local only (${BASE} requires no checks) — not posted: $ctx $state"
    continue
  fi
  case "$state" in
    pass) post_status "$ctx" success "local-ci: passed locally $(date -u +%Y-%m-%dT%H:%M:%SZ)" ;;
    fail) post_status "$ctx" failure "local-ci: failed locally — not merge-ready" ;;
    skip) echo "  skipped (not posted): $ctx — no local verification available" ;;
  esac
done
echo "──────────────────────────────────────────────────────────"

# ── PR-check coverage (honesty report, task-ffafa43f) ────────────────────────
# Branch protection on main lists ONE required context ("Enforce branch
# policy") while a PR to main actually runs ~15 check jobs across the
# pull_request-triggered workflows — so "all required checks satisfied" above
# is a much narrower claim than "the PR will be green" (found shipping PR #454:
# local-ci green, "Shell unit tests (scripts/tests)" red). This section derives
# the real PR check set from .github/workflows/*.yml and names every check this
# run did NOT verify, and the green RESULT line below is qualified whenever
# that list is non-empty — the false-confidence class dies here, not in CI.
# Informational only: it never flips `overall` (a parse failure must not turn
# a genuinely verified run red), and it degrades to nothing when there are no
# PR-triggered workflows (managed-repo fixtures, bare repos).
PR_COV_N=0 PR_COV_TOTAL=0 PR_UNCOVERED=""
if command -v python3 >/dev/null 2>&1 && [ -d "$REPO_ROOT/.github/workflows" ]; then
  # Contexts this run actually verified (pass or fail — not skip), one per line.
  # Env var, not stdin: `python3 -` reads its SCRIPT from stdin (the heredoc).
  verified_ctxs="$(printf '%s' "$RESULTS" | awk -F'\t' '$1!="skip"{print $2}')"
  pr_cov_out="$(VERIFIED_CTXS="$verified_ctxs" python3 - "$REPO_ROOT" \
      "hygiene=$th_rc" "capcounts=$cc_rc" "shellcheck=$shc_rc" "bash32=$b32_rc" \
      "tenant=$ts_rc" "coverage=$cov_rc" "toolsurface=$tsf_rc" <<'PY' || true
import glob, os, re, sys

root = sys.argv[1]
# gate rcs from the run above: rc 2 = SKIP (verified nothing), anything else ran.
gates = dict(a.split("=", 1) for a in sys.argv[2:])
gate_ran = {k: v != "2" for k, v in gates.items()}
verified_ctxs = {l.strip() for l in os.environ.get("VERIFIED_CTXS", "").splitlines() if l.strip()}

# CI job name -> the local gates that verify the same thing. Covered only if
# EVERY listed gate actually ran (a SKIPped gate verified nothing). Job names
# not in this map and not matching a verified branch-protection context land
# in NOT covered — so a future workflow is reported honestly by default.
GATE_MAP = {
    "Tracked-file hygiene": ["hygiene"],
    "Capability counts (docs vs shipped artifacts)": ["capcounts"],
    "Static lint (shellcheck + bash-3.2 arrays)": ["shellcheck", "bash32"],
    "ADR-010 §3.4 static gate (forgotten-filter regression backstop)": ["tenant"],
    # test:coverage runs the full gateway vitest suite, thresholds enforced.
    "Gateway test suite (incl. tenant-isolation regression + fuzz)": ["coverage"],
    "Coverage gate (vitest --coverage + thresholds, task-fa7872ba)": ["coverage"],
}
HINTS = {
    "Shell unit tests (scripts/tests)": "run: bash scripts/tests/run_all.sh (hermetic, ~7 min)",
    "Fleet script smoke harness": "run: bash scripts/tests/fleet_smoke.sh",
}

checks = []
paths = sorted(glob.glob(os.path.join(root, ".github", "workflows", "*.yml"))
               + glob.glob(os.path.join(root, ".github", "workflows", "*.yaml")))
for path in paths:
    try:
        src = open(path, encoding="utf-8").read()
    except Exception:
        continue
    if not re.search(r"(?m)^\s+pull_request:", src):
        continue
    jobs_m = re.search(r"(?m)^jobs:\s*$", src)
    if not jobs_m:
        continue
    body = src[jobs_m.end():]
    starts = [(m.start(), m.group(1)) for m in re.finditer(r"(?m)^  ([A-Za-z0-9_-]+):\s*$", body)]
    for i, (pos, jid) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(body)
        block = body[pos:end]
        nm = re.search(r"(?m)^    name:\s*(.+?)\s*$", block)
        name = nm.group(1).strip("\"'") if nm else jid
        # Path-filter plumbing jobs and jobs whose job-level `if:` gates them
        # off the PR event (schedule-only sweeps) are not PR merge checks.
        if re.match(r"Detect .*changes$", name):
            continue
        jif = re.search(r"(?m)^    if:\s*(.+?)\s*$", block)
        if jif and "github.event_name" in jif.group(1) and "pull_request" not in jif.group(1):
            continue
        if name not in [c for c, _ in checks]:
            checks.append((name, os.path.basename(path)))

if checks:
    covered, uncovered = [], []
    for name, wf in checks:
        need = GATE_MAP.get(name)
        if name in verified_ctxs or (need and all(gate_ran.get(g) for g in need)):
            covered.append(name)
        else:
            uncovered.append(name)
    print("── PR-check coverage (what this run did NOT verify) ──────")
    print(f"  a PR to main runs {len(checks)} check job(s) (pull_request-triggered workflows)")
    if covered:
        print(f"  verified by this run ({len(covered)}):")
        for name in covered:
            print(f"    + {name}")
    if uncovered:
        print(f"  NOT verified ({len(uncovered)}) — a green local-ci says NOTHING about these:")
        for name in uncovered:
            hint = HINTS.get(name)
            print(f"    - {name}" + (f" — {hint}" if hint else ""))
    print("──────────────────────────────────────────────────────────")
    print("@SUMMARY\t%d\t%d\t%s" % (len(covered), len(checks), "; ".join(uncovered)))
PY
)"
  if [ -n "$pr_cov_out" ]; then
    printf '%s\n' "$pr_cov_out" | grep -v '^@SUMMARY'
    summary_line="$(printf '%s\n' "$pr_cov_out" | grep '^@SUMMARY' | head -1)"
    if [ -n "$summary_line" ]; then
      PR_COV_N="$(printf '%s' "$summary_line" | awk -F'\t' '{print $2}')"
      PR_COV_TOTAL="$(printf '%s' "$summary_line" | awk -F'\t' '{print $3}')"
      PR_UNCOVERED="$(printf '%s' "$summary_line" | awk -F'\t' '{print $4}')"
    fi
  fi
fi

if [ "$overall" -eq 0 ]; then
  if [ -n "$PR_UNCOVERED" ]; then
    # Qualified verdict: green here must never read as "the PR will be green".
    echo "RESULT: all required checks satisfied — but this verified only ${PR_COV_N} of ${PR_COV_TOTAL} PR-to-main checks. NOT covered: ${PR_UNCOVERED}.$([ "$DRY_RUN" = 1 ] && echo ' (dry-run — nothing posted)')"
  else
    echo "RESULT: all required checks satisfied$([ "$DRY_RUN" = 1 ] && echo ' (dry-run — nothing posted)')."
  fi
  exit 0
fi
# Recap right above the RESULT line so a `| tail`ed run still names what
# failed. RESULTS rows are "state<TAB>context"; FAIL_RECAP holds critical-gate
# and posting failures collected via add_fail_recap.
echo "Failed (recap — full detail above):"
printf '%s' "$RESULTS" | awk -F'\t' '$1=="fail"{print "  FAIL: required check \x27" $2 "\x27"}'
if [ -n "$FAIL_RECAP" ]; then printf '%s' "$FAIL_RECAP"; fi
echo "RESULT: one or more required checks failed — PR is NOT merge-ready."
exit 1
