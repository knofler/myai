/**
 * brain-health.ts — composite brain health index (BRAIN health-score).
 *
 * Rolls up four independently-computable signals into ONE 0-100 score:
 *   - freshness      days since the last brain commit
 *   - coverage       namespaces that have atoms but whose brief/working is
 *                    still the uncompiled placeholder (ensureNamespace's
 *                    stub text) — a real "distill never ran / fell behind" gap
 *   - contradictions divergent-brain merge/reconcile events on main in a
 *                    trailing window (scripts/lib/brain.sh + distill.ts's
 *                    reconcileMain) — each one is two devices' memories that
 *                    had to be reconciled
 *   - recall         the recall_session eval harness's tracked hit-rate
 *                    baseline (src/eval/recall-baseline.json), when one exists
 *
 * Distinct from per-atom recall analytics (most-recalled atoms / a staleness
 * heatmap): this is ONE composite number meant to be watched over time, not a
 * breakdown. `computeBrainHealth` also appends a snapshot to a small on-disk
 * trend log — outside the brain git repo, since this is operational telemetry
 * about the brain, not brain content — so `myai brain status` and the
 * dashboard can render a trend line. Recording is throttled (one snapshot per
 * hour) so frequent status checks don't flood the trend with near-duplicate
 * points.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBrainRepo, myaiHome, resolveBrainDir } from './brain.js';

function git(dir: string, ...args: string[]): string {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : '';
}

export interface BrainHealthSignals {
  /** Days since the last brain commit (fractional). null when uninitialized/no commits yet. */
  freshnessDays: number | null;
  /** Namespaces with ≥1 atom whose brief.md or working.md is still the uncompiled placeholder. */
  coverageGaps: number;
  /** Namespaces considered for the coverage check. */
  namespaceTotal: number;
  /** Divergent-merge/reconcile events on brain main in the trailing window. */
  contradictionCount: number;
  /** Size (days) of the trailing window contradictionCount was computed over. */
  contradictionWindowDays: number;
  /** recall_session eval harness hit-rate@k in [0,1]; null when no baseline is available. */
  recallHitRate: number | null;
}

export interface BrainHealthSubscores {
  freshness: number;
  coverage: number;
  contradictions: number;
  /** null when recallHitRate is unavailable — excluded from the weighted composite, not assumed. */
  recall: number | null;
}

export type BrainHealthGrade = 'excellent' | 'good' | 'fair' | 'poor';

export interface BrainHealthScore {
  /** 0-100 composite. */
  score: number;
  grade: BrainHealthGrade;
  signals: BrainHealthSignals;
  subscores: BrainHealthSubscores;
  computedAt: string;
}

export interface BrainHealthSnapshot {
  at: string;
  score: number;
  grade: BrainHealthGrade;
}

const PLACEHOLDER_MARKER = 'Not compiled yet.';
const CONTRADICTION_WINDOW_DAYS = 30;
const FRESHNESS_HORIZON_DAYS = 21;
const CONTRADICTION_PENALTY_PER_EVENT = 10;
const DAY_MS = 86_400_000;

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

function countMdFiles(dir: string): number {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).length : 0;
}

function isUncompiledPlaceholder(path: string): boolean {
  if (!existsSync(path)) return true;
  try {
    return readFileSync(path, 'utf8').includes(PLACEHOLDER_MARKER);
  } catch {
    return true;
  }
}

/** Best-effort read of the recall_session eval harness's tracked baseline (git-tracked fixture,
 *  not per-tenant brain data) — resolves back to the source tree when run from compiled dist,
 *  mirroring run-recall-eval.ts's own dist/source resolution. Never throws. */
function defaultRecallHitRate(): number | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, '../eval/recall-baseline.json'),
      here.includes(`${'/'}dist${'/'}`) ? resolve(here, '../../src/eval/recall-baseline.json') : null,
    ].filter((p): p is string => Boolean(p));
    const path = candidates.find((p) => existsSync(p));
    if (!path) return null;
    const data = JSON.parse(readFileSync(path, 'utf8')) as { hitRate?: unknown };
    return typeof data.hitRate === 'number' ? data.hitRate : null;
  } catch {
    return null;
  }
}

/**
 * Gather the raw signals from the on-disk brain store + (optional) recall baseline. Read-only —
 * never mutates the brain repo.
 */
export function gatherBrainHealthSignals(
  env: NodeJS.ProcessEnv = process.env,
  opts: { recallHitRate?: number | null; now?: Date } = {},
): BrainHealthSignals {
  const recallHitRate = opts.recallHitRate !== undefined ? opts.recallHitRate : defaultRecallHitRate();
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) {
    return {
      freshnessDays: null,
      coverageGaps: 0,
      namespaceTotal: 0,
      contradictionCount: 0,
      contradictionWindowDays: CONTRADICTION_WINDOW_DAYS,
      recallHitRate,
    };
  }
  const now = opts.now ?? new Date();

  const lastCommitIso = git(dir, 'log', '-1', '--format=%cI');
  const freshnessDays = lastCommitIso
    ? Math.max(0, (now.getTime() - new Date(lastCommitIso).getTime()) / DAY_MS)
    : null;

  const reposDir = join(dir, 'repos');
  const nsNames = existsSync(reposDir)
    ? readdirSync(reposDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  let coverageGaps = 0;
  for (const ns of nsNames) {
    const nsDir = join(reposDir, ns);
    const atomCount = countMdFiles(join(nsDir, 'sessions')) + countMdFiles(join(nsDir, 'handoffs'));
    if (atomCount === 0) continue; // nothing written yet — not a gap, just unused
    if (isUncompiledPlaceholder(join(nsDir, 'brief.md')) || isUncompiledPlaceholder(join(nsDir, 'working.md'))) {
      coverageGaps++;
    }
  }

  const sinceIso = new Date(now.getTime() - CONTRADICTION_WINDOW_DAYS * DAY_MS).toISOString();
  const mergeLog = git(dir, 'log', 'main', '--merges', `--since=${sinceIso}`, '--format=%H');
  const contradictionCount = mergeLog ? mergeLog.split('\n').filter(Boolean).length : 0;

  return {
    freshnessDays,
    coverageGaps,
    namespaceTotal: nsNames.length,
    contradictionCount,
    contradictionWindowDays: CONTRADICTION_WINDOW_DAYS,
    recallHitRate,
  };
}

