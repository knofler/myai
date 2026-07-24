# AI Agent Workflow Instructions

## Getting Started
1. **Read Handoff First:** Immediately read the `state/STATE.md` and `state/AI_AGENT_HANDOFF.md` files located in the `AI/` directory at the root of the workspace to understand the current project status and objectives.
2. **Review Rules:** Familiarize yourself with `AI/documentation/AI_RULES.md` for architectural and code quality standards.
3. **Check Plans:** Look into `AI/plan/` for context-specific implementation roadmaps.
4. **Codebase Exploration:** Use `grep_search` and `glob` to map the relevant parts of the codebase before making changes.

## Bootstrapping & Managing Projects
When asked to bootstrap a project using `./scripts/init_ai.sh`:
1. Execute the script targeting the provided directory. This will automatically add the target directory to `config/managed_repos.txt`.
2. Ask the user if the target directory is a **New Project** or an **Existing Project**.
3. Based on their answer, output the exact copy-pasteable prompt for **Step 2: Option A** or **Step 2: Option B** from the master `README.md`.

## ⚠️ MANDATORY: Autonomous Framework Sync
If you make ANY changes to the core global files in this master repository (e.g., `documentation/AI_RULES.md`, `documentation/Instruction.md`, `documentation/INTEGRATION_GUIDE.md`, or `documentation/global_ai_management_prompt.md`), you MUST autonomously run `./scripts/update_all.sh` immediately afterwards.
This ensures all projects listed in `config/managed_repos.txt` stay synchronized with the latest global rules.

## ⚠️ MANDATORY: Autonomous State Tracking
You are required to **autonomously** maintain the project state. Do NOT wait for the user to tell you to "save state" or "update logs".
- **After EVERY task or sub-task:** Automatically update your specific log file (`AI/logs/gemini.md`, `AI/logs/claude_log.md`, or `AI/logs/copilot.md`) with a timestamp and what was just done.
- **Continuous State Sync:** Automatically update `AI/state/STATE.md` with the current progress and next steps before you finish your response to the user. **Do not wait for the end of the session.**

## Atomic Documentation
When creating or updating plans, designs, or architecture docs, prefer creating new, timestamped files in the respective subdirectories (`AI/plan/`, `AI/design/`, etc.) instead of maintaining one massive file. This preserves history and reduces context overhead.

## Handoff Procedure
When the user explicitly asks to "prepare for handoff" or switch agents:
1. Do a final verification of `AI/state/STATE.md` to ensure it captures the exact stopping point.
2. Overwrite `AI/state/AI_AGENT_HANDOFF.md` with specific, actionable instructions for the next agent to pick up seamlessly.
3. If requested, ensure all changes are committed to Git.

## Management Files
- **logs/claude_log.md**: Log for Claude's actions.
- **logs/copilot.md**: Log for Copilot's actions.
- **logs/gemini.md**: Log for Gemini's actions (you).
- **documentation/global_ai_management_prompt.md**: The master instruction set for initializing this folder structure.

---

## Parallel Execution Workflow

### Overview
This framework supports 13 specialist agents running in defined parallel lanes. Sequential work is the exception, not the rule.

### Session Start Protocol
1. Read `AI/state/STATE.md` + `AI/state/AI_AGENT_HANDOFF.md` (synchronize state)
2. Read `AI/documentation/MULTI_AGENT_ROUTING.md` (routing reference)
3. Assess what lanes can run in parallel for the current task
4. Dispatch specialists — start Lane C (infra) and Lane D (async) immediately for any new project

### Parallel Lane Reference
```
Lane A (Frontend):  frontend-specialist + ui-ux-specialist
Lane B (Backend):   api-specialist + database-specialist
Lane C (Infra):     devops-specialist + security-specialist  ← always start here
Lane D (Async):     documentation-specialist + solution-architect + product-manager + tech-ba + project-manager
Cross-Lane:         tech-lead (reviews) + qa-specialist (tests)
```

### Dispatch Decision
- **2+ lanes with no shared file dependencies** → dispatch in parallel
- **Specialist A's output required by Specialist B** → sequence them
- **Any new project** → Lane C and Lane D always start immediately, in parallel

### Example: New Full-Stack App
```
Round 1 (Immediate, all parallel):
  devops-specialist    → Docker + docker-compose + .env.example + GitHub Actions
  security-specialist  → Auth strategy ADR + secrets review
  ui-ux-specialist     → Design tokens in tailwind.config.js
  documentation-specialist → README skeleton
  product-manager      → Feature spec for first milestone
  project-manager      → PROJECT_PLAN.md + STATE.md
  solution-architect   → Architecture ADR

Round 2 (After schemas defined):
  database-specialist  → MongoDB schemas
  api-specialist       → API endpoint contracts (not yet implemented)

Round 3 (After API contracts exist):
  frontend-specialist  → Pages + components + data fetching
  api-specialist       → Implement endpoints (using defined contracts)
  qa-specialist        → Unit + integration tests (parallel to Round 3)

Ongoing (cross-lane):
  tech-lead            → Code reviews as each specialist completes work
  security-specialist  → Security audit of completed implementations
```

### For Non-Claude AI Tools (Gemini, Copilot)
Manually adopt specialist roles using prompts in `AI/agents/`:
```
"Adopt the role defined in AI/agents/api-specialist.md for this session."
```
See `AI/agents/README.md` for tool-specific instructions.

### Agent Definitions
- **Claude Code:** `AI/.claude/agents/` — auto-discovered subagents
- **All tools:** `AI/agents/` — plain-text role prompts
- **Routing:** `AI/documentation/MULTI_AGENT_ROUTING.md`
