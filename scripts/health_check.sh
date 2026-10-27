#!/bin/bash

# AI Management Framework - Health Check
# Usage: ./scripts/health_check.sh [target_directory]
# If no target, checks all managed repos from config/managed_repos.txt

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Old usernames that must not linger in a repo (e.g. after an account rename):
# $HEALTH_STALE_USERNAMES (space-separated), else config/stale_usernames.txt
# (local, one per line, # comments). Neither → the stale-username check is skipped.
STALE_USERNAMES="${HEALTH_STALE_USERNAMES-}"
if [ -z "$STALE_USERNAMES" ] && [ -f "$SCRIPT_DIR/../config/stale_usernames.txt" ]; then
    STALE_USERNAMES="$(grep -vE '^[[:space:]]*(#|$)' "$SCRIPT_DIR/../config/stale_usernames.txt" | tr '\n' ' ')"
fi
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# ADR-021 Phase 3: roster via the shared resolver (gateway DB roster preferred,
# managed_repos.txt bootstrap-seed fallback). TRACKING_FILE kept only as the
# seed-file pointer for the no-resolver error message.
. "$SCRIPT_DIR/lib/repo_paths.sh" 2>/dev/null || true
# AI_RULES §11a — vercel.json must live in the Vercel project's Root Directory.
. "$SCRIPT_DIR/lib/vercel_root.sh" 2>/dev/null || true
# AI_RULES §21 — self-hosted runners only (outside exempt orgs).
. "$SCRIPT_DIR/lib/selfhosted_runner.sh" 2>/dev/null || true
TRACKING_FILE="$REPO_DIR/config/managed_repos.txt"

# Colors
RED='\033[0;31m'
GREEN='\033[38;5;208m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

PASS=0
WARN=0
FAIL=0
TOTAL_REPOS=0
REPOS_HEALTHY=0

# The 13 required specialist agents
AGENTS=(
    "solution-architect"
    "frontend-specialist"
    "api-specialist"
    "database-specialist"
    "devops-specialist"
    "ui-ux-specialist"
    "security-specialist"
    "documentation-specialist"
    "product-manager"
    "qa-specialist"
    "tech-ba"
    "tech-lead"
    "project-manager"
)

# Required documentation files (relative to AI/)
REQUIRED_DOCS=(
    "documentation/AI_RULES.md"
    "documentation/Instruction.md"
    "CLAUDE.md"
    "documentation/INTEGRATION_GUIDE.md"
    "documentation/MULTI_AGENT_ROUTING.md"
)

# Required directories (relative to AI/)
REQUIRED_DIRS=(
    ".claude/agents"
    ".claude/skills"
    "agents"
    "skills"
    "documentation"
    "architecture"
    "design"
    "plan"
    "state"
    "logs"
)

pass() {
    echo -e "  ${GREEN}✓${NC} $1"
    ((PASS++))
}

warn() {
    echo -e "  ${YELLOW}⚠${NC} $1"
    ((WARN++))
}

fail() {
    echo -e "  ${RED}✗${NC} $1"
    ((FAIL++))
}

