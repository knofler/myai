# Skills Catalog — AI Management Framework

> 59 skills across 13 specialist agents. Claude Code auto-discovers skills from `.claude/skills/`.

---

## How Skills Work

Each skill is a repeatable playbook stored as `skills/<skill-name>/SKILL.md`. Claude Code auto-discovers them via the `.claude/skills -> ../skills` symlink.

**Invocation:** Skills trigger automatically when your prompt matches the trigger keywords in the skill's `description` frontmatter. You can also reference them explicitly: *"Use the `api-contract` skill to define endpoints."*

---

## Skills by Agent

### API Specialist (5 skills)

| Skill | Description | Triggers |
|-------|-------------|----------|
| `api-contract` | Define API contracts before implementation | API contract, endpoint spec, define endpoints, API design |
| `endpoint-implementation` | Implement an endpoint end-to-end (route → controller → service → validation → test) | implement endpoint, build endpoint, create route, add API |
| `middleware-setup` | Set up Express/FastAPI middleware (auth, validation, rate-limit, error handler) | middleware, add middleware, request handler |
| `swagger-openapi` | Generate OpenAPI/Swagger documentation from routes | Swagger, OpenAPI, API docs generate, document endpoints |
| `render-deploy-api` | Deploy API to Render.com | Render deploy, deploy API, render.yaml, API hosting |

### Database Specialist (4 skills)

| Skill | Description | Triggers |
|-------|-------------|----------|
| `schema-design` | Design MongoDB schemas with Mongoose | schema, model, data model, collection design, Mongoose schema |
| `migration-script` | Create database migration scripts (up/down) | migration, schema change, data migration, database update |
| `seed-data` | Create seed data for development/testing | seed, test data, sample data, mock data, fixtures |
| `aggregation-pipeline` | Build MongoDB aggregation pipelines | aggregation, pipeline, complex query, $group, $lookup |

### DevOps Specialist (5 skills)

| Skill | Description | Triggers |
|-------|-------------|----------|
| `docker-compose-setup` | Set up docker-compose.yml for full stack | docker-compose, compose file, multi-container, local dev |
| `dockerfile-create` | Create optimized multi-stage Dockerfiles | Dockerfile, Docker image, containerize, build image |
| `github-actions-pipeline` | Create GitHub Actions CI/CD pipeline | CI/CD, GitHub Actions, pipeline, workflow, automated deploy |
| `env-strategy` | Set up environment variable strategy | environment variables, .env, config management, secrets setup |
| `health-check-setup` | Add health check endpoints and Docker healthchecks | health check, liveness, readiness, monitoring endpoint |

### Documentation Specialist (4 skills)

| Skill | Description | Triggers |
|-------|-------------|----------|
| `readme-scaffold` | Scaffold a comprehensive README.md | README, project readme, scaffold readme, documentation setup |
| `api-docs-write` | Write API endpoint documentation | API docs, endpoint documentation, document API, API reference |
| `adr-write` | Write Architecture Decision Records | ADR, architecture decision, decision record |
| `changelog-update` | Update CHANGELOG.md (Keep a Changelog format) | changelog, release notes, what changed, version notes |

### Frontend Specialist (5 skills)

| Skill | Description | Triggers |
|-------|-------------|----------|
| `nextjs-page-create` | Create a Next.js page/route (App Router) | page, route, Next.js page, new page, app router page |
| `react-component-build` | Build a React component with TypeScript + Tailwind | component, React component, build component, new component |
| `api-integration` | Integrate frontend with API endpoints | fetch, API call, integrate API, connect to backend, data fetching |
| `state-management` | Set up state management (Context/Zustand/React Query) | state management, global state, React Context, Zustand, store |
| `vercel-deploy-frontend` | Deploy frontend to Vercel | Vercel deploy, deploy frontend, Vercel config, preview deployment |

### Product Manager (4 skills)

| Skill | Description | Triggers |
|-------|-------------|----------|
| `feature-spec` | Write a feature specification | feature spec, feature specification, product spec, spec out |
| `user-story-write` | Write user stories with acceptance criteria | user story, as a user, user requirement, acceptance criteria |
| `mvp-definition` | Define MVP scope with MoSCoW prioritization | MVP, minimum viable, first release, initial scope, launch scope |
| `backlog-prioritize` | Prioritize product backlog (RICE/weighted scoring) | backlog, prioritize, priority, what to build next, ranking |

### Project Manager (5 skills)

