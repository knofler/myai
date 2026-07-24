---
name: test-strategy
description: "Define testing strategy for a project — choose frameworks, set coverage targets, create test directory structure, and document conventions. Triggers: test strategy, testing plan, test setup, how to test, test framework"
---

# Test Strategy

Define a comprehensive testing strategy for the project.

## Tech Stack

Jest/Vitest | Supertest | Playwright/Cypress | Istanbul/c8

## Playbook

### 1. Assess project scope

- Identify all modules, services, and entry points.
- Determine which layers exist: UI, API, database, third-party integrations.
- List critical business logic that must have test coverage.

### 2. Identify test levels needed

- **Unit** — pure functions, utils, business logic, hooks.
- **Integration** — API routes through middleware and DB.
- **E2E** — critical user flows through the browser.

### 3. Choose frameworks

- Use **Vitest** for Vite-based projects, **Jest** otherwise.
- Use **Supertest** for API integration tests.
- Use **Playwright** for E2E (prefer over Cypress for CI stability).
- Use **c8** with Vitest or **Istanbul/nyc** with Jest for coverage.

### 4. Define coverage targets

- Statements >= 80%, Branches >= 75%, Functions >= 80%, Lines >= 80%.
- Critical modules (auth, payments): >= 90%.

### 5. Create test directory structure

```
tests/
  unit/          ← mirrors src/ structure
  integration/   ← API + DB tests
  e2e/           ← browser flow tests
  fixtures/      ← shared test data
  helpers/       ← test utilities
```

### 6. Document testing conventions

- File naming: `<module>.test.ts` or `<module>.spec.ts`.
- Use `describe` blocks per module, `it` blocks per behavior.
- Prefix test descriptions with "should".
- Keep tests independent — no shared mutable state.

### 7. Add test scripts to package.json

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:e2e": "playwright test",
    "test:coverage": "vitest run --coverage"
  }
}
```

### 8. Configure CI integration

- Run unit + integration tests on every PR.
- Run E2E tests on merge to main or nightly.
- Fail PR if coverage drops below thresholds.
