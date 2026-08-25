/**
 * brain-search-eval — the `brain_search` (atom side) recall-quality eval
 * harness (BRAIN W3.2).
 *
 * `brain_search` (MCP tool) runs `federatedBrainSearch`, which merges two
 * rankers: the deterministic keyword-TF atom scan (`searchAtoms`, git-brain
 * side) and `recallSession` (Mongo-vector session-corpus side, already
 * benchmarked separately by `recall-eval.ts`/`recall-dataset.ts`). This
 * harness measures the atom side in isolation — it is fully deterministic and
 * needs no Mongo/gateway, so the numbers are reproducible in CI — by writing
 * a small fixture brain to a real temp git repo via the actual `writeAtom`
 * path and querying it with the actual `searchAtoms` path. Nothing here
 * mocks the retrieval logic itself; only the storage location is redirected.
 *
 * Deliberately reuses the pure IR metric primitives from `recall-metrics.ts`
 * and the report/baseline plumbing (`toBaseline`, `compareToBaseline`) from
 * `recall-eval.ts` instead of re-deriving them — this is the same
 * precision@k / recall@k / MRR / MAP contract as the session-corpus eval, just
 * pointed at a different retriever.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brainInit, writeAtom } from '../core/brain.js';
import { searchAtoms, type BrainSearchHit } from '../core/brain-search.js';
import {
  aggregate,
  bestThreshold,
  scoreQuery,
  sweepThresholds,
  type RankedHit,
} from './recall-metrics.js';
import { toBaseline, compareToBaseline, type Baseline, type EvalReport, type PerQueryReport } from './recall-eval.js';
import { BRAIN_SEARCH_DATASET, type BrainSearchDataset, type LabelledAtomQuery } from './brain-search-dataset.js';

export type { Baseline, EvalReport };

const DEFAULT_THRESHOLDS = [0, 1, 2, 3, 4, 5];

/** A fixture brain built on disk for one eval run, plus its teardown. */
export interface FixtureBrain {
  dir: string;
  env: NodeJS.ProcessEnv;
  /** atom repo-relative path → fixture slug, so hits can be graded against the gold set. */
  pathToSlug: Map<string, string>;
  cleanup: () => void;
}

/**
 * Write every fixture atom through the real `writeAtom` path into a brain
 * repo under a fresh tmpdir. Uses an isolated env object (never mutates
 * `process.env`) so this can run alongside other suites/processes safely.
 */
