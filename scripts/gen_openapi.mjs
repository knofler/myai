#!/usr/bin/env node
/**
 * gen_openapi.mjs — regenerate the committed OpenAPI document for the docs site.
 *
 * Single source of truth for the spec is buildOpenApiSpec() in
 * runtime/src/core/openapi.ts (the same builder GET /api/openapi.json serves).
 * This script materialises it to docs/reference/openapi.json — the file the
 * static docs site (Redoc, scripts/build_docs.mjs) and integrators download.
 *
 * The builder is TypeScript, so we load it via the compiled dist when present
 * (runtime/dist/core/openapi.js) and fall back to the runtime's tsx to import
 * the source directly. Either path yields the identical pure object.
 *
 *   node scripts/gen_openapi.mjs            # write docs/reference/openapi.json
 *   node scripts/gen_openapi.mjs --check    # exit 1 if the committed file is stale
 *
 * Drift is guarded two ways in CI: scripts/tests/test_openapi_drift.sh asserts
 * the committed doc stays in sync with the route table + the source path list
 * (hermetic, no build), and runtime/tests/unit/openapi.test.ts asserts it
 * deep-equals buildOpenApiSpec().
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(REPO_ROOT, 'runtime', 'dist', 'core', 'openapi.js');
const SRC = path.join(REPO_ROOT, 'runtime', 'src', 'core', 'openapi.ts');
const OUT = path.join(REPO_ROOT, 'docs', 'reference', 'openapi.json');

async function loadSpec() {
  // Prefer the compiled dist — no toolchain needed.
  if (fs.existsSync(DIST)) {
    const mod = await import(pathToFileURL(DIST).href);
    if (typeof mod.buildOpenApiSpec === 'function') return mod.buildOpenApiSpec();
  }
  // Fallback: import the TS source through the runtime's tsx loader and print
  // the JSON on stdout (a child process so the loader hook is scoped to it).
  const tsx = path.join(REPO_ROOT, 'runtime', 'node_modules', '.bin', 'tsx');
  if (!fs.existsSync(tsx)) {
    throw new Error(
      'Cannot build the spec: runtime/dist is absent and runtime/node_modules/.bin/tsx is missing.\n' +
      'Run `cd runtime && npm run build` (or `npm ci`) first.',
    );
  }
  const code =
    `import { buildOpenApiSpec } from ${JSON.stringify(pathToFileURL(SRC).href)};` +
    `process.stdout.write(JSON.stringify(buildOpenApiSpec()));`;
  const json = execFileSync(tsx, ['-e', code], { cwd: REPO_ROOT, encoding: 'utf8' });
  return JSON.parse(json);
}

function serialise(spec) {
  return JSON.stringify(spec, null, 2) + '\n';
}

const spec = await loadSpec();
const next = serialise(spec);
const check = process.argv.includes('--check');

if (check) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== next) {
    console.error(
      `✗ ${path.relative(REPO_ROOT, OUT)} is stale.\n` +
      '  Regenerate it with: node scripts/gen_openapi.mjs',
    );
    process.exit(1);
  }
  console.log(`✓ ${path.relative(REPO_ROOT, OUT)} is in sync with buildOpenApiSpec().`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, next);
  const paths = Object.keys(spec.paths || {}).length;
  console.log(`wrote ${path.relative(REPO_ROOT, OUT)} — ${paths} paths, OpenAPI ${spec.openapi}`);
}
