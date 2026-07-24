/**
 * Vector search backend + embedded ANN index.
 *
 * Replaces the old brute-force JS cosine loop in `vector-store.ts` with two
 * scalable paths, selected per deployment:
 *
 *  - **Atlas ($vectorSearch)** — when the connection targets MongoDB Atlas, the
 *    ANN ranking runs server-side over the whole collection via the
 *    `$vectorSearch` aggregation stage (no fetch-all). See `buildVectorSearchStage`.
 *  - **Embedded ANN (local)** — when there is no Atlas (local `mongo:7`, CI,
 *    self-hosted), `AnnIndex` provides an in-process random-projection LSH index
 *    so repeated queries over the same corpus are sublinear instead of O(n·d)
 *    on every call. Small corpora fall back to an exact scan (identical results
 *    to the old loop) so accuracy is never sacrificed below the threshold.
 *
 * Both paths keep tenant isolation in the PRE-filter (ADR-010 §1.5 #3): the
 * Atlas stage pins `tenantId` inside `$vectorSearch.filter` (plus a defensive
 * trailing `$match`), and the local index is only ever built from
 * tenant-scoped candidates fetched through `scoped-query`.
 */
import { getConfig } from '../shared/config.js';

export type VectorBackend = 'atlas' | 'local';

/**
 * Decide which search backend to use. `VECTOR_BACKEND=atlas|local` forces a
 * choice (useful for tests / staged rollout); otherwise we sniff the Mongo URI
 * — an `mongodb+srv://` scheme or an `*.mongodb.net` host means Atlas.
 */
export function detectVectorBackend(uri?: string): VectorBackend {
  const override = (process.env.VECTOR_BACKEND || '').trim().toLowerCase();
  if (override === 'atlas' || override === 'local') return override;
  const u = uri ?? getConfig().database.uri ?? '';
  return /mongodb\+srv:\/\//i.test(u) || /\.mongodb\.net/i.test(u) ? 'atlas' : 'local';
}