check_org_health() {
    # Multi-Org Auth health check (Phase 6)
    # Non-fatal: warnings only for missing dirs/auth — org setup is optional
    # Fails only on inconsistent state (dirs exist but hook missing)

    echo ""
    echo -e "${CYAN}━━━ Multi-Org Auth ━━━${NC}"

    # The org profiles are whatever ~/.claude-<x> dirs this Mac has (v1 G6:
    # names are user data, never a list in code).
    local org_dirs="" d
    for d in "$HOME"/.claude-*; do [ -d "$d" ] && org_dirs="$org_dirs ${d##*/.claude-}"; done
    org_dirs="${org_dirs# }"
    local dir_count=0
    local auth_count=0
    local has_any_dir=0

    # 1. Check each expected config dir exists + is authenticated
    [ -n "$org_dirs" ] || warn "no ~/.claude-<org> profile dirs (org setup optional)"
    for org in $org_dirs; do
        local dir_path="$HOME/.claude-${org}"
        if [ -d "$dir_path" ]; then
            ((dir_count++))
            has_any_dir=1
            # Check for .claude.json with oauthAccount (credential indicator on macOS)
            if [ -f "$dir_path/.claude.json" ] && grep -q "oauthAccount" "$dir_path/.claude.json" 2>/dev/null; then
                ((auth_count++))
                pass "~/.claude-${org} exists + authenticated"
            else
                warn "~/.claude-${org} exists but not authenticated (no oauthAccount in .claude.json)"
            fi
        else
            warn "~/.claude-${org} not found (org setup optional)"
        fi
    done

    # 2. Check repo_org_map.txt exists and has actual mappings
    local map_file="$REPO_DIR/config/repo_org_map.txt"
    local map_entries=0
    if [ -f "$map_file" ]; then
        # Count non-comment, non-empty lines
        map_entries=$(grep -vcE '^\s*#|^\s*$' "$map_file" 2>/dev/null || echo 0)
        if [ "$map_entries" -gt 0 ]; then
            pass "config/repo_org_map.txt exists ($map_entries entries)"
        else
            warn "config/repo_org_map.txt exists but has no repo mappings"
        fi
    else
        warn "config/repo_org_map.txt not found (needed for org-per-repo routing)"
    fi

    # 3. Check org-context session hook exists
    local hook_path="$REPO_DIR/hooks/session/16-org-context.sh"
    if [ -f "$hook_path" ]; then
        pass "hooks/session/16-org-context.sh exists"
    else
        if [ "$has_any_dir" -eq 1 ]; then
            # Inconsistent state: dirs exist but hook is missing
            fail "hooks/session/16-org-context.sh missing but org config dirs exist (inconsistent state)"
        else
            warn "hooks/session/16-org-context.sh not found (org setup not started)"
        fi
    fi

    # 4. Check setup scripts exist
    for script in setup_org_dirs.sh setup_org_envrc.sh; do
        if [ -f "$REPO_DIR/scripts/$script" ]; then
            pass "scripts/$script exists"
        else
            warn "scripts/$script not found"
        fi
    done

    # 5. Summary line
    echo -e "  ${CYAN}Multi-Org: ${dir_count}/3 dirs, ${auth_count}/3 authenticated, org map: ${map_entries} entries${NC}"
}

check_vercel_root_placement() {
    # AI_RULES §11a — vercel.json must live in the Vercel project's Root Directory.
    # Vercel reads vercel.json ONLY from the Root Directory, so a monorepo whose
    # Root Directory is apps/web but whose vercel.json sits at the repo root has
    # its deploy-gate AND its crons SILENTLY IGNORED in production (incident foh
    # 2026-10-01: /api/warm cron showed "not deployed", zero calls in 24h). This
    # audits placement against the resolved Root Directory and (opt-in) confirms
    # crons are actually deployed. Returns non-zero on a confirmed misplacement.
    # $1 = repo root.
    local d="$1"
    # Only audit repos tied to Vercel: a .vercel link OR a vercel.json somewhere.
    # No signal → nothing to audit (skip silently so non-web repos stay clean).
    local linked=0; vercel_is_linked "$d" 2>/dev/null && linked=1
    local root_vj=0; [ -f "$d/vercel.json" ] && root_vj=1
    [ "$linked" = 0 ] && [ "$root_vj" = 0 ] && return 0

    local rootsub=""
    declare -F vercel_root_dir >/dev/null 2>&1 && rootsub="$(vercel_root_dir "$d" 2>/dev/null)"

    local placement_fail=0
    if [ -z "$rootsub" ]; then
        # Root Directory is the repo root (or unresolved) → gate belongs at root.
        if [ "$root_vj" = 1 ]; then
            pass "vercel.json at repo root (Vercel Root Directory = repo root)"
        else
            warn "Vercel-linked but no vercel.json at repo root — deploy-gate/crons may be ungated"
        fi
    else
        # Root Directory is a subdir → vercel.json MUST live there.
        if [ -f "$d/$rootsub/vercel.json" ]; then
            pass "vercel.json in Vercel Root Directory ($rootsub/)"
            [ "$root_vj" = 1 ] && warn "stray vercel.json ALSO at repo root — Vercel ignores it; $rootsub/vercel.json is authoritative"
        elif [ "$root_vj" = 1 ]; then
            fail "vercel.json MISPLACED — at repo root but Vercel Root Directory is $rootsub/ → deploy-gate + crons SILENTLY IGNORED in prod (AI_RULES §11a). Fix: git mv vercel.json $rootsub/vercel.json  (or ./scripts/rollout_ci_thrift.sh --apply)"
            placement_fail=1
        else
            warn "Vercel Root Directory is $rootsub/ but no vercel.json there — deploy-gate/crons ungated"
        fi
    fi

    # Vercel's schema caps ignoreCommand at 256 chars; a longer one ERRORs every
    # deployment before the build (connect-hub prod, 2026-09-10 → 2026-10-21,
    # the 334-char v2 gate from templates/vercel.json). Checked wherever a
    # vercel.json sits — a stray root copy may be the one someone moves later.
    local vj iclen
    for vj in "$d/vercel.json" ${rootsub:+"$d/$rootsub/vercel.json"}; do
        [ -f "$vj" ] || continue
        iclen="$(jq -r '.ignoreCommand // "" | length' "$vj" 2>/dev/null)" || continue
        if [ "${iclen:-0}" -gt 256 ]; then
            fail "${vj#"$d"/}: ignoreCommand is $iclen chars (Vercel max 256) → EVERY deployment fails before build. Fix: ./scripts/rollout_ci_thrift.sh --apply (replaces our old gate) or shorten it by hand"
            placement_fail=1
        fi
    done

    # Opt-in (network + auth): confirm crons actually deployed after a prod deploy.
    # OFF by default so the fleet sweep stays fast and offline; set HEALTH_VERCEL_CRONS=1.
    if [ "${HEALTH_VERCEL_CRONS:-0}" = 1 ] && [ "$linked" = 1 ] && command -v vercel >/dev/null 2>&1; then
        local crons
        crons="$(cd "$d" && _vercel_timeout 15 vercel crons list 2>/dev/null)" || crons=""
        if printf '%s' "$crons" | grep -qiE 'not deployed'; then
            fail "vercel crons list shows 'not deployed' after a prod deploy — a cron is defined but not live (often a misplaced/ignored vercel.json). Verify: vercel crons list"
            placement_fail=1
        elif [ -n "$crons" ]; then
            pass "vercel crons list: all crons deployed"
        fi
    fi
    return $placement_fail
}

