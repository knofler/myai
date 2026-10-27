#!/bin/bash
set -uo pipefail

# ============================================================
# Self-Hosted Runner Rollout — fleet-wide hosted-minutes killer
# ============================================================
# Enforces CLAUDE.md CRITICAL RULE 9 / AI_RULES §21 across every managed repo:
#   - rewrite `runs-on: ubuntu-latest` → `runs-on: [self-hosted, myai-local]`
#     (ubuntu is Linux, so it moves safely onto the Linux/ARM64 self-hosted runner)
#   - strip `push:` triggers (CI runs at PR time only — see rule 8 CI Thrift)
#   - FLAG (never silently rewrite) `windows-*`/`macos-*`/matrix runners — those
#     cannot run on the Linux self-hosted runner and need a human decision.
#
# EXEMPTION: repos owned by an org in config/hosted_runner_orgs.txt keep hosted
# runners (that org's hosted minutes are paid for). They are detected from `origin` and
# skipped. A repo whose owner can't be resolved is treated as NON-exempt.
#
# Usage:
#   ./scripts/rollout_selfhosted_runner.sh                 # dry-run (default)
#   ./scripts/rollout_selfhosted_runner.sh --apply         # edit working trees
#   ./scripts/rollout_selfhosted_runner.sh --apply --commit  # also commit per repo
#   ./scripts/rollout_selfhosted_runner.sh /path/to/repo --apply   # single repo
#
# Idempotent: already-compliant workflows are skipped. Never commits to main,
# never pushes — review + ship per repo flow.
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TRACKING_FILE="$REPO_DIR/config/managed_repos.txt"
REWRITE_PY="$SCRIPT_DIR/lib/selfhosted_rewrite.py"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/selfhosted_runner.sh"

APPLY=false
COMMIT=false
SINGLE_REPO=""

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)  APPLY=true; shift ;;
    --commit) COMMIT=true; shift ;;
    -*)       echo "Unknown option: $1"; exit 1 ;;
    *)        SINGLE_REPO="$1"; shift ;;
  esac
done

if [ -t 1 ]; then
  GREEN='\033[38;5;208m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; RED='\033[0;31m'; NC='\033[0m'
else
  GREEN='' YELLOW='' CYAN='' DIM='' RED='' NC=''
fi

MODE_LABEL="DRY RUN (no changes)"
[ "$APPLY" = true ] && MODE_LABEL="APPLY (edit working tree)"
[ "$APPLY" = true ] && [ "$COMMIT" = true ] && MODE_LABEL="APPLY + COMMIT"

echo ""
echo -e "${CYAN}── Self-Hosted Runner Rollout ────────────────────────────${NC}"
echo -e "  mode: ${YELLOW}${MODE_LABEL}${NC}   exempt org(s): ${DIM}${SELFHOSTED_EXEMPT_ORG:-none}${NC}"
echo ""

process_repo() {
  local d="$1"
  [ -d "$d" ] || { echo -e "  ${YELLOW}skip${NC} (missing): $d"; return; }
  local owner; owner="$(sh_repo_owner "$d")"
  echo -e "  ${CYAN}▸${NC} $(basename "$d")  ${DIM}owner=${owner:-<unknown>}${NC}"

  if sh_is_exempt_org "$d"; then
    echo -e "    ${DIM}exempt${NC} — exempt org $(sh_repo_owner "$d"), hosted runners allowed — skip"
    return
  fi

  local wfdir; wfdir="$(sh_workflow_dir "$d")"
  [ -n "$wfdir" ] || { echo -e "    ${DIM}no .github/workflows${NC} — skip"; return; }

  local f base out rc any_change=0
  for f in "$wfdir"/*.yml "$wfdir"/*.yaml; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    if [ "$APPLY" = true ]; then
      out="$(python3 "$REWRITE_PY" "$f" --apply 2>/dev/null)"; rc=$?
    else
      out="$(python3 "$REWRITE_PY" "$f" 2>/dev/null)"; rc=$?
    fi
    [ "$rc" -eq 0 ] || { echo -e "    ${RED}${base}${NC}: rewrite error (rc=$rc)"; continue; }
    local n_runson n_push n_warn
    n_runson="$(printf '%s\n' "$out" | grep -c '^RUNSON ' || true)"
    n_push="$(printf '%s\n' "$out" | grep -c '^PUSH ' || true)"
    n_warn="$(printf '%s\n' "$out" | grep -c '^WARN-HOSTED ' || true)"
    if [ "$n_runson" = 0 ] && [ "$n_push" = 0 ] && [ "$n_warn" = 0 ]; then
      echo -e "    ${DIM}${base}${NC}: compliant — skip"
      continue
    fi
    [ "$n_runson" != 0 ] || [ "$n_push" != 0 ] && any_change=1
    local verb="would"; [ "$APPLY" = true ] && verb="did"
    [ "$n_runson" != 0 ] && echo -e "    ${GREEN}${base}${NC}: ${verb} rewrite ${n_runson} ubuntu runs-on → ${SELFHOSTED_RUNS_ON}"
    [ "$n_push" != 0 ] && echo -e "    ${GREEN}${base}${NC}: ${verb} strip ${n_push} push: trigger(s)"
    if [ "$n_warn" != 0 ]; then
      printf '%s\n' "$out" | grep '^WARN-HOSTED ' | while IFS= read -r w; do
        echo -e "    ${YELLOW}${base}${NC}: HOSTED runner needs manual decision (can't run on Linux self-hosted): ${w#WARN-HOSTED }"
      done
    fi
  done

  if [ "$APPLY" = true ] && [ "$COMMIT" = true ] && [ "$any_change" = 1 ] && [ -e "$d/.git" ]; then
    ( cd "$d" || exit 1
      git add -A .github/workflows 2>/dev/null || true
      git diff --cached --quiet || git commit -q -m "ci: self-hosted runners only — ubuntu→[self-hosted, myai-local] + strip push triggers (AI_RULES §21)" )
    echo -e "    ${GREEN}committed${NC} to $(cd "$d" && git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  fi
}

if [ -n "$SINGLE_REPO" ]; then
  SINGLE_REPO="${SINGLE_REPO/#\~/$HOME}"
  process_repo "$SINGLE_REPO"
else
  [ -f "$TRACKING_FILE" ] || { echo -e "${RED}Error: $TRACKING_FILE missing${NC}"; exit 1; }
  while IFS= read -r raw || [ -n "$raw" ]; do
    if echo "$raw" | grep -qiE 'NEVER write outside|AI folder only|NEVER push'; then
      path="$(echo "${raw%%#*}" | xargs)"
      echo -e "  ${YELLOW}skip${NC} (protected — AI-folder-only / no-push): $(basename "${path:-?}")"
      continue
    fi
    line="${raw%%#*}"; line="$(echo "$line" | xargs)"
    [ -z "$line" ] && continue
    process_repo "${line/#\~/$HOME}"
  done < "$TRACKING_FILE"
fi

echo ""
if [ "$APPLY" = false ]; then
  echo -e "${YELLOW}Dry run complete.${NC} Re-run with --apply to edit, --apply --commit to commit."
else
  echo -e "${GREEN}Applied.${NC} Review diffs, then ship per repo (commit to test → PR to main)."
  echo -e "  ${DIM}Register each non-exempt repo's runner: scripts/runner_selfhosted.sh up <owner/repo>${NC}"
fi
echo ""