/** Cosine similarity for two (not necessarily normalized) vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Dot product of two equal-length vectors (used on pre-normalized rows). */
function dot(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

/** Return a unit-length copy of `v` (zero vector returned unchanged). */
function normalize(v: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v.slice();
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** Deterministic PRNG (mulberry32) — stable hyperplanes across processes. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One standard-normal sample via Box–Muller (for random hyperplanes). */
function gaussian(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Fields the Atlas `$vectorSearch` filter may pin (besides tenantId). */
export interface AtlasFilterOpts {
  repo?: string;
  source?: string;
  tags?: string[];
  since?: Date;
}

/** Atlas Vector Search index name (configurable for staged rollout). */
export function atlasVectorIndexName(): string {
  return process.env.VECTOR_SEARCH_INDEX || 'vector_index';
}

/**
 * Build the Atlas `$vectorSearch` aggregation pipeline. Tenant isolation is
 * pinned inside the pre-`filter` (ADR-010 §1.5 #3 — the filter runs BEFORE ANN
 * ranking) AND re-asserted by a trailing `$match` so a mis-configured index can
 * never leak across tenants. `$vectorSearch` must be the first stage, so the
 * tenant scope cannot be a leading `$match`.
 */
export function buildAtlasVectorSearchPipeline(
  tenantId: string,
  queryVector: number[],
  limit: number,
  filter: AtlasFilterOpts,
  numCandidates?: number,
): Record<string, unknown>[] {
  const f: Record<string, unknown> = { tenantId };
  if (filter.repo) f.repo = filter.repo;
  if (filter.source) f.source = filter.source;
  if (filter.tags && filter.tags.length > 0) f.tags = { $in: filter.tags };
  if (filter.since) f.createdAt = { $gte: filter.since };

  return [
    {
      $vectorSearch: {
        index: atlasVectorIndexName(),
        path: 'embedding',
        queryVector,
        numCandidates: numCandidates ?? Math.max(limit * 20, 200),
        limit,
        filter: f,
      },
    },
    { $match: { tenantId } },
    {
      $project: {
        _id: 0,
        repo: 1,
        source: 1,
        content: 1,
        tags: 1,
        sessionId: 1,
        metadata: 1,
        createdAt: 1,
        contentHash: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ];
}

export interface AnnHit<T> { item: T; score: number; }

export interface AnnIndexOptions {
  /** Number of independent LSH hash tables (more → higher recall, more memory). */
  tables?: number;
  /** Hyperplane bits per table (more → finer buckets, lower recall per table). */
  bits?: number;
  /** Below this row count we skip LSH entirely and scan exactly. */
  exactThreshold?: number;
  /** RNG seed for reproducible hyperplanes. */
  seed?: number;
}

/**
 * In-memory approximate nearest-neighbour index over cosine similarity, built
 * with sign-random-projection LSH. Dependency-free and deterministic.
 *
 * Build is O(n · tables · bits · d); a query touches only the rows that collide
 * with the query in at least one table, then exact-reranks that shortlist — so
 * query cost is roughly O(shortlist · d) ≪ O(n · d) once n is large.
 */
export class AnnIndex<T = number> {
  private readonly tables: number;
  private readonly bits: number;
  private readonly exactThreshold: number;
  private readonly dims: number;
  /** Random hyperplanes: [table][bit][dim]. */
  private readonly planes: number[][][];
  /** Bucket maps per table: hashKey -> row indices. */
  private readonly buckets: Array<Map<string, number[]>>;
  private readonly rows: number[][] = [];   // normalized vectors
  private readonly items: T[] = [];

  constructor(dims: number, opts: AnnIndexOptions = {}) {
    this.dims = dims;
    this.tables = opts.tables ?? 8;
    this.bits = opts.bits ?? 16;
    this.exactThreshold = opts.exactThreshold ?? 512;
    const rng = mulberry32(opts.seed ?? 0x9e3779b9);
    this.planes = Array.from({ length: this.tables }, () =>
      Array.from({ length: this.bits }, () =>
        Array.from({ length: dims }, () => gaussian(rng)),
      ),
    );
    this.buckets = Array.from({ length: this.tables }, () => new Map<string, number[]>());
  }

  get size(): number { return this.rows.length; }

  /** Add one row. Vectors are normalized on insert so query = dot product. */
  add(item: T, vector: number[]): void {
    const idx = this.rows.length;
    const unit = normalize(vector);
    this.rows.push(unit);
    this.items.push(item);
    if (this.rows.length > this.exactThreshold) {
      for (let t = 0; t < this.tables; t++) {
        const key = this.hash(t, unit);
        const arr = this.buckets[t].get(key);
        if (arr) arr.push(idx); else this.buckets[t].set(key, [idx]);
      }
    }
  }

  /** Build an index from an array of items in one pass. */
  static build<T>(dims: number, entries: Array<{ item: T; vector: number[] }>, opts?: AnnIndexOptions): AnnIndex<T> {
    const index = new AnnIndex<T>(dims, opts);
    // Once we cross the exact threshold we must index the rows added while
    // still below it, so bucket membership is complete.
    let crossed = false;
    for (const e of entries) {
      const wasBelow = index.rows.length <= index.exactThreshold;
      index.add(e.item, e.vector);
      if (!crossed && wasBelow && index.rows.length > index.exactThreshold) {
        crossed = true;
        index.reindexAll();
      }
    }
    return index;
  }

  private reindexAll(): void {
    for (let t = 0; t < this.tables; t++) this.buckets[t].clear();
    for (let i = 0; i < this.rows.length; i++) {
      for (let t = 0; t < this.tables; t++) {
        const key = this.hash(t, this.rows[i]);
        const arr = this.buckets[t].get(key);
        if (arr) arr.push(i); else this.buckets[t].set(key, [i]);
      }
    }
  }

  private hash(table: number, unit: number[]): string {
    const planes = this.planes[table];
    let key = '';
    for (let b = 0; b < this.bits; b++) key += dot(planes[b], unit) >= 0 ? '1' : '0';
    return key;
  }

  /**
   * Top-`k` rows by cosine similarity. Exact scan below the threshold; above it,
   * gather LSH bucket collisions across tables, widen by 1-bit Hamming
   * neighbours if the shortlist is thin, then exact-rerank the shortlist.
   */
  query(vector: number[], k: number): Array<AnnHit<T>> {
    if (k <= 0 || this.rows.length === 0) return [];
    const q = normalize(vector);

    let candidateIdx: number[];
    if (this.rows.length <= this.exactThreshold) {
      candidateIdx = this.rows.map((_, i) => i);
    } else {
      const seen = new Set<number>();
      for (let t = 0; t < this.tables; t++) {
        const key = this.hash(t, q);
        const exact = this.buckets[t].get(key);
        if (exact) for (const i of exact) seen.add(i);
      }
      // Thin shortlist → widen with 1-bit-flip neighbour buckets.
      if (seen.size < k * 8) {
        for (let t = 0; t < this.tables && seen.size < k * 8; t++) {
          const key = this.hash(t, q);
          for (let b = 0; b < this.bits && seen.size < k * 8; b++) {
            const flipped = key.slice(0, b) + (key[b] === '1' ? '0' : '1') + key.slice(b + 1);
            const arr = this.buckets[t].get(flipped);
            if (arr) for (const i of arr) seen.add(i);
          }
        }
      }
      // Still empty (pathological) → fall back to an exact scan for correctness.
      candidateIdx = seen.size === 0 ? this.rows.map((_, i) => i) : Array.from(seen);
    }

    const scored = candidateIdx.map(i => ({ item: this.items[i], score: dot(q, this.rows[i]) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}
