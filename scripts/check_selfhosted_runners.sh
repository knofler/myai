#!/bin/bash
# shellcheck disable=SC2034  # shared colour palette; not every colour is used in this script
set -uo pipefail

# ============================================================
# check_selfhosted_runners.sh — flag hosted-runner CI on non-exempt repos
# ============================================================
# CRITICAL RULE 9 / AI_RULES §21: every repo outside an exempt org
# (config/hosted_runner_orgs.txt) must run CI on the local self-hosted runner
# (`runs-on: [self-hosted, myai-local]`), never ubuntu/windows/macos hosted
# images. This scans each managed repo's .github/workflows and reports any
# non-exempt workflow still on a hosted runner.
#
# Usage:
#   ./scripts/check_selfhosted_runners.sh              # all managed repos
#   ./scripts/check_selfhosted_runners.sh /path/to/repo   # one repo
#
# Exit 0 = all clear; 1 = at least one non-exempt hosted runner found.
# Also prints this host's own runners (runner_selfhosted.sh check: one OK/WARN
# line per slot container myai-gh-runner-<repo>[-N]); CHECK_LOCAL_RUNNERS=0
# skips that informational section.
# Also sourced by scripts/health_check.sh (function check_selfhosted_runner).
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TRACKING_FILE="$REPO_DIR/config/managed_repos.txt"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/selfhosted_runner.sh"

if [ -t 1 ]; then
  GREEN='\033[38;5;208m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RED='\033[0;31m'; DIM='\033[2m'; NC='\033[0m'
else
  GREEN='' YELLOW='' CYAN='' RED='' DIM='' NC=''
fi

VIOLATIONS=0

# check_selfhosted_runner <repo_path> — print findings, bump VIOLATIONS.
# Returns non-zero if this repo has a non-exempt hosted runner.
check_selfhosted_runner() {
  local d="$1" owner found=0
  [ -d "$d" ] || return 0
  local wfdir; wfdir="$(sh_workflow_dir "$d")"
  [ -n "$wfdir" ] || return 0            # no workflows → nothing to check
  owner="$(sh_repo_owner "$d")"
  if sh_is_exempt_org "$d"; then
    echo -e "  ${DIM}∙${NC} $(basename "$d"): ${DIM}exempt org $(sh_repo_owner "$d") — hosted runners allowed${NC}"
    return 0
  fi
  local f base hits
  for f in "$wfdir"/*.yml "$wfdir"/*.yaml; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    hits="$(sh_hosted_runner_hits "$f")"
    if [ -n "$hits" ]; then
      found=1
      echo -e "  ${RED}✗${NC} $(basename "$d")/${base}: hosted runner on a non-exempt repo (owner=${owner:-<unknown>}) — must be [self-hosted, myai-local]"
      printf '%s\n' "$hits" | sed 's/^/        /'
    fi
  done
  if [ "$found" = 0 ]; then
    echo -e "  ${GREEN}✓${NC} $(basename "$d"): all workflows on self-hosted (or no hosted images)"
    return 0
  fi
  VIOLATIONS=$((VIOLATIONS + 1))
  return 1
}

# Run standalone only when executed directly (not when sourced by health_check).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  echo ""
  echo -e "${CYAN}── Self-Hosted Runner Audit (AI_RULES §21) ───────────────${NC}"
  if [ "$#" -ge 1 ] && [ -n "${1:-}" ]; then
    check_selfhosted_runner "${1/#\~/$HOME}" || true
  else
    [ -f "$TRACKING_FILE" ] || { echo -e "${RED}Error: $TRACKING_FILE missing${NC}"; exit 1; }
    # Always include the master repo itself (it is never exempt).
    check_selfhosted_runner "$REPO_DIR" || true
    while IFS= read -r raw || [ -n "$raw" ]; do
      line="${raw%%#*}"; line="$(echo "$line" | xargs)"
      [ -z "$line" ] && continue
      check_selfhosted_runner "${line/#\~/$HOME}" || true
    done < "$TRACKING_FILE"
  fi
  # This host's own runners (slots of project myai — container
  # myai-gh-runner-<repo>[-N]); informational, never changes the exit code.
  if [ -f "$SCRIPT_DIR/runner_selfhosted.sh" ] && [ "${CHECK_LOCAL_RUNNERS:-1}" = 1 ]; then
    echo ""
    echo -e "${CYAN}── This host's runners (project myai) ─────────────────────${NC}"
    bash "$SCRIPT_DIR/runner_selfhosted.sh" check 2>&1 | sed 's/^/  /'
  fi
  echo ""
  if [ "$VIOLATIONS" -eq 0 ]; then
    echo -e "${GREEN}All clear${NC} — no non-exempt repo is on a hosted runner."
    exit 0
  else
    echo -e "${RED}${VIOLATIONS} repo(s)${NC} still on hosted runners — fix with: ./scripts/rollout_selfhosted_runner.sh --apply"
    exit 1
  fi
fi
