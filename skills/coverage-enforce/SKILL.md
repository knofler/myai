---
name: coverage-enforce
description: "Enforce test coverage thresholds — configure Istanbul/c8, set targets, integrate with CI, identify gaps, and create tasks for uncovered code. Triggers: coverage, test coverage, coverage report, coverage threshold, untested code"
---

# Coverage Enforce

Configure and enforce test coverage thresholds across the project.

## Tech Stack

Vitest + c8 (v8 provider) | Jest + Istanbul | lcov + html reports

## Playbook

### 1. Configure the coverage tool

**Vitest** — add to `vite.config.ts`:

```typescript
test: {
  coverage: {
    provider: 'v8',
    reporter: ['text', 'lcov', 'html'],
    include: ['src/**/*.ts'],
    exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
  },
}
```

**Jest** — add to `jest.config.ts`:

```typescript
collectCoverage: true,
coverageReporters: ['text', 'lcov', 'html'],
collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts'],
```

### 2. Set coverage thresholds

```typescript
thresholds: { statements: 80, branches: 75, functions: 80, lines: 80 }
```

- Critical modules (auth, payments): raise to 90%.

### 3. Add to CI pipeline

```yaml
- name: Run tests with coverage
  run: npm run test:coverage
```

- Fail the pipeline if coverage drops below thresholds.
- Optionally post coverage summary as a PR comment.

### 4. Identify uncovered code

- Open `coverage/index.html` for interactive report.
- Sort by lowest coverage; flag files at 0%.
- Look for untested branches (if/else, switch, ternary).

### 5. Create test tasks for gaps

- For each uncovered module: file path, current %, missing branches.
- Prioritize critical modules first.
- Track in project backlog or state/STATE.md.

### 6. Prevent coverage regression

- Use `--changedSince=main` (Jest) for local fast checks.
- Block merges if coverage on new code is below 90%.
