/**
 * recall-metrics — pure ranking-quality metrics for the recall_session eval
 * harness (RAG Phase B).
 *
 * These are retrieval-agnostic: given a ranked list of retrieved item ids and
 * the set of ids that are actually relevant for a query, they compute the
 * standard IR metrics used to *measure* (rather than guess) whether a
 * retrieval-threshold or chunking change helped or hurt.
 *
 * Nothing here touches the database, the embedding model, or the gateway — the
 * harness feeds these functions with whatever a retriever returned, so the same
 * numbers are reproducible in CI without any live infrastructure.
 */

/** A single scored hit returned by a retriever, top-ranked first. */
export interface RankedHit {
  /** Stable id of the retrieved session/block (matched against the label set). */
  id: string;
  /** Similarity score in [0,1] — used for threshold sweeps. */
  score: number;
}

/** Metrics for one query at a fixed cut-off k. */
export interface QueryMetrics {
  /** Fraction of the top-k hits that are relevant. */
  precisionAtK: number;
  /** Fraction of all relevant items that appear in the top-k. */
  recallAtK: number;
  /** Reciprocal rank of the first relevant hit (0 if none in the list). */
  reciprocalRank: number;
  /** Average precision over the ranked list (the per-query term of MAP). */
  averagePrecision: number;
  /** 1 if at least one relevant hit is in the top-k, else 0. */
  hitAtK: number;
  /** Number of relevant hits found in the top-k. */
  relevantInTopK: number;
}

/** Aggregate metrics across a labelled query set. */
export interface AggregateMetrics {
  queries: number;
  k: number;
  meanPrecisionAtK: number;
  meanRecallAtK: number;
  mrr: number;
  map: number;
  hitRate: number;
}

function topKIds(ranked: RankedHit[], k: number): string[] {
  return ranked.slice(0, k).map(h => h.id);
}

/** precision@k = (relevant items in top-k) / k. */
export function precisionAtK(ranked: RankedHit[], relevant: Set<string>, k: number): number {
  if (k <= 0) return 0;
  const hits = topKIds(ranked, k).filter(id => relevant.has(id)).length;
  return hits / k;
}

/** recall@k = (relevant items in top-k) / (total relevant items). */
export function recallAtK(ranked: RankedHit[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const hits = topKIds(ranked, k).filter(id => relevant.has(id)).length;
  return hits / relevant.size;
}

/** Reciprocal rank of the first relevant hit; 0 when none are retrieved. */
export function reciprocalRank(ranked: RankedHit[], relevant: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i].id)) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Average precision — mean of the precision values taken at each rank where a
 * relevant item appears. This is the per-query quantity averaged into MAP.
 */
export function averagePrecision(ranked: RankedHit[], relevant: Set<string>): number {
  if (relevant.size === 0) return 0;
  let hits = 0;
  let sum = 0;
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i].id)) {
      hits++;
      sum += hits / (i + 1);
    }
  }
  return hits === 0 ? 0 : sum / Math.min(relevant.size, ranked.length || relevant.size);
}

/** Harmonic mean of precision and recall; 0 when both are 0. */
export function f1(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/** All per-query metrics at cut-off k. */
export function scoreQuery(ranked: RankedHit[], relevant: Set<string>, k: number): QueryMetrics {
  const relevantInTopK = topKIds(ranked, k).filter(id => relevant.has(id)).length;
  return {
    precisionAtK: precisionAtK(ranked, relevant, k),
    recallAtK: recallAtK(ranked, relevant, k),
    reciprocalRank: reciprocalRank(ranked, relevant),
    averagePrecision: averagePrecision(ranked, relevant),
    hitAtK: relevantInTopK > 0 ? 1 : 0,
    relevantInTopK,
  };
}

/** Aggregate a set of per-query metrics into corpus-level numbers. */
export function aggregate(perQuery: QueryMetrics[], k: number): AggregateMetrics {
  const n = perQuery.length;
  if (n === 0) {
    return { queries: 0, k, meanPrecisionAtK: 0, meanRecallAtK: 0, mrr: 0, map: 0, hitRate: 0 };
  }
  const mean = (sel: (m: QueryMetrics) => number) => perQuery.reduce((s, m) => s + sel(m), 0) / n;
  return {
    queries: n,
    k,
    meanPrecisionAtK: mean(m => m.precisionAtK),
    meanRecallAtK: mean(m => m.recallAtK),
    mrr: mean(m => m.reciprocalRank),
    map: mean(m => m.averagePrecision),
    hitRate: mean(m => m.hitAtK),
  };
}

/** One row of a score-threshold sweep. */
export interface ThresholdPoint {
  threshold: number;
  meanPrecision: number;
  meanRecall: number;
  meanF1: number;
}

/**
 * Sweep a set of score thresholds. For each threshold we drop hits scoring
 * below it (as a real cut-off would), then average precision / recall / F1 over
 * every query — so the best operating threshold can be chosen from data instead
 * of guessed. `evaluated` pairs each query's full ranked list with its relevant
 * set.
 */
export function sweepThresholds(
  evaluated: Array<{ ranked: RankedHit[]; relevant: Set<string> }>,
  thresholds: number[],
  k: number,
): ThresholdPoint[] {
  return thresholds.map(threshold => {
    const rows = evaluated.map(({ ranked, relevant }) => {
      const kept = ranked.filter(h => h.score >= threshold);
      const p = precisionAtK(kept, relevant, k);
      const r = recallAtK(kept, relevant, k);
      return { p, r };
    });
    const n = rows.length || 1;
    const meanPrecision = rows.reduce((s, x) => s + x.p, 0) / n;
    const meanRecall = rows.reduce((s, x) => s + x.r, 0) / n;
    return {
      threshold,
      meanPrecision,
      meanRecall,
      meanF1: f1(meanPrecision, meanRecall),
    };
  });
}

/** Pick the threshold with the highest mean F1 (ties → lower threshold). */
export function bestThreshold(points: ThresholdPoint[]): ThresholdPoint | null {
  if (points.length === 0) return null;
  return points.reduce((best, p) => (p.meanF1 > best.meanF1 ? p : best), points[0]);
}
