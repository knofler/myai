/**
 * run-brain-search-eval — CLI entry for the `brain_search` (searchAtoms) eval
 * harness (BRAIN W3.2).
 *
 *   tsx src/eval/run-brain-search-eval.ts            # run + write report + baseline
 *   tsx src/eval/run-brain-search-eval.ts --check    # run + fail (exit 1) on regression vs baseline
 *
 * Outputs land under `state/reports/` (repo root) rather than next to the
 * harness code — this is a project-state artifact (a baseline other sessions
 * read), not a source file.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateBrainSearch, renderBrainSearchReport, toBaseline, compareToBaseline, type Baseline } from './brain-search-eval.js';
import { BRAIN_SEARCH_DATASET } from './brain-search-dataset.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE is runtime/src/eval (source) or runtime/dist/eval (build) — both two
// levels below runtime/, so '../..' reaches runtime/ either way; one more
// level up is the repo root.
const REPO_ROOT = resolve(HERE, '../../..');
const OUT_DIR = resolve(REPO_ROOT, 'state/reports');
const REPORT_PATH = resolve(OUT_DIR, 'brain-search-recall-benchmark.md');
const BASELINE_PATH = resolve(OUT_DIR, 'brain-search-recall-baseline.json');

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const check = argv.includes('--check');

  const report = evaluateBrainSearch(BRAIN_SEARCH_DATASET, { k: 5 });
  const markdown = renderBrainSearchReport(report);
  const baseline = toBaseline(report);

  if (check) {
    if (!existsSync(BASELINE_PATH)) {
      console.error(`No baseline at ${BASELINE_PATH} — run without --check first.`);
      return 1;
    }
    const stored = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
    const result = compareToBaseline(report, stored);
    console.log(markdown);
    if (result.improvements.length) {
      console.log('\nImprovements (refresh the baseline):');
      for (const i of result.improvements) console.log(`  + ${i}`);
    }
    if (!result.passed) {
      console.error('\n❌ BRAIN_SEARCH RECALL REGRESSION:');
      for (const r of result.regressions) console.error(`  - ${r}`);
      return 1;
    }
    console.log('\n✅ No recall regression vs baseline.');
    return 0;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, markdown);
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(markdown);
  console.log(`\nReport   → ${REPORT_PATH}`);
  console.log(`Baseline → ${BASELINE_PATH}`);
  return 0;
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code));
}
