#!/usr/bin/env tsx
/**
 * Benchmark: embedded ANN (AnnIndex) vs brute-force JS cosine, at 10k+ vectors.
 *
 * The local search path used to scan every candidate with a cosine loop on
 * every query. This measures the embedded ANN replacement: build cost (paid
 * once, then cached per filter signature in vector-store) and per-query latency
 * + recall@k against the exact ranking.
 *
 *   docker compose exec gateway node_modules/.bin/tsx bin/bench-vector-search.ts
 *   # or locally:  N=50000 npx tsx bin/bench-vector-search.ts
 *
 * Pure in-memory — no MongoDB required.
 */
import { AnnIndex, cosineSimilarity } from '../src/memory/vector-index.js';

const N = Number(process.env.N) || 10_000;     // corpus size
const DIMS = Number(process.env.DIMS) || 384;  // all-MiniLM-L6-v2 dimensions
const K = Number(process.env.K) || 10;
const QUERIES = Number(process.env.QUERIES) || 50;
const CLUSTER_FRAC = 0.2;                       // fraction near a planted cluster

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (Math.imul(a ^ (a >>> 15), 1 | a) + 0x6d2b79f5) | 0; return (a >>> 0) / 4294967296; };
}
const r = rng(42);
function randVec(): number[] {
  const v = new Array<number>(DIMS);
  for (let i = 0; i < DIMS; i++) v[i] = r() * 2 - 1;
  return v;
}

function now(): number { return Number(process.hrtime.bigint() / 1000n) / 1000; } // ms

console.log(`\n  Vector search benchmark — N=${N}, dims=${DIMS}, k=${K}, queries=${QUERIES}\n`);

// Build a corpus: a chunk of clustered vectors (so neighbours exist) + noise.
const centroid = randVec();
const rows: number[][] = [];
for (let i = 0; i < N; i++) {
  if (r() < CLUSTER_FRAC) {
    rows.push(centroid.map(x => x + (r() * 2 - 1) * 0.3));
  } else {
    rows.push(randVec());
  }
}
const queries = Array.from({ length: QUERIES }, () => centroid.map(x => x + (r() * 2 - 1) * 0.25));

// ── Brute-force cosine (the old path) ──────────────────
function bruteTopK(q: number[]): number[] {
  return rows
    .map((row, i) => ({ i, s: cosineSimilarity(q, row) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, K)
    .map(x => x.i);
}

let t = now();
const bruteResults = queries.map(bruteTopK);
const bruteMs = now() - t;

// ── Embedded ANN ───────────────────────────────────────
t = now();
const index = AnnIndex.build<number>(DIMS, rows.map((v, i) => ({ item: i, vector: v })),
  { tables: 12, bits: 16, exactThreshold: 512 });
const buildMs = now() - t;

t = now();
const annResults = queries.map(q => index.query(q, K).map(h => h.item));
const annMs = now() - t;

// ── Recall@k (ANN vs exact) ────────────────────────────
let recallSum = 0;
for (let i = 0; i < QUERIES; i++) {
  const truth = new Set(bruteResults[i]);
  recallSum += annResults[i].filter(x => truth.has(x)).length / K;
}
const recall = recallSum / QUERIES;

const brutePer = bruteMs / QUERIES;
const annPer = annMs / QUERIES;

console.log(`  brute-force cosine : ${bruteMs.toFixed(1)} ms total · ${brutePer.toFixed(3)} ms/query`);
console.log(`  embedded ANN build : ${buildMs.toFixed(1)} ms (one-off, then cached per filter signature)`);
console.log(`  embedded ANN query : ${annMs.toFixed(1)} ms total · ${annPer.toFixed(3)} ms/query`);
console.log(`  per-query speedup  : ${(brutePer / annPer).toFixed(1)}×`);
console.log(`  recall@${K}          : ${(recall * 100).toFixed(1)}%`);
const breakeven = buildMs / Math.max(brutePer - annPer, 1e-9);
console.log(`  build break-even   : ~${Math.ceil(breakeven)} queries (ANN wins beyond this within a TTL window)\n`);
