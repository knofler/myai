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
 *   - deltaBudget    brain_delta hard-budget auto-degrade events in a trailing
 *                    window (distill.ts's brainDelta, W2.2 task-f58ce4c4) —
 *                    each one is a raw delta that bloated past its budget and
 *                    had to be served capped instead, the condition W2.1 found
 *                    could otherwise silently cost tokens forever
 *   - recall         the recall_session eval harness's tracked hit-rate
 *                    baseline (src/eval/recall-baseline.json), when one exists
 *                    — a SYNTHETIC benchmark (W3.2), scored offline against a
 *                    hand-labelled gold set, not live usage
 *   - liveRecall     the LIVE recall hit-rate (W3.3, recall-telemetry.ts):
 *                    of the atoms actually surfaced to a real agent by
 *                    context_boot/brain_search, what fraction were
 *                    referenced again later in the session (offline-replayed
 *                    over the recall-event log per plan/BRAIN_BUILD_PLAN.md
 *                    B-7 — logging + a simple rate, NOT RL)
 *   - captureCoverage (W5.3, plan/BRAIN_V2_CAPTURE_AND_OFFLOAD.md W1/W5) the
 *                    fraction of sessions that actually produced a brain atom.
 *                    "Sessions" = the W1.1/W1.4 observation ring buffer
 *                    (scratch/observe/<repo>/<session>.jsonl, one file per
 *                    session with tool activity); "produced an atom" = a
 *                    session|session-auto|handoff atom landed in that repo's
 *                    namespace with a timestamp inside [session start, session
 *                    end + grace]. This is the number W1 (capture must not
 *                    depend on discipline) and its W1.2 auto-atom safety net
 *                    exist to keep near 100% — a drop means capture silently
 *                    failed (hook not firing, jq missing, gateway down for
 *                    brain_observe callers), not that nothing happened.
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
import { isBrainRepo, myaiHome, resolveBrainDir, slugify } from './brain.js';
import { computeLiveRecallHitRate } from './recall-telemetry.js';

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
  /** brain_delta hard-budget auto-degrade events in the trailing window (W2.2). */
  deltaDegradeCount: number;
  /** Size (days) of the trailing window deltaDegradeCount was computed over. */
  deltaDegradeWindowDays: number;
  /** recall_session eval harness hit-rate@k in [0,1]; null when no baseline is available. */
  recallHitRate: number | null;
  /** W3.3 live recall hit-rate (recall-telemetry.ts) in [0,1]; null when no event has
   *  resolved yet (log empty, or every event is still within its grace/lookahead window). */
  liveRecallHitRate: number | null;
  /** Resolved recall-telemetry events liveRecallHitRate was computed over — 0 when null. */
  liveRecallSampleSize: number;
  /** W5.3: fraction (0-1) of observed sessions (scratch/observe/) in the trailing window that
   *  produced a captured atom. Optional — omitted/undefined is treated the same as null (no
   *  sessions observed in the window, e.g. hooks never fired / fresh brain). */
  captureCoverage?: number | null;
  /** Observed sessions captureCoverage was computed over; 0 when captureCoverage is null. */
  captureCoverageSampleSize?: number;
  /** Size (days) of the trailing window session-observation was considered over. */
  captureCoverageWindowDays?: number;
}

