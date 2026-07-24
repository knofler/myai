#!/usr/bin/env bash
# ============================================================
# pr_guard.sh — enforce AI_RULES §17.1: NEVER a PR per docs/AI change.
# ============================================================
# Actions credit is scarce (§17). Every PR-to-main triggers the check + review
# workflows once; a PR-per-tiny-doc/hook-change multiplies that burn. This guard
# REFUSES (exit 2) to open a PR whose entire diff vs the base is docs/AI/hook/
# config/state-only — such changes must BATCH on `test` and ride the next PR that
# carries genuine app/runtime code.
#
# Path logic mirrors scripts/lib/ci_paths_gate.py (the §16 changes-detector) plus
# §17's hook/config set. The "non-code" set (a push touching ONLY these = no
# genuine code to gate):
#     AI/  docs/  state/  logs/  .claude/  hooks/  config/  *.md
# A push that also touches anything else (src/, app/, scripts/, runtime/,
# .github/workflows, vercel.json, package.json, …) is "genuine" and allowed.
#
# Usage (call from `ship it` / any PR-creation flow BEFORE `gh pr create`):
#   scripts/pr_guard.sh                 # check HEAD vs origin/main
#   scripts/pr_guard.sh <base-ref>      # check HEAD vs <base-ref>
#   scripts/pr_guard.sh <base> <head>   # explicit range
#   PR_GUARD_FORCE=1 scripts/pr_guard.sh   # override (allow the PR anyway)
#   PR_GUARD_WARN=1  scripts/pr_guard.sh   # warn-only (exit 0, never blocks)
#
# Exit codes: 0 = OK to open a PR (has code, or forced/warn), 2 = REFUSE
# (docs/AI/hook/config-only), 3 = could not determine range (fail open, exit 0).
# ============================================================
set -uo pipefail

BASE="${1:-origin/main}"
HEAD_REF="${2:-HEAD}"

# The §16+§17 non-code pathspec — a push touching ONLY these needs no PR of its own.
EXCLUDES=(
  ':(exclude)AI' ':(exclude)docs' ':(exclude)state' ':(exclude)logs'
  ':(exclude).claude' ':(exclude)hooks' ':(exclude)config' ':(exclude)*.md'
)

if [ -t 1 ]; then
  RED='\033[1;31m'; YELLOW='\033[1;33m'; GREEN='\033[38;5;208m'; DIM='\033[2m'; NC='\033[0m'
else
  RED='' YELLOW='' GREEN='' DIM='' NC=''
fi

# Resolve a merge-base so we compare only what THIS branch adds over the base.
base_sha="$(git merge-base "$BASE" "$HEAD_REF" 2>/dev/null || git rev-parse --verify "$BASE" 2>/dev/null || echo '')"
if [ -z "$base_sha" ]; then
  echo -e "${DIM}[pr-guard] cannot resolve base '$BASE' — failing open (allow).${NC}" >&2
  exit 3
fi

# Does the diff touch anything OUTSIDE the non-code set?
if git diff --quiet "$base_sha" "$HEAD_REF" -- "${EXCLUDES[@]}" 2>/dev/null; then
  # No genuine code changed — docs/AI/hook/config/state-only.
  changed="$(git diff --name-only "$base_sha" "$HEAD_REF" 2>/dev/null | sed 's/^/    /')"
  if [ "${PR_GUARD_FORCE:-0}" = "1" ]; then
    echo -e "${YELLOW}[pr-guard] docs/AI/hook/config-only diff — PR_GUARD_FORCE=1, allowing.${NC}" >&2
    exit 0
  fi
  if [ "${PR_GUARD_WARN:-0}" = "1" ]; then
    echo -e "${YELLOW}[pr-guard] WARN: docs/AI/hook/config-only diff — batch on test (§17.1).${NC}" >&2
    exit 0
  fi
  echo -e "${RED}[pr-guard] REFUSED — this branch's diff vs ${BASE} is docs/AI/hook/config-only:${NC}" >&2
  echo -e "${DIM}${changed}${NC}" >&2
  echo "" >&2
  echo -e "  AI_RULES §17.1: NEVER open a PR per docs/AI/hook change — every PR-to-main" >&2
  echo -e "  burns Actions credit (check + review workflows). BATCH these commits on" >&2
  echo -e "  ${GREEN}test${NC} and fold them into the next PR that carries genuine app/runtime code." >&2
  echo -e "  (Pushing to ${GREEN}test${NC} triggers ZERO Actions — CI is PR-to-main only.)" >&2
  echo "" >&2
  echo -e "  ${DIM}Override (rare — e.g. a standalone CI/infra fix that must land now):${NC}" >&2
  echo -e "  ${DIM}  PR_GUARD_FORCE=1 <your PR command>${NC}" >&2
  exit 2
fi

echo -e "${GREEN}[pr-guard] OK${NC} — diff carries genuine code; a PR is warranted." >&2
exit 0
