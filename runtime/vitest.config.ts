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
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/**', 'src/shared/logger.ts'],
    },
  },
});
