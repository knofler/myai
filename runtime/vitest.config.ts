import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    // node_modules_test/ is a snapshot of vendor test files used for ad-hoc
    // debugging; exclude it so vitest doesn't try to run 140+ stray test files.
    exclude: ['node_modules/**', 'node_modules_test/**', 'dist/**'],
    globals: true,
    environment: 'node',
    testTimeout: 10000,
    hookTimeout: 10000,
    setupFiles: ['tests/setup.ts'],
    // task-93da7411 (2026-09-03): re-triaged the 6 gateway vitest suites several
    // commit messages had been waving through as "pre-existing env-dependent
    // failures, not from this change" (fleet-overview, obfuscate, brain-gc,
    // security-pass-day9, recall-session, totp-mfa). Verified in Docker (git
    // installed, full repo root mounted): 5 of the 6 pass clean — the
    // recall-session/obfuscate vector-store drift, the fleet-overview shape
    // mismatch, and the totp-mfa timing flake described in an earlier version of
    // this comment no longer reproduce (fixed upstream without the comment or the
    // `test:coverage --exclude` list ever being cleaned up — exactly the kind of
    // stale doc this re-triage exists to kill). The `--exclude` flags on
    // `test:coverage` are gone; all 6 now run under coverage like everything
    // else. Only tests/unit/brain-gc.test.ts has a REAL env dependency (needs the
    // `git` binary — present on every real dev/CI/production image, see
    // Dockerfile) and now self-skips via `describe.skipIf` when git is absent,
    // instead of throwing an unhandled error out of beforeAll.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/**', 'src/shared/logger.ts'],
      // Baseline re-measured 2026-08-28 (`npm run test:coverage`, node:22 image
      // with git installed — several tests spawn `git` subprocesses and
      // misreport as failures on a git-less image): all files 80.02%
      // stmts/lines, 83.87% branch, 86.52% funcs (up from the 2026-07-26
      // baseline of 74.66/82.59/82.58). Thresholds below are raised one notch
      // — a few points under the new measured baseline, globally and per
      // top-level src/ directory — so real regressions keep failing CI without
      // the gate being so tight that normal churn trips it. Directories that
      // are near-zero today (unused/aspirational integrations — channels,
      // hooks/builtin, rules, scripts, ws) stay floored at their prior value,
      // not zero, so newly-added dead weight there still can't drop further —
      // they're intentionally excluded from this notch-up since "current
      // value" for them hasn't materially changed.
      // rbac.ts / task-store.ts / router.ts get tighter per-file floors — they
      // gate RBAC, task persistence, and LLM routing, the highest-blast-radius
      // modules in runtime/src.
      thresholds: {
        statements: 76,
        lines: 76,
        functions: 83,
        branches: 82,

        'src/agents/**': { lines: 78, functions: 83, branches: 78 },
        'src/analytics/**': { lines: 97, functions: 97, branches: 93 },
        'src/channels/**': { lines: 4, functions: 10, branches: 70 },
        'src/connectors/**': { lines: 84, functions: 74, branches: 88 },
        'src/core/**': { lines: 76, functions: 91, branches: 80 },
        'src/eval/**': { lines: 87, functions: 98, branches: 89 },
        'src/hooks/**': { lines: 40, functions: 70, branches: 76 },
        'src/llm/**': { lines: 75, functions: 82, branches: 88 },
        'src/marketplace/**': { lines: 95, functions: 95, branches: 92 },
        'src/mcp/**': { lines: 70, functions: 50, branches: 60 },
        'src/memory/**': { lines: 55, functions: 60, branches: 83 },
        'src/monitoring/**': { lines: 89, functions: 94, branches: 85 },
        'src/notifications/**': { lines: 92, functions: 94, branches: 86 },
        'src/repos/**': { lines: 75, functions: 85, branches: 77 },
        'src/rules/**': { lines: 0, functions: 0, branches: 0 },
        'src/scheduler/**': { lines: 93, functions: 98, branches: 85 },
        'src/scripts/**': { lines: 0, functions: 90, branches: 90 },
        'src/shared/**': { lines: 80, functions: 76, branches: 78 },
        'src/tasks/**': { lines: 93, functions: 95, branches: 83 },
        'src/tools/**': { lines: 89, functions: 85, branches: 73 },
        'src/tracing/**': { lines: 75, functions: 77, branches: 90 },
        'src/webhooks/**': { lines: 67, functions: 55, branches: 88 },
        'src/ws/**': { lines: 0, functions: 0, branches: 0 },

        // Tighter floors — critical modules (RBAC, task persistence, LLM router).
        'src/core/rbac.ts': { lines: 97, functions: 100, branches: 86 },
        'src/tasks/task-store.ts': { lines: 92, functions: 93, branches: 83 },
        'src/llm/router.ts': { lines: 98, functions: 100, branches: 94 },
      },
    },
  },
});
