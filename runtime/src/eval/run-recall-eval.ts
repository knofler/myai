/**
 * run-recall-eval — CLI entry for the recall_session eval harness.
 *
 *   tsx src/eval/run-recall-eval.ts            # run + write report + baseline
 *   tsx src/eval/run-recall-eval.ts --check    # run + fail (exit 1) on regression vs baseline
 *
 * Runs the labelled dataset through the deterministic lexical retriever so the
 * numbers are reproducible with no gateway / Mongo / model. Writes (both
 * git-tracked so the baseline is a real regression fixture):
 *   src/eval/recall-report.md      — human-readable report snapshot
 *   src/eval/recall-baseline.json  — tracked regression baseline
 *
 * To measure the *real* embedding pipeline instead, point a
 * `recallSessionRetriever` at a populated store — see recall-eval.ts.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECALL_DATASET } from './recall-dataset.js';
import {
  runRecallEval,
  lexicalRetriever,
  renderReport,
  toBaseline,
  compareToBaseline,
  type Baseline,
} from './recall-eval.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Tracked outputs live next to the dataset. When run from dist/eval, resolve
// back to the source tree so the committed baseline is the one updated.
const OUT_DIR = HERE.includes(`${'/'}dist${'/'}`) ? resolve(HERE, '../../src/eval') : HERE;
const REPORT_PATH = resolve(OUT_DIR, 'recall-report.md');
const BASELINE_PATH = resolve(OUT_DIR, 'recall-baseline.json');

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const check = argv.includes('--check');

  const report = await runRecallEval(RECALL_DATASET, lexicalRetriever(RECALL_DATASET.corpus), { k: 5 });
  const markdown = renderReport(report);
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
      console.error('\n❌ RECALL REGRESSION:');
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
