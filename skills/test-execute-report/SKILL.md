# Skill: Test Execute and Report

> **Agent:** QA Specialist
> **Trigger keywords:** `test report`, `run tests`, `test results`
> **Output:** `reports/test-results.md`

---

## Purpose

Execute the full test suite inside Docker, parse results, compare against coverage
targets, flag regressions, and produce a structured test results report. When invoked
as part of `ship it`, a failure ABORTs the deployment pipeline.

---

## Steps

### 1. Detect Test Runner
- Read `package.json` scripts for `test`, `test:unit`, `test:integration`, `test:e2e`
- Identify runner: Jest, Vitest, Playwright, Cypress, Mocha
- Locate config files (`jest.config.*`, `vitest.config.*`, `playwright.config.*`)

### 2. Execute Tests in Docker
- **Never run tests on the host** -- always via `docker exec <container> npm test`
- Run each test type separately if scripts exist:
  - `docker exec <container> npm run test:unit`
  - `docker exec <container> npm run test:integration`
  - `docker exec <container> npm run test:e2e`
- Capture full stdout/stderr output for parsing
- If Docker is not running, attempt `docker compose up -d` first

### 3. Parse Results
- Extract from runner output:
  - Total tests, passed, failed, skipped
  - Test duration
  - Coverage percentages (statements, branches, functions, lines)
- Identify specific failing test names and file paths

### 4. Compare Against Targets
- Read `reports/test-plan.md` for coverage targets (default: 80% statements)
- Flag any metric below target as a regression
- Compare with previous `reports/test-results.md` if it exists
- Detect newly failing tests vs previously known failures

### 5. Flag Regressions
- If any test that previously passed now fails, mark as REGRESSION
- If coverage dropped by more than 2% in any metric, mark as COVERAGE REGRESSION
- List all regressions prominently at the top of the report

### 6. Write Report
- Output to `reports/test-results.md` with sections:
  - Summary (pass/fail/skip counts, overall status)
  - Coverage table (actual vs target per metric)
  - Regressions (if any)
  - Failing tests with file paths and error snippets
  - Duration breakdown by test type
- Timestamp the report

### 7. Ship-It Gate
- If this skill was invoked as part of `ship it`:
  - Any failing test -> **ABORT the pipeline**, report reason
  - Coverage below target -> **WARN** but allow (unless P0 module)
  - Regressions -> **ABORT the pipeline**, report reason

---

## Abort Conditions
- Docker not running and cannot be started -> ABORT with clear error
- No test scripts found in package.json -> WARN, suggest creating test plan first

## Post-Completion
- Update `state/STATE.md` with latest test results summary
- Log action to `logs/claude_log.md`
