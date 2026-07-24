# Agent Catalog

> 62 specialist agents organized by category. All auto-discovered from `.claude/agents/`.

---

## Core Specialists (13) — Original

| Agent | Domain | Lane | Triggers |
|-------|--------|------|----------|
| `solution-architect` | ADRs, system design, tech choices | D (Async) | architecture, design, ADR, scalability |
| `frontend-specialist` | Next.js, React, Vercel | A (Frontend) | component, page, frontend, UI, Next.js |
| `api-specialist` | Node.js/Python APIs, REST/GraphQL | B (Backend) | endpoint, route, API, controller, middleware |
| `database-specialist` | MongoDB, Mongoose, Atlas | B (Backend) | schema, model, query, database, MongoDB |
| `devops-specialist` | Docker, GitHub Actions, CI/CD | C (Infra) | docker, deploy, pipeline, CI/CD |
| `ui-ux-specialist` | Design system, Tailwind, a11y | A (Frontend) | design system, layout, style, UX, Tailwind |
| `security-specialist` | OWASP, auth, secrets, rate limiting | C (Infra) | security, auth, JWT, OWASP |
| `documentation-specialist` | README, API docs, changelogs | D (Async) | docs, README, document, guide |
| `product-manager` | Feature specs, user stories, roadmap | D (Async) | feature, requirement, user story, roadmap |
| `qa-specialist` | Testing strategy, unit/integration/E2E | Cross-Lane | test, QA, coverage, E2E, unit test |
| `tech-ba` | Requirements, data flows, specs | D (Async) | requirements, data flow, gap analysis |
| `tech-lead` | Code review, standards, coherence | Cross-Lane | code review, standards, coherence |
| `project-manager` | Delivery, milestones, blockers | D (Async) | project plan, milestone, blocker, status |

---

## Swarm Coordination (7) — `swarm-` prefix

| Agent | Role | Lane |
|-------|------|------|
| `swarm-coordinator` | Master orchestrator — task decomposition, topology selection, dispatch | Orchestrator |
| `swarm-hierarchical` | Tree-structured delegation through lane leads | Swarm |
| `swarm-mesh` | Peer-to-peer coordination for cross-cutting work | Swarm |
| `swarm-adaptive` | Dynamic topology selection based on task characteristics | Swarm |
| `swarm-byzantine` | Fault-tolerant consensus validation (2/3 agreement) | Swarm |
| `swarm-raft` | Leader election for conflict resolution | Swarm |
| `swarm-gossip` | Eventual consistency state propagation | Swarm |

---

## Development (6) — `dev-` prefix

| Agent | Role | Lane |
|-------|------|------|
| `dev-backend` | Node.js/Express, Python/FastAPI, service architecture | B (Backend) |
| `dev-mobile` | React Native, Expo, mobile-first patterns | A (Frontend) |
| `dev-ml` | ML pipelines, model integration, data preprocessing | B (Backend) |
| `dev-cicd` | GitHub Actions deep expertise, matrix builds, deployment gates | C (Infra) |
| `dev-performance` | Profiling, optimization, caching, code splitting | Cross-Lane |
| `dev-fullstack` | Rapid end-to-end feature scaffolding | Cross-Lane |

---

## Analysis (5) — `analysis-` prefix

| Agent | Role | Lane |
|-------|------|------|
| `analysis-code` | Complexity scoring, smell detection, duplication | Cross-Lane |
| `analysis-performance` | Lighthouse, bundle size, query performance | Cross-Lane |
| `analysis-security` | Threat modeling, pen test planning, attack surface | C (Infra) |
| `analysis-dependency` | License compliance, vulnerability scanning, upgrades | Cross-Lane |
| `analysis-architecture` | Coupling analysis, drift detection, fitness functions | D (Async) |

---

## Neural / SONA (4) — `neural-` prefix

| Agent | Role | Lane |
|-------|------|------|
| `neural-sona` | Pattern scoring, learning rate tuning, confidence decay | Cross-Lane |
| `neural-memory` | Store, retrieve, consolidate, prune memory | Cross-Lane |
| `neural-trainer` | Extract patterns from completed tasks | Cross-Lane |
| `neural-context` | Build optimal context from memory store | Cross-Lane |