function gradeFor(score: number): BrainHealthGrade {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'fair';
  return 'poor';
}

/** Pure scoring — no I/O, so the weighting/grading can be unit tested without a git repo. */
export function scoreBrainHealth(signals: BrainHealthSignals, now: Date = new Date()): BrainHealthScore {
  const freshness = signals.freshnessDays === null
    ? 0
    : clamp(100 - (signals.freshnessDays / FRESHNESS_HORIZON_DAYS) * 100);

  const coverage = signals.namespaceTotal === 0
    ? 100
    : clamp(100 - (signals.coverageGaps / signals.namespaceTotal) * 100);

  const contradictions = clamp(100 - signals.contradictionCount * CONTRADICTION_PENALTY_PER_EVENT);

  const recall = signals.recallHitRate === null ? null : clamp(signals.recallHitRate * 100);

  const weighted: Array<{ value: number; weight: number }> = [
    { value: freshness, weight: 0.3 },
    { value: coverage, weight: 0.3 },
    { value: contradictions, weight: 0.2 },
  ];
  if (recall !== null) weighted.push({ value: recall, weight: 0.2 });
  const totalWeight = weighted.reduce((s, w) => s + w.weight, 0);
  const score = Math.round(weighted.reduce((s, w) => s + w.value * w.weight, 0) / totalWeight);

  return {
    score,
    grade: gradeFor(score),
    signals,
    subscores: {
      freshness: Math.round(freshness),
      coverage: Math.round(coverage),
      contradictions: Math.round(contradictions),
      recall: recall === null ? null : Math.round(recall),
    },
    computedAt: now.toISOString(),
  };
}

const HISTORY_MAX_ENTRIES = 180;
/** Don't append a new trend point more than once per hour — keeps frequent `status` calls from
 *  flooding the trend with near-duplicate points while still capturing real drift over time. */
const RECORD_THROTTLE_MS = 60 * 60 * 1000;

export function brainHealthHistoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(myaiHome(env), 'brain-health-history.jsonl');
}

export function readBrainHealthHistory(env: NodeJS.ProcessEnv = process.env, limit = 30): BrainHealthSnapshot[] {
  try {
    const path = brainHealthHistoryPath(env);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l) as BrainHealthSnapshot);
  } catch {
    return [];
  }
}

/** Append a trend snapshot (best-effort — never throws; broken/missing history must never break
 *  a health check). Throttled to one append per hour; always caps the file at the most recent
 *  HISTORY_MAX_ENTRIES lines. */
export function recordBrainHealthSnapshot(result: BrainHealthScore, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const home = myaiHome(env);
    mkdirSync(home, { recursive: true });
    const path = brainHealthHistoryPath(env);
    const existing = readBrainHealthHistory(env, 1);
    const last = existing[existing.length - 1];
    const now = new Date(result.computedAt).getTime();
    if (last && now - new Date(last.at).getTime() < RECORD_THROTTLE_MS) return;

    const snapshot: BrainHealthSnapshot = { at: result.computedAt, score: result.score, grade: result.grade };
    appendFileSync(path, `${JSON.stringify(snapshot)}\n`, 'utf8');
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    if (lines.length > HISTORY_MAX_ENTRIES) {
      writeFileSync(path, `${lines.slice(lines.length - HISTORY_MAX_ENTRIES).join('\n')}\n`, 'utf8');
    }
  } catch {
    // Trend history is best-effort telemetry — never fail the health check over it.
  }
}

export interface BrainHealth extends BrainHealthScore {
  /** Most recent recorded snapshots, oldest first (bounded by `historyLimit`, default 30). */
  history: BrainHealthSnapshot[];
}

/** Signals + score + trend, in one call — what the CLI (`myai brain status`) and the MCP/dashboard
 *  surface wire up. `record: false` computes the score without appending a trend point (e.g. for
 *  a read-only preview); default records (subject to the one-per-hour throttle above). */
export function computeBrainHealth(
  env: NodeJS.ProcessEnv = process.env,
  opts: { recallHitRate?: number | null; record?: boolean; now?: Date; historyLimit?: number } = {},
): BrainHealth {
  const signals = gatherBrainHealthSignals(env, opts);
  const result = scoreBrainHealth(signals, opts.now);
  if (opts.record !== false) recordBrainHealthSnapshot(result, env);
  return { ...result, history: readBrainHealthHistory(env, opts.historyLimit ?? 30) };
}