check_master() {
    local repo_path="$1"
    local repo_fail=0

    echo ""
    echo -e "${CYAN}━━━ Checking master repo: ${repo_path} ━━━${NC}"

    # Check agents at root .claude/agents/
    local agent_count=0
    for agent in "${AGENTS[@]}"; do
        [ -f "$repo_path/.claude/agents/${agent}.md" ] && ((agent_count++))
    done
    if [ $agent_count -eq 13 ]; then
        pass "All 13 agents in .claude/agents/"
    else
        fail "Missing agents in .claude/agents/ ($agent_count/13)"
        ((repo_fail++))
    fi

    # Check agent mirrors
    local mirror_count=0
    for agent in "${AGENTS[@]}"; do
        [ -f "$repo_path/agents/${agent}.md" ] && ((mirror_count++)) || true
    done
    if [ $mirror_count -eq 13 ]; then
        pass "All 13 mirrors in agents/"
    else
        warn "Only $mirror_count/13 mirrors in agents/"
    fi

    # Check skills directory and count
    if [ -d "$repo_path/skills" ]; then
        local skill_count
        skill_count=$(find "$repo_path/skills" -name "SKILL.md" -maxdepth 2 | wc -l | tr -d ' ')
        if [ "$skill_count" -ge 59 ]; then
            pass "All 59 skills in skills/ ($skill_count found)"
        else
            warn "Only $skill_count/59 skills in skills/"
        fi
    else
        fail "skills/ directory missing"
        ((repo_fail++))
    fi

    # Check .claude/skills symlink
    if [ -L "$repo_path/.claude/skills" ] || [ -d "$repo_path/.claude/skills" ]; then
        pass ".claude/skills exists"
    else
        fail ".claude/skills symlink missing"
        ((repo_fail++))
    fi

    # Check key files at root and in subdirectories
    for f in CLAUDE.md; do
        if [ -f "$repo_path/$f" ]; then
            pass "$f exists"
        else
            fail "$f missing"
            ((repo_fail++))
        fi
    done
    if [ -f "$repo_path/templates/CLAUDE_TEMPLATE.md" ]; then
        pass "templates/CLAUDE_TEMPLATE.md exists"
    else
        fail "templates/CLAUDE_TEMPLATE.md missing"
        ((repo_fail++))
    fi
    for f in documentation/AI_RULES.md documentation/Instruction.md state/STATE.md state/AI_AGENT_HANDOFF.md; do
        if [ -f "$repo_path/$f" ]; then
            pass "$f exists"
        else
            fail "$f missing"
            ((repo_fail++))
        fi
    done

    # Check documentation
    for f in documentation/INTEGRATION_GUIDE.md documentation/MULTI_AGENT_ROUTING.md; do
        if [ -f "$repo_path/$f" ]; then
            pass "$f exists"
        else
            fail "$f missing"
            ((repo_fail++))
        fi
    done

    # Check dirs
    for d in architecture design plan documentation agents state logs scripts templates; do
        if [ -d "$repo_path/$d" ]; then
            pass "$d/ exists"
        else
            fail "$d/ missing"
            ((repo_fail++))
        fi
    done

    # Check scripts
    for f in init_ai.sh update_all.sh health_check.sh; do
        if [ -f "$repo_path/scripts/$f" ]; then
            pass "scripts/$f exists"
        else
            fail "scripts/$f missing"
            ((repo_fail++))
        fi
    done
    # ADR-021 Phase 3: the txt is an optional bootstrap seed (DB roster is the
    # authority), so a missing file is informational — not a health failure.
    if [ -f "$repo_path/config/managed_repos.txt" ]; then
        pass "config/managed_repos.txt exists (bootstrap seed)"
    else
        warn "config/managed_repos.txt missing (optional seed — DB roster is authority, ADR-021)"
    fi

    # Check git
    if [ -d "$repo_path/.git" ]; then
        pass "Git repository initialized"
    else
        warn "Not a git repository"
    fi

    # Stale refs
    local stale_refs="" _u
    for _u in $STALE_USERNAMES; do
        stale_refs+=$(grep -rl "$_u" "$repo_path/" --include="*.md" 2>/dev/null | xargs grep -l "[^\`]${_u}[^'\`]" 2>/dev/null | head -5)
    done
    if [ -z "$STALE_USERNAMES" ]; then
        :
    elif [ -n "$stale_refs" ]; then
        warn "Stale username found: $stale_refs"
    else
        pass "No stale username references"
    fi

    # AI_RULES §11a — vercel.json in the Vercel project's Root Directory
    check_vercel_root_placement "$repo_path" || ((repo_fail++))

    return $repo_fail
}