export interface BrainHealthSubscores {
  freshness: number;
  coverage: number;
  contradictions: number;
  deltaBudget: number;
  /** null when recallHitRate is unavailable — excluded from the weighted composite, not assumed. */
  recall: number | null;
  /** null when liveRecallHitRate is unavailable — excluded from the weighted composite, not assumed. */
  liveRecall: number | null;
  /** null when captureCoverage is unavailable (no sessions observed) — excluded from the weighted composite, not assumed. */
  captureCoverage: number | null;
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
const DELTA_DEGRADE_WINDOW_DAYS = 30;
const FRESHNESS_HORIZON_DAYS = 21;
const CONTRADICTION_PENALTY_PER_EVENT = 10;
const DELTA_DEGRADE_PENALTY_PER_EVENT = 10;
const DAY_MS = 86_400_000;
/** Trailing window (days) sessions are considered "observed" over — shorter than the
 *  contradiction/delta-degrade windows since capture should be near-instant, not eventual. */
const CAPTURE_COVERAGE_WINDOW_DAYS = 7;
/** How long after a session's last observed tool call an atom is still credited to it — covers
 *  wrap-up running a few minutes after the last tool call, plus the W1.2 auto-atom Stop-hook fallback. */
const CAPTURE_COVERAGE_GRACE_MS = 2 * 60 * 60 * 1000;

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

interface ObservedSession {
  /** Raw scratch/observe/<repo> path segment (NOT slugified — see sanitizeObservePathSegment
   *  in brain.ts, which keeps case/underscores unlike writeAtom's slugify). */
  repo: string;
  firstTs: number;
  lastTs: number;
}

/** Parses an atom filename's leading `YYYYMMDDTHHMMSSZ-` timestamp (utcStamp() in brain.ts /
 *  _brain_utc in brain.sh). Returns null for anything that doesn't match (never throws). */
function parseAtomTimestamp(filename: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(filename);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

/** Timestamps of every session|session-auto|handoff atom written under a repo namespace
 *  (repos/<slug>/sessions + repos/<slug>/handoffs) — cheap filename parse, no git log needed
 *  since writeAtom/brain_atom_write both stamp the write time into the filename itself. */
function readAtomTimestamps(dir: string, repoSlug: string): number[] {
  const out: number[] = [];
  for (const subdir of ['sessions', 'handoffs']) {
    const nsDir = join(dir, 'repos', repoSlug, subdir);
    if (!existsSync(nsDir)) continue;
    let files: string[];
    try {
      files = readdirSync(nsDir);
    } catch {
      continue;
    }
    for (const f of files) {
      const t = parseAtomTimestamp(f);
      if (t !== null) out.push(t);
    }
  }
  return out;
}

/** Reads the W1.1/W1.4 observation ring buffer (scratch/observe/<repo>/<session>.jsonl) and
 *  returns one entry per non-empty session file whose activity overlaps the trailing window.
 *  Best-effort: a single malformed/unreadable file is skipped, never fatal. */
function readObservedSessions(dir: string, sinceMs: number): ObservedSession[] {
  const scratchDir = join(dir, 'scratch', 'observe');
  if (!existsSync(scratchDir)) return [];
  let repoDirs: string[];
  try {
    repoDirs = readdirSync(scratchDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out: ObservedSession[] = [];
  for (const repo of repoDirs) {
    const repoDir = join(scratchDir, repo);
    let files: string[];
    try {
      files = readdirSync(repoDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const lines = readFileSync(join(repoDir, f), 'utf8').split('\n').filter(Boolean);
        if (lines.length === 0) continue;
        const first = JSON.parse(lines[0]) as { ts?: string };
        const last = JSON.parse(lines[lines.length - 1]) as { ts?: string };
        const firstTs = first.ts ? new Date(first.ts).getTime() : NaN;
        if (!Number.isFinite(firstTs)) continue;
        const lastTsParsed = last.ts ? new Date(last.ts).getTime() : NaN;
        const lastTs = Number.isFinite(lastTsParsed) ? lastTsParsed : firstTs;
        if (lastTs < sinceMs) continue; // entirely outside the trailing window
        out.push({ repo, firstTs, lastTs });
      } catch {
        continue; // malformed/rotated-mid-read file — skip, don't fail the whole computation
      }
    }
  }
  return out;
}

/**
 * W5.3: fraction of observed sessions in the trailing window that produced a captured atom.
 * Correlates by TIME WINDOW, not session id (atoms don't carry one) — a session counts as
 * captured when ANY session|session-auto|handoff atom in its repo's namespace has a timestamp
 * within [session start, session end + grace]. Approximate for repos with many concurrent
 * sessions, but exact for the common case (one active session per repo at a time) and matches
 * the same time-window spirit hooks/stop/05-brain-autoatom.sh already uses for its own
 * "did a real atom already land" check.
 */
function computeCaptureCoverage(
  dir: string,
  now: Date,
): { coverage: number | null; sampleSize: number } {
  const sinceMs = now.getTime() - CAPTURE_COVERAGE_WINDOW_DAYS * DAY_MS;
  const observed = readObservedSessions(dir, sinceMs);
  if (observed.length === 0) return { coverage: null, sampleSize: 0 };

  const atomTsCache = new Map<string, number[]>();
  let captured = 0;
  for (const sess of observed) {
    const slug = slugify(sess.repo);
    let atomTs = atomTsCache.get(slug);
    if (!atomTs) {
      atomTs = readAtomTimestamps(dir, slug);
      atomTsCache.set(slug, atomTs);
    }
    const graceEnd = sess.lastTs + CAPTURE_COVERAGE_GRACE_MS;
    if (atomTs.some((t) => t >= sess.firstTs && t <= graceEnd)) captured++;
  }
  return { coverage: captured / observed.length, sampleSize: observed.length };
}

/**
 * Telemetry log for brain_delta's hard-budget auto-degrade (W2.2, distill.ts's
 * `brainDelta`): appended whenever a raw delta bloats past its budget and is
 * served capped instead — the condition that would otherwise silently cost
 * tokens forever (W2.1's finding). Lives outside the brain git repo, next to
 * `brain-health-history.jsonl`: operational telemetry ABOUT the brain, not
 * brain content, and it must survive being read back by a completely
 * separate process (the gateway serving `brain_delta`) than the one scoring
 * health — a plain append-only file, not in-memory state.
 */
export interface DeltaDegradeEvent {
  /** ISO timestamp of the degrade event. */
  at: string;
  /** Repo namespace the delta was scoped to, when known (unscoped calls omit it). */
  repo?: string;
  /** The raw (pre-degrade) token estimate that tripped the budget. */
  rawTokens: number;
  /** How it was degraded: to the compiled brief+working, or hard-truncated in place
   *  (no per-repo working set to fall back to — e.g. an unscoped/cross-repo delta). */
  mode: 'working' | 'hard';
}

const DELTA_DEGRADE_MAX_ENTRIES = 500;

export function deltaDegradeLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(myaiHome(env), 'brain-delta-degrade.jsonl');
}

/** Append a degrade event (best-effort — never throws; a metering failure must never break the
 *  brain_delta call it decorates). Bounded to the most recent DELTA_DEGRADE_MAX_ENTRIES lines. */
export function recordDeltaDegrade(event: DeltaDegradeEvent, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const home = myaiHome(env);
    mkdirSync(home, { recursive: true });
    const path = deltaDegradeLogPath(env);
    appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    if (lines.length > DELTA_DEGRADE_MAX_ENTRIES) {
      writeFileSync(path, `${lines.slice(lines.length - DELTA_DEGRADE_MAX_ENTRIES).join('\n')}\n`, 'utf8');
    }
  } catch {
    // Telemetry is best-effort — never let a metering failure break the caller's delta.
  }
}

export function readDeltaDegradeEvents(env: NodeJS.ProcessEnv = process.env): DeltaDegradeEvent[] {
  try {
    const path = deltaDegradeLogPath(env);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as DeltaDegradeEvent);
  } catch {
    return [];
  }
}

/**
 * Gather the raw signals from the on-disk brain store + (optional) recall baseline. Read-only —
 * never mutates the brain repo.
 */
export function gatherBrainHealthSignals(
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    recallHitRate?: number | null;
    liveRecallHitRate?: number | null;
    captureCoverage?: number | null;
    now?: Date;
  } = {},
): BrainHealthSignals {
  const recallHitRate = opts.recallHitRate !== undefined ? opts.recallHitRate : defaultRecallHitRate();
  let liveRecallHitRate: number | null;
  let liveRecallSampleSize = 0;
  if (opts.liveRecallHitRate !== undefined) {
    liveRecallHitRate = opts.liveRecallHitRate;
  } else {
    const live = computeLiveRecallHitRate(env, { now: opts.now });
    liveRecallHitRate = live.hitRate;
    liveRecallSampleSize = live.resolved;
  }
  const now = opts.now ?? new Date();
  const deltaDegradeSinceMs = now.getTime() - DELTA_DEGRADE_WINDOW_DAYS * DAY_MS;
  const deltaDegradeCount = readDeltaDegradeEvents(env)
    .filter((e) => new Date(e.at).getTime() >= deltaDegradeSinceMs).length;

  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) {
    return {
      freshnessDays: null,
      coverageGaps: 0,
      namespaceTotal: 0,
      contradictionCount: 0,
      contradictionWindowDays: CONTRADICTION_WINDOW_DAYS,
      deltaDegradeCount,
      deltaDegradeWindowDays: DELTA_DEGRADE_WINDOW_DAYS,
      recallHitRate,
      liveRecallHitRate,
      liveRecallSampleSize,
      captureCoverage: opts.captureCoverage !== undefined ? opts.captureCoverage : null,
      captureCoverageSampleSize: 0,
      captureCoverageWindowDays: CAPTURE_COVERAGE_WINDOW_DAYS,
    };
  }

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

  let captureCoverage: number | null;
  let captureCoverageSampleSize = 0;
  if (opts.captureCoverage !== undefined) {
    captureCoverage = opts.captureCoverage;
  } else {
    const capture = computeCaptureCoverage(dir, now);
    captureCoverage = capture.coverage;
    captureCoverageSampleSize = capture.sampleSize;
  }

  return {
    freshnessDays,
    coverageGaps,
    namespaceTotal: nsNames.length,
    contradictionCount,
    contradictionWindowDays: CONTRADICTION_WINDOW_DAYS,
    deltaDegradeCount,
    deltaDegradeWindowDays: DELTA_DEGRADE_WINDOW_DAYS,
    recallHitRate,
    liveRecallHitRate,
    liveRecallSampleSize,
    captureCoverage,
    captureCoverageSampleSize,
    captureCoverageWindowDays: CAPTURE_COVERAGE_WINDOW_DAYS,
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

  const deltaBudget = clamp(100 - signals.deltaDegradeCount * DELTA_DEGRADE_PENALTY_PER_EVENT);

  const recall = signals.recallHitRate === null ? null : clamp(signals.recallHitRate * 100);
  const liveRecall = signals.liveRecallHitRate === null ? null : clamp(signals.liveRecallHitRate * 100);
  const captureCoverage = signals.captureCoverage == null ? null : clamp(signals.captureCoverage * 100);

  const weighted: Array<{ value: number; weight: number }> = [
    { value: freshness, weight: 0.25 },
    { value: coverage, weight: 0.25 },
    { value: contradictions, weight: 0.15 },
    { value: deltaBudget, weight: 0.15 },
  ];
  if (recall !== null) weighted.push({ value: recall, weight: 0.2 });
  if (liveRecall !== null) weighted.push({ value: liveRecall, weight: 0.15 });
  if (captureCoverage !== null) weighted.push({ value: captureCoverage, weight: 0.15 });
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
      deltaBudget: Math.round(deltaBudget),
      recall: recall === null ? null : Math.round(recall),
      liveRecall: liveRecall === null ? null : Math.round(liveRecall),
      captureCoverage: captureCoverage === null ? null : Math.round(captureCoverage),
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
  opts: {
    recallHitRate?: number | null;
    liveRecallHitRate?: number | null;
    record?: boolean;
    now?: Date;
    historyLimit?: number;
  } = {},
): BrainHealth {
  const signals = gatherBrainHealthSignals(env, opts);
  const result = scoreBrainHealth(signals, opts.now);
  if (opts.record !== false) recordBrainHealthSnapshot(result, env);
  return { ...result, history: readBrainHealthHistory(env, opts.historyLimit ?? 30) };
}