---

## GitHub (5) — `github-` prefix

| Agent | Role | Lane |
|-------|------|------|
| `github-pr-manager` | PR lifecycle, auto-descriptions, merge strategy | D (Async) |
| `github-issue-tracker` | Issue triage, labeling, duplicate detection | D (Async) |
| `github-release-manager` | Semantic versioning, changelogs, release notes | D (Async) |
| `github-review-swarm` | Multi-perspective code review (security + perf + style) | Cross-Lane |
| `github-actions` | Workflow authoring, debugging, optimization | C (Infra) |

---

## Operations (5) — `ops-` prefix

| Agent | Role | Lane |
|-------|------|------|
| `ops-monitoring` | Logging, metrics, dashboards, alerting | C (Infra) |
| `ops-incident` | RCA, postmortems, runbooks | D (Async) |
| `ops-capacity` | Resource sizing, cost estimation, scaling | D (Async) |
| `ops-migration` | Cloud/data migration, zero-downtime deploy | C (Infra) |
| `ops-compliance` | SOC2, GDPR, HIPAA auditing | D (Async) |

---

## Data (4) — `data-` prefix

| Agent | Role | Lane |
|-------|------|------|
| `data-architect` | ERD, data flow, ETL design, governance | B (Backend) |
| `data-analytics` | Reporting, dashboards, KPIs, aggregation | B (Backend) |
| `data-quality` | Validation rules, cleansing, anomaly detection | B (Backend) |
| `data-integration` | API integration, webhooks, event streaming | B (Backend) |

---

## Content (4) — `content-` prefix

| Agent | Role | Lane |
|-------|------|------|
| `content-technical-writer` | Long-form technical documentation | D (Async) |
| `content-api-designer` | OpenAPI spec authoring, API design | D (Async) |
| `content-diagram` | Mermaid diagrams (sequence, ER, flowchart) | D (Async) |
| `content-tutorial` | Step-by-step tutorials and guides | D (Async) |

---

## Lifecycle (3) — Agentic Lifecycle System

| Agent | Role | Lane |
|-------|------|------|
| `security-integrity` | Agent/skill hash verification, injection scanning | C (Infra) |
| `project-onboarder` | Codebase scan orchestration, tech stack detection | Orchestrator |
| `ops-observability` | Agent activity tracking, task metrics, framework drift | D (Async) |

---

## Standing Agents (5) — `standing-` prefix

Autonomous agents designed to run on cron schedules. Each performs a specific maintenance/audit function across all managed repos.

| Agent | Role | Lane |
|-------|------|------|
| `standing-pr-reviewer` | Autonomous PR reviewer — code quality, security, test coverage | Cross-Lane |
| `standing-doc-gardener` | Documentation freshness auditor — stale/missing/inconsistent docs | D (Async) |
| `standing-dep-watcher` | Dependency health monitor — outdated, vulnerable, license issues | Cross-Lane |
| `standing-security-auditor` | Scheduled security scanner — secrets, OWASP, insecure configs | C (Infra) |
| `standing-status-reporter` | Cross-repo status reporter — git state, CI, tasks, activity | D (Async) |

---

## Gate (1) — Final Quality Gate

| Agent | Role | Lane |
|-------|------|------|
| `external-auditor` | Independent production-grade auditor. Blocks ship if security, testing, performance, observability, or code quality fail. Never reviews code it built. | Cross-Lane (Independent, runs last) |

---

## Summary

| Category | Count | Prefix |
|----------|-------|--------|
| Core | 13 | (original names) |
| Swarm | 7 | `swarm-` |
| Development | 6 | `dev-` |
| Analysis | 5 | `analysis-` |
| Neural | 4 | `neural-` |
| GitHub | 5 | `github-` |
| Operations | 5 | `ops-` |
| Standing | 5 | `standing-` |
| Data | 4 | `data-` |
| Content | 4 | `content-` |
| Lifecycle | 3 | (mixed) |
| Gate | 1 | `external-auditor` |
| **Total** | **62** | |