# Kernel-only (greenfield `myai init`) repo — ADR-016 §0.2 / S-INIT-6.
# A kernel-only repo carries ONLY a ~30-line kernel CLAUDE.md + gitignored
# .myai-local; the framework (agents/skills/hooks/rules) resolves from the
# installed ai-management module at runtime. A missing AI/ folder is
# therefore CORRECT, not a failure. Compliance = the myai-init guardrails hold.
check_kernel_repo() {
    local repo_path="$1"

    pass "Kernel-only repo (greenfield 'myai init') — framework resolves from installed module; no AI/ folder expected"

    # Delegate the guardrail asserts to lint_myai_init.sh (single source of truth):
    #   .myai-local gitignored + not tracked, kernel + pointer secret-free.
    local lint="$SCRIPT_DIR/lint_myai_init.sh"
    if [ -f "$lint" ]; then
        local out rc
        out=$(bash "$lint" "$repo_path" 2>/dev/null); rc=$?
        if [ "$rc" -eq 0 ]; then
            pass "myai-init guardrails GREEN (.myai-local gitignored + kernel secret-free)"
        else
            fail "myai-init guardrails: $(echo "$out" | grep '✗' | sed 's/^  ✗ //' | paste -sd'; ' -)"
            return 1
        fi
    else
        warn "lint_myai_init.sh not found — skipped kernel guardrail asserts"
    fi

    # Safety-hook wiring (S-INIT-5): PreToolUse rails must resolve from the module.
    if [ -f "$repo_path/.claude/settings.json" ] && grep -q 'myAI kernel settings' "$repo_path/.claude/settings.json" 2>/dev/null; then
        pass ".claude/settings.json module safety wiring present (push-main / secret / protected-files hooks)"
    else
        warn ".claude/settings.json module safety wiring not found — verify safety hooks fire from the module"
    fi

    if [ -d "$repo_path/.git" ]; then
        pass "Git repository initialized"
    else
        warn "Not a git repository"
    fi

    return 0
}

