# Multi-Agent Routing Reference

> **For all AI agents:** Read this file to understand how to dispatch, coordinate, and sequence work across specialists.

---

## The 13 Specialists

| Agent | Domain | File |
|-------|--------|------|
| `solution-architect` | ADRs, system design, tech choices | `.claude/agents/solution-architect.md` |
| `frontend-specialist` | Next.js, React, Vercel | `.claude/agents/frontend-specialist.md` |
| `api-specialist` | Node.js/Python APIs, REST/GraphQL, Render | `.claude/agents/api-specialist.md` |
| `database-specialist` | MongoDB schema, Atlas, indexes, migrations | `.claude/agents/database-specialist.md` |
| `devops-specialist` | Docker Compose, GitHub Actions, CI/CD | `.claude/agents/devops-specialist.md` |
| `ui-ux-specialist` | Design system, accessibility, UX flows, Tailwind | `.claude/agents/ui-ux-specialist.md` |
| `security-specialist` | OWASP top 10, auth, secrets, rate limiting | `.claude/agents/security-specialist.md` |
| `documentation-specialist` | README, API docs, ADRs, changelogs | `.claude/agents/documentation-specialist.md` |
| `product-manager` | Feature specs, user stories, roadmap | `.claude/agents/product-manager.md` |
| `qa-specialist` | Testing strategy, unit/integration/E2E | `.claude/agents/qa-specialist.md` |
| `tech-ba` | Requirements analysis, data flows, functional specs | `.claude/agents/tech-ba.md` |
| `tech-lead` | Code review, standards, cross-specialist coherence | `.claude/agents/tech-lead.md` |
| `project-manager` | Delivery tracking, milestones, blockers | `.claude/agents/project-manager.md` |

---

## Parallel Dispatch Lanes

```
┌─────────────────────────────────────────────────────────────┐
│ LANE A: Frontend                                            │
│   → frontend-specialist + ui-ux-specialist                  │
│   → Owns: src/app/, src/components/, styles/, public/       │
├─────────────────────────────────────────────────────────────┤
│ LANE B: Backend                                             │
│   → api-specialist + database-specialist                    │
│   → Owns: src/api/, src/routes/, src/models/, src/services/ │
├─────────────────────────────────────────────────────────────┤
│ LANE C: Infrastructure                                      │
│   → devops-specialist + security-specialist                 │
│   → Owns: docker-compose.yml, .github/, Dockerfile, .env*  │
├─────────────────────────────────────────────────────────────┤
│ LANE D: Async (always parallel, never blocks others)        │
│   → documentation-specialist + solution-architect           │
│   → product-manager + tech-ba + project-manager            │
│   → Owns: AI/, README.md, docs/                            │
├─────────────────────────────────────────────────────────────┤
│ CROSS-LANE: tech-lead (reviews outputs from all lanes)      │
│ QA: qa-specialist (parallel to B, reviews A outputs)        │
└─────────────────────────────────────────────────────────────┘
```

---

## Dispatch Decision Rules

### When to Dispatch in Parallel
**Trigger:** Task touches 2 or more lanes with no shared state dependencies.

```
PARALLEL dispatch when:
  - Frontend UI work + API work (no shared contract needed yet)
  - Infrastructure setup + documentation
  - Any combination of Lane D specialists
  - devops-specialist + security-specialist (always parallel)
```

### When to Dispatch Sequentially
**Trigger:** Specialist A's output is a required input for Specialist B.

```
SEQUENTIAL when:
  Lane B (api-specialist) → THEN Lane A (frontend fetch logic)
  Reason: API contracts must be defined before frontend builds calls

  Lane B (database-specialist schema) → THEN Lane B (api-specialist services)
  Reason: Services query schemas that must exist first

  Lane C (devops env setup) → THEN Lane B or Lane A implementation
  Reason: Environment variables must be defined before code references them

  solution-architect ADR → THEN relevant implementation lane
  Reason: Architecture decisions must precede implementation of cross-cutting concerns
```

---

## Project-Type Routing

### New Next.js App (Frontend-only or Fullstack)
```
IMMEDIATE parallel dispatch:
  - frontend-specialist: scaffold Next.js app structure
  - ui-ux-specialist: define design tokens and component patterns
  - devops-specialist: Docker + docker-compose + GitHub Actions + vercel.json
  - documentation-specialist: README skeleton
  - project-manager: create PROJECT_PLAN.md
  - tech-ba: document initial requirements

THEN (after API contracts defined):
  - api-specialist: implement endpoints
  - database-specialist: schema design

THEN (after schemas and API exist):
  - frontend-specialist: implement data fetching

ALWAYS parallel:
  - security-specialist: reviewing auth and env handling
  - qa-specialist: writing tests alongside implementation
  - solution-architect: ADRs for major decisions
```

