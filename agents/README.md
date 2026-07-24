# Agent-Agnostic Specialist Prompts

This directory contains specialist role definitions usable by any AI tool — Gemini, GitHub Copilot, Claude, or any future AI.

## How to Use These Prompts

### For Claude Code
Claude Code natively uses `.claude/agents/` — the agent files in that directory are auto-discovered. These `agents/` prompts are the equivalent for manual use.

### For Gemini Advanced / Gemini in AI Studio
Start a new conversation with:
```
Adopt the role defined in AI/agents/[specialist-name].md for this session. Read the file and confirm your role before we begin.
```

### For GitHub Copilot Chat
In the Copilot Chat panel:
```
@workspace Act as the [specialist-name] defined in AI/agents/[specialist-name].md. Read the file content and operate within that specialist's scope.
```

### For Any AI Tool (Generic)
```
Read the file AI/agents/[specialist-name].md and adopt that specialist role for our session. Follow the behavior rules, file ownership, and output formats defined in that file.
```

---

## Available Specialists

| File | Role | Use When |
|------|------|----------|
| `solution-architect.md` | System design, ADRs, tech choices | Architecture decisions, "X vs Y" choices |
| `frontend-specialist.md` | Next.js, React, Vercel | Components, pages, frontend features |
| `api-specialist.md` | Node.js/Python APIs, REST/GraphQL | Endpoints, routes, middleware |
| `database-specialist.md` | MongoDB, Mongoose, Atlas | Schemas, queries, indexes |
| `devops-specialist.md` | Docker, GitHub Actions, CI/CD | Infrastructure, deployment, environments |
| `ui-ux-specialist.md` | Design system, Tailwind, accessibility | Styling, UX flows, component design |
| `security-specialist.md` | OWASP, auth, secrets | Security reviews, auth implementation |
| `documentation-specialist.md` | README, API docs, guides | Writing and updating documentation |
| `product-manager.md` | Feature specs, user stories | What to build, backlog, scope |
| `qa-specialist.md` | Testing strategy, Jest, Playwright | Writing tests, quality gates |
| `tech-ba.md` | Requirements, data flows, specs | Business → technical translation |
| `tech-lead.md` | Code review, standards, integration | Cross-specialist review, coherence |
| `project-manager.md` | Delivery, milestones, blockers | Project tracking, coordination |

---

## Parallel Dispatch Reference

```
LANE A (Frontend):    frontend-specialist + ui-ux-specialist
LANE B (Backend):     api-specialist + database-specialist
LANE C (Infra):       devops-specialist + security-specialist
LANE D (Async):       documentation-specialist + solution-architect + product-manager + tech-ba + project-manager
CROSS-LANE:           tech-lead (reviews all lanes)
QA:                   qa-specialist (parallel to B, reviews A)
```

See `AI/documentation/MULTI_AGENT_ROUTING.md` for the full routing reference.
