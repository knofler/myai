#!/bin/bash

# AI Management Framework - Health Check
# Usage: ./scripts/health_check.sh [target_directory]
# If no target, checks all managed repos from config/managed_repos.txt

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
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

    local org_dirs="museum tech personal"
    local dir_count=0
    local auth_count=0
    local has_any_dir=0

    # 1. Check each expected config dir exists + is authenticated
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
    if [ -f "$repo_path/config/managed_repos.txt" ]; then
        pass "config/managed_repos.txt exists"
    else
        fail "config/managed_repos.txt missing"
        ((repo_fail++))
    fi

    # Check git
    if [ -d "$repo_path/.git" ]; then
        pass "Git repository initialized"
    else
        warn "Not a git repository"
    fi

    # Stale refs
    local stale_refs
    stale_refs=$(grep -rl "rummanahmed" "$repo_path/" --include="*.md" 2>/dev/null | xargs grep -l "[^\`]rummanahmed[^'\`]" 2>/dev/null | head -5)
    if [ -n "$stale_refs" ]; then
        warn "Stale username found: $stale_refs"
    else
        pass "No stale username references"
    fi

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

    # 9. Check for stale username references
    local stale_refs
    stale_refs=$(grep -rl "rummanahmed" "$repo_path/AI/" 2>/dev/null | head -5)
    if [ -n "$stale_refs" ]; then
        warn "Stale username 'rummanahmed' found in: $stale_refs"
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
    # Check all managed repos
    if [ ! -f "$TRACKING_FILE" ]; then
        echo -e "${RED}Error: $TRACKING_FILE not found.${NC}"
        exit 1
    fi

    # Check master repo (flat structure)
    echo -e "\n${YELLOW}── Master Template ──${NC}"
    ((TOTAL_REPOS++))
    check_master "$REPO_DIR"
    [ $? -eq 0 ] && ((REPOS_HEALTHY++))

    echo -e "\n${YELLOW}── Managed Repositories ──${NC}"
    while IFS= read -r repo_path || [ -n "$repo_path" ]; do
        [[ -z "$repo_path" ]] || [[ "$repo_path" == \#* ]] && continue
        repo_path="${repo_path/#\~/$HOME}"
        ((TOTAL_REPOS++))
        if [ ! -d "$repo_path" ]; then
            echo ""
            echo -e "${CYAN}━━━ Checking: ${repo_path} ━━━${NC}"
            fail "Directory not found"
            continue
        fi
        check_repo "$repo_path"
        [ $? -eq 0 ] && ((REPOS_HEALTHY++))
    done < "$TRACKING_FILE"
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