| Skill | Description | Triggers |
|-------|-------------|----------|
| `session-start` | Start a work session (read state, assess, brief) | start session, begin work, what should I work on, status check |
| `milestone-plan` | Create a project milestone plan | milestone, project plan, roadmap, timeline, delivery plan |
| `blocker-escalation` | Escalate and resolve blockers | blocker, blocked, impediment, stuck, can't proceed |
| `status-report` | Generate project status report | status report, progress report, project status, update report |
| `session-close` | Close a work session (save state, handoff) | end session, wrap up, save state, handoff |

### QA Specialist (5 skills)

| Skill | Description | Triggers |
|-------|-------------|----------|
| `test-strategy` | Define testing strategy for a project | test strategy, testing plan, test setup, test framework |
| `unit-test-write` | Write unit tests (Jest/Vitest) | unit test, write test, test function, jest test, vitest |
| `integration-test-write` | Write integration tests (Supertest) | integration test, API test, endpoint test, supertest |
| `e2e-test-write` | Write E2E tests (Playwright/Cypress) | E2E test, end-to-end, Playwright, Cypress, browser test |
| `coverage-enforce` | Enforce test coverage thresholds | coverage, test coverage, coverage report, untested code |

### Security Specialist (5 skills)

| Skill | Description | Triggers |
|-------|-------------|----------|
| `auth-flow-review` | Review and implement authentication flow | auth, authentication, login flow, JWT, auth review, token |
| `owasp-audit` | Perform OWASP Top 10 security audit | OWASP, security audit, vulnerability scan, security review |
| `rate-limit-setup` | Set up rate limiting | rate limit, throttle, request limit, abuse prevention |
| `secrets-audit` | Audit secrets and environment variables | secrets, secret audit, API keys, credentials, .env audit |
| `security-headers` | Configure security headers (helmet, CSP, CORS) | security headers, helmet, CORS, CSP, HSTS |

### Solution Architect (4 skills)

| Skill | Description | Triggers |
|-------|-------------|----------|
| `system-design` | Create system architecture design | system design, architecture, system architecture |
| `tech-evaluation` | Evaluate technology choices | tech evaluation, should we use, compare technologies, tech choice |
| `coherence-review` | Review cross-specialist coherence | coherence, integration review, consistency check, alignment |
| `tech-debt-flag` | Identify and document technical debt | tech debt, code smell, refactor needed, cleanup needed |

### Tech BA (4 skills)

| Skill | Description | Triggers |
|-------|-------------|----------|
| `requirements-elicit` | Elicit and document requirements | requirements, gather requirements, business requirements |
| `data-flow-diagram` | Create data flow diagrams | data flow, DFD, data flow diagram, information flow |
| `gap-analysis` | Perform gap analysis (current vs target state) | gap analysis, what's missing, current vs target |
| `requirements-traceability` | Create requirements traceability matrix | traceability, RTM, requirement coverage, trace requirements |

### Tech Lead (4 skills)

| Skill | Description | Triggers |
|-------|-------------|----------|
| `code-review` | Perform code review against project standards | code review, review code, PR review, review changes |
| `standards-enforcement` | Enforce coding standards | standards, coding standards, lint, code quality, conventions |
| `cross-specialist-integration` | Coordinate cross-specialist integration | integration, cross-team, connect services, wire up |
| `feature-signoff` | Sign off on feature completion | signoff, feature complete, done review, ready to ship |

### UI/UX Specialist (5 skills)

| Skill | Description | Triggers |
|-------|-------------|----------|
| `design-system-setup` | Set up a design system (tokens, base components) | design system, component library, UI kit, design tokens |
| `component-spec` | Write UI component specification | component spec, UI spec, component design, widget spec |
| `accessibility-audit` | Perform WCAG 2.1 AA accessibility audit | accessibility, a11y, WCAG, screen reader, keyboard navigation |
| `ux-flow-doc` | Document UX user flows | user flow, UX flow, flow diagram, user journey, task flow |
| `tailwind-config-extend` | Extend Tailwind CSS configuration | Tailwind config, extend Tailwind, custom Tailwind, Tailwind theme |

---

## Quick Reference

**Total:** 59 skills across 13 agents

| Agent | Count | Lane |
|-------|-------|------|
| API Specialist | 5 | B (Backend) |
| Database Specialist | 4 | B (Backend) |
| DevOps Specialist | 5 | C (Infrastructure) |
| Documentation Specialist | 4 | D (Async) |
| Frontend Specialist | 5 | A (Frontend) |
| Product Manager | 4 | D (Async) |
| Project Manager | 5 | D (Async) |
| QA Specialist | 5 | Cross-Lane |
| Security Specialist | 5 | C (Infrastructure) |
| Solution Architect | 4 | D (Async) |
| Tech BA | 4 | D (Async) |
| Tech Lead | 4 | Cross-Lane |
| UI/UX Specialist | 5 | A (Frontend) |
