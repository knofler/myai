import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // E2E specs run under Playwright, not Vitest.
    exclude: ["**/node_modules/**", "**/tests/e2e/**", "**/.next/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Blueprint quality bar: 60% baseline (POWERHOUSE_BLUEPRINT.md §3).
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60,
      },
      exclude: [
        "**/node_modules/**",
        "**/tests/**",
        "**/*.config.*",
        "**/sentry.*.config.ts",
        "**/instrumentation.ts",
        "**/.next/**",
      ],
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