check_repo() {
    local repo_path="$1"
    local repo_fail=0

    echo ""
    echo -e "${CYAN}━━━ Checking: ${repo_path} ━━━${NC}"

    # 1. Check AI/ directory exists — OR recognize a kernel-only (greenfield
    #    `myai init`) repo as compliant. If there is no AI/ but the root
    #    CLAUDE.md is a genuine myAI kernel, this is a greenfield repo (ADR-016
    #    §0.2), not a broken one — hand off to check_kernel_repo.
    if [ ! -d "$repo_path/AI" ]; then
        if [ -f "$repo_path/CLAUDE.md" ] && head -n 3 "$repo_path/CLAUDE.md" 2>/dev/null | grep -qE '^#[[:space:]]+myAI kernel'; then
            check_kernel_repo "$repo_path"
            return $?
        fi
        fail "AI/ directory missing — run 'myai init' (kernel-only) or init_ai.sh (managed) on this project"
        return 1
    fi
    pass "AI/ directory exists"

    # 2. Check required subdirectories
    for dir in "${REQUIRED_DIRS[@]}"; do
        if [ -d "$repo_path/AI/$dir" ]; then
            pass "AI/$dir/ exists"
        else
            fail "AI/$dir/ missing"
            ((repo_fail++))
        fi
    done

    # 3. Check all 13 agent definitions (.claude/agents/)
    local agent_count=0
    local missing_agents=()
    for agent in "${AGENTS[@]}"; do
        if [ -f "$repo_path/AI/.claude/agents/${agent}.md" ]; then
            ((agent_count++))
        else
            missing_agents+=("$agent")
        fi
    done

    if [ $agent_count -eq 13 ]; then
        pass "All 13 specialist agents present in AI/.claude/agents/"
    else
        fail "Missing ${#missing_agents[@]} agents in AI/.claude/agents/: ${missing_agents[*]}"
        ((repo_fail++))
    fi

    # 4. Check agent-agnostic mirrors (AI/agents/)
    local mirror_count=0
    for agent in "${AGENTS[@]}"; do
        if [ -f "$repo_path/AI/agents/${agent}.md" ]; then
            ((mirror_count++))
        fi
    done

    if [ $mirror_count -eq 13 ]; then
        pass "All 13 agent mirrors present in AI/agents/"
    else
        warn "Only $mirror_count/13 agent mirrors in AI/agents/ (Gemini/Copilot may lack definitions)"
    fi

    # 4b. Check skills
    if [ -d "$repo_path/AI/skills" ]; then
        local skill_count
        skill_count=$(find "$repo_path/AI/skills" -name "SKILL.md" -maxdepth 2 | wc -l | tr -d ' ')
        if [ "$skill_count" -ge 59 ]; then
            pass "All 59 skills present in AI/skills/ ($skill_count found)"
        else
            warn "Only $skill_count/59 skills in AI/skills/"
        fi
    else
        fail "AI/skills/ directory missing"
        ((repo_fail++))
    fi

    # 5. Check required documentation files
    for doc in "${REQUIRED_DOCS[@]}"; do
        if [ -f "$repo_path/AI/$doc" ]; then
            pass "AI/$doc exists"
        else
            fail "AI/$doc missing"
            ((repo_fail++))
        fi
    done

    # 6. Check root CLAUDE.md (Claude Code reads this on startup)
    if [ -f "$repo_path/CLAUDE.md" ]; then
        pass "CLAUDE.md at project root"
    else
        fail "CLAUDE.md missing at project root — Claude Code won't auto-route"
        ((repo_fail++))
    fi

    # 7. Check STATE.md exists (required for mobile Claude sessions)
    if [ -f "$repo_path/AI/state/STATE.md" ]; then
        pass "AI/state/STATE.md exists"
    else
        fail "AI/state/STATE.md missing — mobile Claude cannot manage this repo"
        ((repo_fail++))
    fi

    # 8. Check AI_AGENT_HANDOFF.md exists
    if [ -f "$repo_path/AI/state/AI_AGENT_HANDOFF.md" ]; then
        pass "AI/state/AI_AGENT_HANDOFF.md exists"
    else
        fail "AI/state/AI_AGENT_HANDOFF.md missing — agent handoff broken"
        ((repo_fail++))
    fi

    # 8b. Check claude_log.md exists
    if [ -f "$repo_path/AI/logs/claude_log.md" ]; then
        pass "AI/logs/claude_log.md exists"
    else
        fail "AI/logs/claude_log.md missing — session logging broken"
        ((repo_fail++))
    fi

    # 9. Check for stale username references (config: STALE_USERNAMES above)
    local stale_refs="" _u
    for _u in $STALE_USERNAMES; do
        stale_refs+=$(grep -rl "$_u" "$repo_path/AI/" 2>/dev/null | head -5)
    done
    if [ -z "$STALE_USERNAMES" ]; then
        :
    elif [ -n "$stale_refs" ]; then
        warn "Stale username found in: $stale_refs"
    else
        pass "No stale username references"
    fi

    # 10. Check git repo
    if [ -d "$repo_path/.git" ]; then
        pass "Git repository initialized"
    else
        warn "Not a git repository"
    fi

    # 11. Check Docker files
    if [ -f "$repo_path/.gitignore" ]; then
        pass ".gitignore present"
    else
        warn ".gitignore missing"
    fi

    if [ -f "$repo_path/.dockerignore" ]; then
        # AI_RULES §12 — node_modules MUST be in .dockerignore (first condition)
        if grep -q "node_modules" "$repo_path/.dockerignore"; then
            pass ".dockerignore present (node_modules excluded)"
        else
            warn ".dockerignore present but MISSING node_modules (AI_RULES §12)"
        fi
    else
        warn ".dockerignore missing (required for Docker projects — AI_RULES §12)"
    fi

    # 12. Check tech stack indicators
    if [ -f "$repo_path/docker-compose.yml" ] || [ -f "$repo_path/docker-compose.yaml" ]; then
        pass "docker-compose.yml present"
    else
        warn "No docker-compose.yml found (mandated by AI_RULES.md)"
    fi

    if [ -f "$repo_path/.env.example" ]; then
        pass ".env.example present"
    else
        warn ".env.example missing (mandated by AI_RULES.md)"
    fi

    # 13. Verify AI_RULES.md contains tech stack mandates
    if [ -f "$repo_path/AI/documentation/AI_RULES.md" ]; then
        local has_docker has_nextjs has_mongo
        has_docker=$(grep -c "Docker" "$repo_path/AI/documentation/AI_RULES.md" 2>/dev/null)
        has_nextjs=$(grep -c "Next.js" "$repo_path/AI/documentation/AI_RULES.md" 2>/dev/null)
        has_mongo=$(grep -c "MongoDB" "$repo_path/AI/documentation/AI_RULES.md" 2>/dev/null)
        if [ "$has_docker" -gt 0 ] && [ "$has_nextjs" -gt 0 ] && [ "$has_mongo" -gt 0 ]; then
            pass "AI_RULES.md contains all tech stack mandates (Docker, Next.js, MongoDB)"
        else
            fail "AI_RULES.md missing tech stack mandates"
            ((repo_fail++))
        fi
    fi

    # 14. AI_RULES §11a — vercel.json in the Vercel project's Root Directory
    check_vercel_root_placement "$repo_path" || ((repo_fail++))

    # 15. AI_RULES §21 — self-hosted runners only outside exempt orgs (config/hosted_runner_orgs.txt).
    #     A hosted ubuntu/windows/macos runner on a repo outside the exempt org
    #     burns billable Actions minutes; it must be [self-hosted, myai-local].
    if declare -F sh_workflow_dir >/dev/null 2>&1; then
        local _wfdir; _wfdir="$(sh_workflow_dir "$repo_path")"
        if [ -n "$_wfdir" ]; then
            if sh_is_exempt_org "$repo_path"; then
                pass "CI runners: exempt org $(sh_repo_owner "$repo_path") — hosted runners allowed (§21)"
            else
                local _hostf _hits _any=0
                for _hostf in "$_wfdir"/*.yml "$_wfdir"/*.yaml; do
                    [ -f "$_hostf" ] || continue
                    _hits="$(sh_hosted_runner_hits "$_hostf")"
                    if [ -n "$_hits" ]; then
                        _any=1
                        fail "$(basename "$_hostf"): hosted runner on a non-exempt repo — must be [self-hosted, myai-local] (§21). Fix: ./scripts/rollout_selfhosted_runner.sh --apply"
                    fi
                done
                [ "$_any" = 0 ] && pass "CI runners: all workflows on self-hosted (§21)"
                [ "$_any" = 1 ] && ((repo_fail++))
            fi
        fi
    fi

    # 15b. This host's runners (slots of project myai, 2026-10-22) — one line per
    #      runner, master repo only, and only on a host that has runner slots.
    #      A down/offline runner warns; it never fails the repo.
    if [ "$repo_path" = "$REPO_DIR" ] && [ -f "$SCRIPT_DIR/runner_selfhosted.sh" ] \
       && [ -f "${MYAI_HOME:-$HOME/.myai}/runners/slots.$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')" ]; then
        local _rl
        while IFS= read -r _rl; do
            case "$_rl" in
                "OK   "*) pass "gh runner ${_rl#OK   }" ;;
                "WARN "*) warn "gh runner ${_rl#WARN } — scripts/runner_selfhosted.sh status" ;;
            esac
        done <<< "$(bash "$SCRIPT_DIR/runner_selfhosted.sh" check 2>&1)"
    fi

    return $repo_fail
}

# ─── Main ───

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  AI Management Framework — Health Check          ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"

# Multi-Org Auth check (non-fatal, runs before repo checks)
check_org_health

if [ -n "$1" ]; then
    # Check single target
    TOTAL_REPOS=1
    check_repo "$1"
    [ $? -eq 0 ] && ((REPOS_HEALTHY++))
else
    # Check all managed repos — resolver (DB-preferred) with seed-file fallback
    if ! declare -F repo_paths >/dev/null 2>&1 && [ ! -f "$TRACKING_FILE" ]; then
        echo -e "${RED}Error: no fleet roster (scripts/lib/repo_paths.sh and $TRACKING_FILE both missing).${NC}"
        exit 1
    fi

    # Check master repo (flat structure)
    echo -e "\n${YELLOW}── Master Template ──${NC}"
    ((TOTAL_REPOS++))
    check_master "$REPO_DIR"
    [ $? -eq 0 ] && ((REPOS_HEALTHY++))

    echo -e "\n${YELLOW}── Managed Repositories ──${NC}"
    while IFS= read -r repo_path || [ -n "$repo_path" ]; do
        [ -n "$repo_path" ] || continue
        ((TOTAL_REPOS++))
        if [ ! -d "$repo_path" ]; then
            echo ""
            echo -e "${CYAN}━━━ Checking: ${repo_path} ━━━${NC}"
            fail "Directory not found"
            continue
        fi
        check_repo "$repo_path"
        [ $? -eq 0 ] && ((REPOS_HEALTHY++))
    done < <(
        if declare -F repo_paths >/dev/null 2>&1; then
            repo_paths
        else
            # legacy seed-file parse (resolver lib missing)
            grep -vE '^\s*(#|$)' "$TRACKING_FILE" | sed "s|^~/|$HOME/|"
        fi
    )
fi

# ─── Summary ───

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  Summary                                         ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Repositories checked: ${TOTAL_REPOS}"
echo -e "  ${GREEN}Passed:${NC}  $PASS"
echo -e "  ${YELLOW}Warnings:${NC} $WARN"
echo -e "  ${RED}Failed:${NC}  $FAIL"
echo ""
echo -e "  ${CYAN}Note:${NC} this checks file EXISTENCE only. For content-level drift"
echo -e "  (a repo's settings.json/hooks/config diverging from master after a manual"
echo -e "  edit), run ./scripts/check_config_drift.sh."
echo ""

if [ $FAIL -eq 0 ]; then
    echo -e "  ${GREEN}All checks passed!${NC}"
    exit 0
elif [ $FAIL -le 3 ]; then
    echo -e "  ${YELLOW}Minor issues found — run ./scripts/update_all.sh to fix most problems.${NC}"
    exit 1
else
    echo -e "  ${RED}Significant issues — review failures above and run ./scripts/update_all.sh${NC}"
    exit 2
fi
