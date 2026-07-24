# Skill: Test Plan Create

> **Agent:** QA Specialist
> **Trigger keywords:** `test plan`, `testing strategy for project`, `create test plan`
> **Output:** `reports/test-plan.md`

---

## Purpose

Generate a comprehensive test plan for the current project. Identifies critical paths,
inventories existing test coverage, and produces a structured plan covering unit,
integration, and E2E testing layers with coverage targets.

---

## Steps

### 1. Detect Project Type
- Read `package.json`, `docker-compose.yml`, framework configs
- Classify: Next.js frontend, Express API, full-stack monorepo, workspace
- Note test runner already configured (Jest, Vitest, Playwright, Cypress)

### 2. Inventory Existing Tests
- Glob for `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/e2e/**`
- Count tests per directory and per type (unit / integration / E2E)
- Run existing tests inside Docker to get current pass/fail baseline
- Record current coverage percentage if available

### 3. Identify Critical Paths
- Read route files, API endpoints, middleware chains
- Read `state/STATE.md` for in-progress features
- Map user-facing flows: auth, CRUD operations, payments, etc.
- Rank by business impact and change frequency

### 4. Generate Test Plan
- For each critical path, define required test types:
  - **Unit:** Pure functions, utilities, hooks, model methods
  - **Integration:** API routes with DB, middleware chains, auth flows
  - **E2E:** Full user journeys through the UI or API
- Assign priority (P0 = must have, P1 = should have, P2 = nice to have)

### 5. Set Coverage Targets
- Minimum thresholds: statements 80%, branches 70%, functions 80%, lines 80%
- Per-directory overrides for critical modules (e.g., auth: 90%)
- Document in plan as enforceable CI gates

### 6. Write Report
- Output to `reports/test-plan.md` with sections:
  - Project summary, current state, critical paths, plan by layer, coverage targets
- Include a checklist of tests to write, grouped by priority

### 7. Create Tasks
- For each P0 test gap, create a task in `tasks.json`
- Tag with `qa`, `test-plan`, and the relevant agent lane

---

## Abort Conditions
- If project has no runnable code yet, output a skeleton plan and note it is preliminary
- If Docker is not running, warn and skip live test execution

## Post-Completion
- Update `state/STATE.md` with test plan status
- Log action to `logs/claude_log.md`
