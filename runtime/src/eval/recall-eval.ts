/**
 * recall-eval — the recall_session recall-quality eval harness (RAG Phase B).
 *
 * Runs a labelled query set through a retriever, scores precision@k / recall@k
 * / MRR / MAP, sweeps score thresholds to find the best operating point, and
 * emits a markdown report plus a machine-readable regression baseline. This is
 * what lets a threshold or chunking change be *measured* rather than guessed.
 *
 * The harness is retriever-agnostic: `runRecallEval` takes a `Retriever`
 * function. Two are provided —
 *   - `lexicalRetriever`  : dependency-free bag-of-words cosine over an
 *                           in-memory corpus. Deterministic, runs anywhere
 *                           (CI, headless), used for the default baseline.
 *   - `recallSessionRetriever` : adapter over the live vector-store
 *                           `recallSession` primitive, for measuring the real
 *                           embedding pipeline when a store is available.
 */
import {
  aggregate,
  bestThreshold,
  scoreQuery,
  sweepThresholds,
  type AggregateMetrics,
  type QueryMetrics,
  type RankedHit,
  type ThresholdPoint,
} from './recall-metrics.js';
import type { CorpusDoc, LabelledQuery, RecallDataset } from './recall-dataset.js';

/** Given a query and a cut-off, return ranked hits (top first). */
export type Retriever = (query: string, k: number) => Promise<RankedHit[]>;

export interface EvalOptions {
  k?: number;
  thresholds?: number[];
}

export interface PerQueryReport extends QueryMetrics {
  query: string;
  relevant: string[];
  retrieved: RankedHit[];
}

export interface EvalReport {
  k: number;
  aggregate: AggregateMetrics;
  thresholdSweep: ThresholdPoint[];
  recommendedThreshold: number | null;
  perQuery: PerQueryReport[];
}

const DEFAULT_THRESHOLDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/** Run the labelled query set through a retriever and score every metric. */
export async function runRecallEval(
  dataset: RecallDataset,
  retriever: Retriever,
  opts: EvalOptions = {},
): Promise<EvalReport> {
  const k = opts.k ?? 5;
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;

  const perQuery: PerQueryReport[] = [];
  const evaluated: Array<{ ranked: RankedHit[]; relevant: Set<string> }> = [];

  for (const q of dataset.queries) {
    const retrieved = await retriever(q.query, k);
    const relevant = new Set(q.relevant);
    const metrics = scoreQuery(retrieved, relevant, k);
    perQuery.push({ query: q.query, relevant: q.relevant, retrieved, ...metrics });
    evaluated.push({ ranked: retrieved, relevant });
  }

  const agg = aggregate(perQuery, k);
  const sweep = sweepThresholds(evaluated, thresholds, k);
  const best = bestThreshold(sweep);

  return {
    k,
    aggregate: agg,
    thresholdSweep: sweep,
    recommendedThreshold: best ? best.threshold : null,
    perQuery,
  };
}

// ── Retrievers ───────────────────────────────────────────

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'is', 'with']);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP.has(t));
}

