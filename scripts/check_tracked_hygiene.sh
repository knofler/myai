#!/usr/bin/env bash
# check_tracked_hygiene.sh — tracked-file hygiene gate: machine-local
# ledgers/state must never sit in the git index.
#
# WHY (commit 4ece268 postmortem): when the local-tier run gutted .gitignore,
# state/.session-metrics, state/.token-metrics, state/.telegram-active-host,
# state/.autosave-metrics, state/.token-rolling-cache and
# state/pool-capacity.json all landed in the index and were pushed to test —
# nothing in CI or the hooks noticed. .gitignore only guards while it exists;
# this gate checks what is ACTUALLY tracked, so a gutted ignore file (or a
# `git add -f`) can no longer smuggle machine-local state into history.
#
# Denylist policy: every state/ dotfile is machine-local BY DEFAULT — a new
# intentional cross-machine sentinel must be added to ALLOW below (a visible,
# reviewed choice, the opposite of the silent default that shipped 4ece268).
# Patterns cover both the master layout (state/, config/) and the managed-repo
# layout (AI/state/, AI/config/) so the script propagates fleet-wide as-is.
#
# Run by:
#   - scripts/local-ci.sh (CRITICAL gate — fails the run regardless of contexts)
#   - .github/workflows/script-unit-tests.yml (`hygiene` job, ungated — the
#     offender class is a state/-only diff, which the CI-thrift changes filter
#     classifies as code=false and would otherwise skip)
#   - .githooks/pre-push (per pushed ref, via --ref)
#
# Usage: ./scripts/check_tracked_hygiene.sh [--repo <path>] [--ref <rev>]
#   default: scan the index (git ls-files) — catches staged offenders too
#   --ref:   scan a committed tree (git ls-tree -r <rev>) — what pre-push uses
# Exit codes: 0 pass, 1 offender tracked (BLOCKS), 2 skip (not a git repo /
# unresolvable --ref).

set -euo pipefail

REPO_ROOT="" REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_ROOT="$2"; shift 2 ;;
    --ref)  REF="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

echo "[Tracked Hygiene] no machine-local ledgers/state in the git index"
if ! git -C "$REPO_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "  SKIP — $REPO_ROOT is not a git repo"; exit 2
fi

# ── Denylist (ERE, one per line) ─────────────────────────────────────────────
DENY=(
  # every state/ dotfile: session/token/autosave metrics, rolling caches,
  # telegram host marker, .yolo, mongo primary/sync markers, repo index, …
  '^(AI/)?state/\.[^/]+$'
  # per-machine account-pool capacity snapshot (pool_capacity_snapshot.sh)
  '^(AI/)?state/pool-capacity\.json$'
  # runner ledgers: host-side health snapshot + backlog cursor / planner stamp
  '^(AI/)?state/runner-health\.json$'
  '^(AI/)?config/\.runner_[^/]+$'
  # host-side mongo-mirror schedule snapshot (scripts/mongo_mirror_status_snapshot.sh)
  '^(AI/)?state/mongo-mirror-status\.json$'
  # machine-local supply-chain scan report (scripts/dependency_scan.sh)
  '^(AI/)?state/dependency-scan-report\.json$'
  # env files — real secrets, never tracked (.example templates exempt below)
  '(^|/)\.env[^/]*$'
  '(^|/)[^/]+\.env$'
)

# ── Allowlist (ERE) — deliberate, reviewed exceptions only ───────────────────
# .schedule-ingested: cross-machine schedule-ingest dedup sentinel, committed
# on purpose so other Macs skip re-registering the same plan (push_schedule.sh).
ALLOW='(\.example$|^(AI/)?state/\.schedule-ingested$)'

if [ -n "$REF" ]; then
  files="$(git -C "$REPO_ROOT" ls-tree -r --name-only "$REF" 2>/dev/null)" \
    || { echo "  SKIP — cannot resolve ref '$REF'"; exit 2; }
  scope="tree @ $REF"
else
  files="$(git -C "$REPO_ROOT" ls-files)"
  scope="index"
fi

offenders=""
for pat in "${DENY[@]}"; do
  hits="$(printf '%s\n' "$files" | grep -E "$pat" || true)"
  [ -n "$hits" ] && offenders="${offenders}${hits}"$'\n'
done
offenders="$(printf '%s' "$offenders" | sort -u | grep -Ev "$ALLOW" || true)"

if [ -n "$offenders" ]; then
  echo "  FAIL — machine-local file(s) tracked ($scope):"
  printf '%s\n' "$offenders" | sed 's/^/    ✗ /'
  echo "  FIX — untrack (keeps the file on disk) and re-ignore:"
  echo "        git rm --cached <file>   # then ensure .gitignore covers it"
  echo "        NB: commit WITHOUT a pathspec — a path-scoped commit takes"
  echo "        working-tree content and resurrects the file (see 150d2cb)."
  echo "        A deliberate cross-machine sentinel goes in ALLOW in this script."
  exit 1
fi
echo "  PASS — no machine-local ledgers/state tracked ($scope)"

# ── roster portability ────────────────────────────────────────────────────────
# The fleet roster is eval-expanded (`eval echo "$line"` in
# restore_git_metadata.sh / deploy_status.sh), so `~/` and `$HOME` resolve per
# machine. An ABSOLUTE /Users/<someone>/ path does not: it silently points at
# one Mac's home and reads as "no such dir" on every other machine.
#
# This is not hypothetical. A repo once sat in the roster as an absolute
# /Users/<user-a>/... path — correct on the Mac whose home dir that was, dead on
# another Mac whose home dir is /Users/<user-b>. The repo was present and
# healthy the whole time; the fleet just could not see it. One character of
# divergence between two machines' usernames cost a repo its fleet coverage.
ROSTER="$REPO_ROOT/config/managed_repos.txt"
if [ -f "$ROSTER" ]; then
  abs="$(grep -nE '^[^#]*/Users/' "$ROSTER" || true)"
  if [ -n "$abs" ]; then
    echo "  FAIL — machine-specific absolute path(s) in config/managed_repos.txt:"
    printf '%s\n' "$abs" | sed 's/^/    ✗ /'
    echo "  FIX — use a portable prefix so BOTH Macs resolve it:"
    echo "        <dropbox-root>/...   (a relative path, never an absolute home path)"
    exit 1
  fi
  echo "  PASS — fleet roster paths are machine-portable"
fi

exit 0