export function buildFixtureBrain(dataset: BrainSearchDataset = BRAIN_SEARCH_DATASET): FixtureBrain {
  const root = mkdtempSync(join(tmpdir(), 'brain-search-eval-'));
  const dir = join(root, 'brain');
  const env: NodeJS.ProcessEnv = { ...process.env, MYAI_HOME: join(root, 'home'), MYAI_BRAIN_DIR: dir, BRAIN_HOST: 'eval-host' };

  brainInit({ dir, pointer: false }, env);

  const pathToSlug = new Map<string, string>();
  for (const atom of dataset.atoms) {
    const result = writeAtom(
      { kind: atom.kind, repo: atom.repo ?? null, slug: atom.slug, content: atom.content, topic: atom.topic },
      env,
    );
    pathToSlug.set(result.path, atom.slug);
  }

  return {
    dir,
    env,
    pathToSlug,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Grade raw `searchAtoms` hits against the gold set: hit.path → fixture slug. */
function toRankedHits(hits: BrainSearchHit[], pathToSlug: Map<string, string>): RankedHit[] {
  return hits.map((h) => ({ id: (h.path && pathToSlug.get(h.path)) || h.path || '', score: h.score }));
}

export interface NoMatchResult {
  query: string;
  hitCount: number;
  falsePositive: boolean;
  topHit?: { id: string; score: number };
}

export interface BrainSearchEvalReport extends EvalReport {
  atomsScanned: number;
  noMatch: NoMatchResult[];
}

/**
 * Run the labelled query set through the live `searchAtoms` retriever against
 * a fixture brain and score every metric. `repo`-narrowed queries are honored
 * (searchAtoms({ repo })), matching how the MCP tool is actually called.
 */
export function runBrainSearchEval(
  fixture: FixtureBrain,
  dataset: BrainSearchDataset = BRAIN_SEARCH_DATASET,
  opts: { k?: number } = {},
): BrainSearchEvalReport {
  const k = opts.k ?? 5;

  const perQuery: PerQueryReport[] = [];
  const evaluated: Array<{ ranked: RankedHit[]; relevant: Set<string> }> = [];
  let atomsScanned = 0;

  for (const q of dataset.queries as LabelledAtomQuery[]) {
    const result = searchAtoms(q.query, { repo: q.repo, limit: k }, fixture.env);
    atomsScanned = Math.max(atomsScanned, result.atomsScanned);
    const retrieved = toRankedHits(result.hits, fixture.pathToSlug);
    const relevant = new Set(q.relevant);
    const metrics = scoreQuery(retrieved, relevant, k);
    perQuery.push({ query: q.query, relevant: q.relevant, retrieved, ...metrics });
    evaluated.push({ ranked: retrieved, relevant });
  }

  const agg = aggregate(perQuery, k);
  const sweep = sweepThresholds(evaluated, DEFAULT_THRESHOLDS, k);
  const best = bestThreshold(sweep);

  const noMatch: NoMatchResult[] = dataset.noMatchQueries.map((query) => {
    const result = searchAtoms(query, { limit: k }, fixture.env);
    const top = result.hits[0];
    return {
      query,
      hitCount: result.hits.length,
      falsePositive: result.hits.length > 0,
      topHit: top ? { id: (top.path && fixture.pathToSlug.get(top.path)) || top.path || '', score: top.score } : undefined,
    };
  });

  return {
    k,
    aggregate: agg,
    thresholdSweep: sweep,
    recommendedThreshold: best ? best.threshold : null,
    perQuery,
    atomsScanned,
    noMatch,
  };
}

/** Convenience: build the fixture, run the eval, tear the fixture down. */
export function evaluateBrainSearch(
  dataset: BrainSearchDataset = BRAIN_SEARCH_DATASET,
  opts: { k?: number } = {},
): BrainSearchEvalReport {
  const fixture = buildFixtureBrain(dataset);
  try {
    return runBrainSearchEval(fixture, dataset, opts);
  } finally {
    fixture.cleanup();
  }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** Render the eval report as markdown for humans / CI logs. */
export function renderBrainSearchReport(report: BrainSearchEvalReport): string {
  const a = report.aggregate;
  const lines: string[] = [];
  lines.push('# brain_search (searchAtoms) recall-quality baseline', '');
  lines.push(
    `Fixture atoms scanned: **${report.atomsScanned}** · queries: **${a.queries}** · cut-off: **k=${report.k}**`,
    '',
  );
  lines.push(
    'Scope: this measures the deterministic keyword-TF atom scan (`searchAtoms`) that ' +
      'the `brain_search` MCP tool federates with the session-corpus vector ranker ' +
      '(`recallSession`, benchmarked separately by `recall-eval.ts`). Retrieval behaviour ' +
      'is unchanged by this task — this is a measurement fixture, not a tuning pass.',
    '',
  );
  lines.push('## Aggregate metrics', '');
  lines.push('| metric | value |', '|---|---|');
  lines.push(`| precision@${report.k} | ${pct(a.meanPrecisionAtK)} |`);
  lines.push(`| recall@${report.k} | ${pct(a.meanRecallAtK)} |`);
  lines.push(`| MRR | ${a.mrr.toFixed(3)} |`);
  lines.push(`| MAP | ${a.map.toFixed(3)} |`);
  lines.push(`| hit-rate@${report.k} | ${pct(a.hitRate)} |`);
  lines.push('');
  lines.push('## Score-threshold sweep (min term-frequency score kept)', '');
  lines.push(
    `Recommended operating threshold (max mean-F1): **${
      report.recommendedThreshold === null ? 'n/a' : report.recommendedThreshold
    }**`,
    '',
  );
  lines.push('| threshold | precision | recall | F1 |', '|---|---|---|---|');
  for (const p of report.thresholdSweep) {
    const mark = p.threshold === report.recommendedThreshold ? ' ⬅' : '';
    lines.push(`| ${p.threshold} | ${pct(p.meanPrecision)} | ${pct(p.meanRecall)} | ${p.meanF1.toFixed(3)}${mark} |`);
  }
  lines.push('');
  lines.push('## Per-query', '');
  lines.push('| query | P@k | R@k | RR | top hit |', '|---|---|---|---|---|');
  for (const q of report.perQuery) {
    // Scores carry the age-decay multiplier (brain-search.ts) — round for the report.
    const top = q.retrieved[0] ? `${q.retrieved[0].id} (${Math.round(q.retrieved[0].score * 1000) / 1000})` : '—';
    lines.push(
      `| ${q.query} | ${pct(q.precisionAtK)} | ${pct(q.recallAtK)} | ${q.reciprocalRank.toFixed(2)} | ${top} |`,
    );
  }
  lines.push('');
  lines.push('## No-match sanity check (queries with zero correct atoms in the fixture)', '');
  lines.push(
    'Not part of the aggregate metrics above (precision/recall are undefined when the ' +
      'relevant set is empty) — a separate check that the retriever does not hallucinate hits.',
    '',
  );
  lines.push('| query | hits | false positive? | top hit |', '|---|---|---|---|');
  for (const n of report.noMatch) {
    const top = n.topHit ? `${n.topHit.id} (${Math.round(n.topHit.score * 1000) / 1000})` : '—';
    lines.push(`| ${n.query} | ${n.hitCount} | ${n.falsePositive ? '⚠️ YES' : 'no'} | ${top} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export { toBaseline, compareToBaseline };