### API-Heavy Project (Node.js or Python)
```
IMMEDIATE parallel dispatch:
  - api-specialist: endpoint design and contracts
  - database-specialist: schema design
  - devops-specialist: Docker + CI/CD
  - security-specialist: auth middleware
  - documentation-specialist: API docs skeleton

ASYNC parallel:
  - solution-architect: service architecture ADRs
  - tech-ba: integration requirements
  - project-manager: milestone plan

THEN if UI needed:
  - frontend-specialist
  - ui-ux-specialist
```

### Data / Python Project
```
IMMEDIATE parallel dispatch:
  - api-specialist (Python/FastAPI): API layer
  - database-specialist: schema or data model
  - devops-specialist: Docker + CI/CD

ASYNC parallel:
  - documentation-specialist: data dictionary + README
  - solution-architect: data pipeline ADRs
```

### Any Project — Always Parallel from Start
```
These always run regardless of project type:
  → devops-specialist: Docker Compose + env vars
  → security-specialist: .env handling + auth approach
  → documentation-specialist: README
  → project-manager: STATE.md + handoff docs
```

---

## Trigger Keyword → Agent Routing

| Keyword / Signal | Route To |
|-----------------|----------|
| "architecture", "design", "ADR", "should we use X or Y", "scalability" | `solution-architect` |
| "component", "page", "frontend", "UI", "Next.js", "React", "Vercel", "SSR" | `frontend-specialist` |
| "endpoint", "route", "API", "controller", "middleware", "REST", "GraphQL" | `api-specialist` |
| "schema", "model", "query", "database", "collection", "MongoDB", "index" | `database-specialist` |
| "docker", "deploy", "pipeline", "environment", "CI/CD", "GitHub Actions" | `devops-specialist` |
| "design system", "layout", "style", "UX", "accessibility", "Tailwind", "a11y" | `ui-ux-specialist` |
| "security", "auth", "JWT", "permissions", "vulnerability", "OWASP" | `security-specialist` |
| "docs", "README", "document", "guide", "explain", "changelog" | `documentation-specialist` |
| "feature", "requirement", "user story", "roadmap", "scope", "MVP", "backlog" | `product-manager` |
| "test", "QA", "coverage", "E2E", "unit test", "integration test", "bug" | `qa-specialist` |
| "business process", "data flow", "gap analysis", "technical spec", "workflow" | `tech-ba` |
| "code review", "standards", "coherence", "technical decision", "review" | `tech-lead` |
| "project plan", "milestone", "blocker", "risk", "status", "sprint", "track" | `project-manager` |

---

## Cross-Cutting Concerns (Multi-Agent)

| Concern | Primary | Secondary |
|---------|---------|-----------|
| Authentication flow | `security-specialist` | `api-specialist` |
| Environment variables | `devops-specialist` | `security-specialist` |
| TypeScript types shared across layers | `tech-lead` | `api-specialist`, `frontend-specialist` |
| Database connection | `database-specialist` | `devops-specialist` |
| Error handling strategy | `tech-lead` | `api-specialist` |
| API contract definition | `api-specialist` → informs → `frontend-specialist` | |
| CI/CD test pipeline | `devops-specialist` | `qa-specialist` |
| Performance optimization | `solution-architect` | domain specialist |
| Accessibility | `ui-ux-specialist` | `frontend-specialist` |
| Requirements clarification | `tech-ba` → `product-manager` → `tech-lead` | |

---

## No-Shared-State Rule

Specialists in parallel lanes MUST NOT write to the same files simultaneously.

| Lane | Owned Files | Must Not Touch |
|------|------------|----------------|
| Lane A | `src/app/`, `src/components/`, `styles/` | `src/api/`, `docker-compose.yml` |
| Lane B | `src/models/`, `src/services/`, `src/routes/` | `src/app/`, `vercel.json` |
| Lane C | `docker-compose.yml`, `.github/`, `.env*` | `src/` (read only) |
| Lane D | `AI/`, `README.md`, `docs/` | All `src/` (read only) |

**Overlap = Sequential.** If a task requires touching files from 2 lanes, sequence the work.

---

## State Management Between Agents

```
Read on session start:     AI/state/STATE.md, AI/state/AI_AGENT_HANDOFF.md
Write after every task:    AI/state/STATE.md (what done, decisions, blockers, next steps)
Write on handoff:          AI/state/AI_AGENT_HANDOFF.md (specific next agent instructions)
Log every action:          AI/logs/claude_log.md or AI/logs/gemini.md or AI/logs/copilot.md
```

The file system is the shared memory. All specialists must keep it current.