function termVector(tokens: string[]): Map<string, number> {
  const v = new Map<string, number>();
  for (const t of tokens) v.set(t, (v.get(t) ?? 0) + 1);
  return v;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  for (const [t, w] of a) dot += w * (b.get(t) ?? 0);
  const norm = (m: Map<string, number>) => Math.sqrt([...m.values()].reduce((s, w) => s + w * w, 0));
  const denom = norm(a) * norm(b);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Deterministic bag-of-words cosine retriever over an in-memory corpus. No
 * model, no DB — so the baseline is reproducible in CI. Not a stand-in for the
 * real embedding pipeline's semantic quality, but it exercises the full harness
 * and gives threshold tuning a real score distribution to sweep.
 */
export function lexicalRetriever(corpus: CorpusDoc[]): Retriever {
  const indexed = corpus.map(doc => ({ id: doc.id, vec: termVector(tokenize(doc.content)) }));
  return async (query: string, k: number): Promise<RankedHit[]> => {
    const qv = termVector(tokenize(query));
    return indexed
      .map(d => ({ id: d.id, score: Math.round(cosine(qv, d.vec) * 1000) / 1000 }))
      .filter(h => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  };
}

/**
 * Adapter over the live `recallSession` vector-store primitive. Use this to
 * measure the real embedding pipeline when a Mongo-backed store is populated.
 * `sessionId` is the join key against the label set.
 */
export function recallSessionRetriever(
  recall: (opts: { query: string; k?: number; repo?: string }) => Promise<Array<{ sessionId: string; score: number }>>,
  repo?: string,
): Retriever {
  return async (query: string, k: number): Promise<RankedHit[]> => {
    const results = await recall({ query, k, repo });
    return results.map(r => ({ id: r.sessionId, score: r.score }));
  };
}

// ── Report rendering ─────────────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** Render the eval report as markdown for humans / CI logs. */
export function renderReport(report: EvalReport, title = 'recall_session recall-quality eval'): string {
  const a = report.aggregate;
  const lines: string[] = [];
  lines.push(`# ${title}`, '');
  lines.push(`Queries: **${a.queries}** · cut-off: **k=${report.k}**`, '');
  lines.push('## Aggregate metrics', '');
  lines.push('| metric | value |', '|---|---|');
  lines.push(`| precision@${report.k} | ${pct(a.meanPrecisionAtK)} |`);
  lines.push(`| recall@${report.k} | ${pct(a.meanRecallAtK)} |`);
  lines.push(`| MRR | ${a.mrr.toFixed(3)} |`);
  lines.push(`| MAP | ${a.map.toFixed(3)} |`);
  lines.push(`| hit-rate@${report.k} | ${pct(a.hitRate)} |`);
  lines.push('');
  lines.push('## Threshold sweep', '');
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
    const top = q.retrieved[0] ? `${q.retrieved[0].id} (${q.retrieved[0].score})` : '—';
    lines.push(
      `| ${q.query} | ${pct(q.precisionAtK)} | ${pct(q.recallAtK)} | ${q.reciprocalRank.toFixed(2)} | ${top} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

// ── Regression baseline ──────────────────────────────────

export interface Baseline {
  k: number;
  meanPrecisionAtK: number;
  meanRecallAtK: number;
  mrr: number;
  map: number;
  hitRate: number;
  recommendedThreshold: number | null;
}

/** Extract the durable numbers we track for regressions. */
export function toBaseline(report: EvalReport): Baseline {
  const a = report.aggregate;
  return {
    k: report.k,
    meanPrecisionAtK: round3(a.meanPrecisionAtK),
    meanRecallAtK: round3(a.meanRecallAtK),
    mrr: round3(a.mrr),
    map: round3(a.map),
    hitRate: round3(a.hitRate),
    recommendedThreshold: report.recommendedThreshold,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface RegressionResult {
  passed: boolean;
  regressions: string[];
  improvements: string[];
}

/**
 * Compare a fresh report against a stored baseline. A metric that drops by more
 * than `tolerance` (default 2 points) is a regression → `passed=false`. Any
 * metric that rises past tolerance is reported as an improvement (baseline
 * should be refreshed). Threshold change alone is informational, never a fail.
 */
export function compareToBaseline(report: EvalReport, baseline: Baseline, tolerance = 0.02): RegressionResult {
  const current = toBaseline(report);
  const metrics: Array<keyof Baseline> = ['meanPrecisionAtK', 'meanRecallAtK', 'mrr', 'map', 'hitRate'];
  const regressions: string[] = [];
  const improvements: string[] = [];

  for (const m of metrics) {
    const cur = current[m] as number;
    const base = baseline[m] as number;
    const delta = cur - base;
    if (delta < -tolerance) {
      regressions.push(`${m}: ${base.toFixed(3)} → ${cur.toFixed(3)} (${delta.toFixed(3)})`);
    } else if (delta > tolerance) {
      improvements.push(`${m}: ${base.toFixed(3)} → ${cur.toFixed(3)} (+${delta.toFixed(3)})`);
    }
  }

  return { passed: regressions.length === 0, regressions, improvements };
}
