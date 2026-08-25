/**
 * recall-analytics.ts — per-atom recall analytics over the W3.3 telemetry log
 * (task-4a02c21b).
 *
 * recall-telemetry.ts records WHICH refs each recall surface (context_boot /
 * brain_search / brain_delta) actually served. This module is the breakdown
 * brain_health deliberately is NOT (its description says so): it joins that
 * event log against a filesystem scan of the atom store and answers three
 * questions the one-number health index can't —
 *
 *   1. MOST-RECALLED  which atoms/sessions are actually used (recall counts,
 *      per-tool split, chosen-vs-candidate, first/last recalled)
 *   2. STALENESS HEATMAP  atom age × last-recall recency buckets, so "old and
 *      still recalled" (load-bearing) separates from "old and cold" (fading)
 *   3. DEAD ATOMS  atoms never surfaced by ANY recall call, older than a
 *      minimum age, unpinned — the never-read tail that turns the brain from
 *      a write-only log into a prunable store
 *
 * The dead-atom list is exported as a gc-actionable report: repo-relative
 * atom paths in exactly the format `BrainGcPlan` uses, so `brain gc` (or the
 * operator) can review and prune. Detection is deliberately conservative —
 * pinned atoms are excluded (they are load-bearing by declaration, recalled
 * or not), atoms younger than `minDeadAgeDays` are excluded (too fresh to
 * judge), and an empty telemetry log yields NO candidates (no observations ≠
 * evidence of death). This module never mutates anything: read-only over the
 * events log + a directory walk; brainGc stays the only pruning path.
 *
 * Attribution contract: every atom filename ends in `-<sha8>.md` and every
 * atom-level recall ref (brain_delta atom paths, brain_search hit paths)
 * embeds that filename, so refs are matched by extracting `-<sha8>.md`
 * tokens. Refs that carry no atom filename (compiled brief/working, vector
 * snippets) attribute to no atom — correct, they aren't atom recalls.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listPins, resolveBrainDir, slugify, type AtomKind } from './brain.js';
import { readRecallEvents, type RecallTool } from './recall-telemetry.js';

export interface RecallAnalyticsOptions {
  /** Scope atoms to one repo namespace (repos/<ns>/ only; cross-repo memory/
   *  atoms are included only in the unscoped report). */
  repo?: string;
  /** Max most-recalled rows returned (default 20). */
  topLimit?: number;
  /** Max dead-atom detail rows returned (default 50; gc.candidatePaths is
   *  always the full list). */
  deadLimit?: number;
  /** Never-recalled atoms younger than this many days are NOT dead — too
   *  fresh to judge (default 14). */
  minDeadAgeDays?: number;
  /** Injectable clock for tests. */
  now?: Date;
}

export interface RecalledAtomStat {
  path: string;
  repo: string;
  kind: AtomKind;
  slug: string;
  sha8: string;
  /** Events this atom was surfaced in (each event counts once). */
  recalls: number;
  /** Events where the atom made the narrower `chosen` set, not just candidates. */
  chosenCount: number;
  firstRecalledAt: string;
  lastRecalledAt: string;
  /** Per-surface split (context_boot / brain_search / brain_delta). */
  tools: Partial<Record<RecallTool, number>>;
}

export interface StalenessHeatmap {
  /** Atom-age buckets (rows). */
  rowLabels: string[];
  /** Last-recall recency buckets (cols); final col is 'never'. */
  colLabels: string[];
  /** cells[row][col] = atom count. */
  cells: number[][];
  /** Atoms bucketed (excludes atoms whose written stamp didn't parse). */
  totalAtoms: number;
  /** Atoms skipped for an unparseable written stamp. */
  unknownAge: number;
}

export interface DeadAtom {
  path: string;
  repo: string;
  kind: AtomKind;
  slug: string;
  sha8: string;
  written: string;
  ageDays: number;
}

export interface RecallGcReport {
  /** Repo-relative atom paths, the exact format BrainGcPlan uses — review
   *  before pruning; brainGc never deletes these automatically. */
  candidatePaths: string[];
  /** Never-recalled atoms excluded because they are pinned. */
  excludedPinned: number;
  /** Never-recalled atoms excluded as younger than minDeadAgeDays. */
  excludedFresh: number;
  note: string;
}

export interface RecallAnalyticsReport {
  available: boolean;
  reason?: string;
  generatedAt: string;
  /** Scope applied to the atom scan ('' = whole store). */
  repo: string;
  atomsScanned: number;
  /** Distinct scanned atoms with ≥1 recall attribution. */
  recalledAtoms: number;
  /** Whole-log event summary (events are not repo-filtered — attribution is). */
  events: { total: number; resolved: number; byTool: Record<string, number>; observedSince: string | null };
  topAtoms: RecalledAtomStat[];
  staleness: StalenessHeatmap;
  deadAtoms: DeadAtom[];
  /** Full dead count (deadAtoms rows are capped by deadLimit). */
  deadTotal: number;
  gc: RecallGcReport;
}

const DEFAULT_TOP_LIMIT = 20;
const DEFAULT_DEAD_LIMIT = 50;
const DEFAULT_MIN_DEAD_AGE_DAYS = 14;
const DAY_MS = 86_400_000;

/** Age buckets shared by heatmap rows and (plus 'never') cols. */
const BUCKETS: Array<{ label: string; maxDays: number }> = [
  { label: '≤7d', maxDays: 7 },
  { label: '8-30d', maxDays: 30 },
  { label: '31-90d', maxDays: 90 },
  { label: '>90d', maxDays: Infinity },
];

function bucketIndex(days: number): number {
  return BUCKETS.findIndex((b) => days <= b.maxDays);
}

/** Parse the brain's UTC stamp (YYYYMMDDTHHMMSSZ) to a Date, or null. */
function parseWritten(stamp: string): Date | null {
  const m = stamp.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface ScannedAtom {
  path: string;
  file: string;
  kind: AtomKind;
  repo: string;
  slug: string;
  sha8: string;
  writtenStamp: string;
  writtenAt: Date | null;
}

const SHA_TAIL = /-([0-9a-f]{8})\.md$/;

/** Read-only directory walk of the atom store (memory/ + repos/<ns>/{sessions,handoffs}). */
function scanAtoms(dir: string, repoScope?: string): ScannedAtom[] {
  const targets: Array<{ rel: string; kind: AtomKind; repo: string }> = [];
  if (!repoScope) targets.push({ rel: 'memory', kind: 'memory', repo: '' });
  const reposDir = join(dir, 'repos');
  if (existsSync(reposDir)) {
    for (const e of readdirSync(reposDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (repoScope && e.name !== repoScope) continue;
      targets.push({ rel: `repos/${e.name}/sessions`, kind: 'session', repo: e.name });
      targets.push({ rel: `repos/${e.name}/handoffs`, kind: 'handoff', repo: e.name });
    }
  }

  const out: ScannedAtom[] = [];
  for (const t of targets) {
    const abs = join(dir, t.rel);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs).sort()) {
      if (!f.endsWith('.md') || f === '.gitkeep') continue;
      const shaMatch = f.match(SHA_TAIL);
      if (!shaMatch) continue;
      // Frontmatter read (slug/written can't be derived from the filename —
      // host and slug both contain dashes); filename ts prefix is the fallback.
      let slug = '';
      let written = '';
      try {
        const raw = readFileSync(join(abs, f), 'utf8');
        slug = raw.match(/^slug: (.+)$/m)?.[1].trim() ?? '';
        written = raw.match(/^written: (.+)$/m)?.[1].trim() ?? '';
      } catch {
        // Unreadable atom → filename-derived fields only.
      }
      if (!written) written = f.match(/^(\d{8}T\d{6}Z)-/)?.[1] ?? '';
      out.push({
        path: `${t.rel}/${f}`,
        file: f,
        kind: t.kind,
        repo: t.repo,
        slug: slug || f.replace(/\.md$/, ''),
        sha8: shaMatch[1],
        writtenStamp: written,
        writtenAt: parseWritten(written),
      });
    }
  }
  return out;
}

interface ShaStat {
  recalls: number;
  chosenCount: number;
  first: number;
  last: number;
  tools: Partial<Record<RecallTool, number>>;
}

/** Extract every `-<sha8>.md` atom-filename token embedded in a ref. */
function shasInRef(ref: string): string[] {
  return [...ref.matchAll(/-([0-9a-f]{8})\.md\b/g)].map((m) => m[1]);
}

/**
 * Compute the per-atom recall analytics report. Read-only and best-effort in
 * the same posture as the telemetry it reads: an unreadable store yields
 * `available: false`, never a throw into the tool call.
 */
export function computeRecallAnalytics(
  opts: RecallAnalyticsOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): RecallAnalyticsReport {
  const now = opts.now ?? new Date();
  const generatedAt = now.toISOString();
  const repoScope = opts.repo ? slugify(opts.repo) : undefined;
  const topLimit = Math.max(1, Math.trunc(opts.topLimit ?? DEFAULT_TOP_LIMIT));
  const deadLimit = Math.max(1, Math.trunc(opts.deadLimit ?? DEFAULT_DEAD_LIMIT));
  const minDeadAgeDays = Math.max(0, opts.minDeadAgeDays ?? DEFAULT_MIN_DEAD_AGE_DAYS);

  const empty = (reason: string): RecallAnalyticsReport => ({
    available: false,
    reason,
    generatedAt,
    repo: repoScope ?? '',
    atomsScanned: 0,
    recalledAtoms: 0,
    events: { total: 0, resolved: 0, byTool: {}, observedSince: null },
    topAtoms: [],
    staleness: {
      rowLabels: BUCKETS.map((b) => b.label),
      colLabels: [...BUCKETS.map((b) => b.label), 'never'],
      cells: BUCKETS.map(() => new Array(BUCKETS.length + 1).fill(0)),
      totalAtoms: 0,
      unknownAge: 0,
    },
    deadAtoms: [],
    deadTotal: 0,
    gc: { candidatePaths: [], excludedPinned: 0, excludedFresh: 0, note: reason },
  });

  try {
    const dir = resolveBrainDir(env);
    if (!existsSync(join(dir, 'BRAIN.md'))) return empty(`no brain store at ${dir}`);

    const atoms = scanAtoms(dir, repoScope);
    const events = readRecallEvents(env);

    // ── attribution: event refs → content sha8 → atoms ──────────────────────
    const bySha = new Map<string, ShaStat>();
    const byTool: Record<string, number> = {};
    let resolved = 0;
    let observedSince: string | null = null;
    for (const ev of events) {
      byTool[ev.tool] = (byTool[ev.tool] ?? 0) + 1;
      if (ev.used !== null) resolved++;
      if (!observedSince || ev.at < observedSince) observedSince = ev.at;
      const atMs = new Date(ev.at).getTime();
      if (Number.isNaN(atMs)) continue;
      const candShas = new Set(ev.candidates.flatMap(shasInRef));
      const chosenShas = new Set(ev.chosen.flatMap(shasInRef));
      for (const sha of new Set([...candShas, ...chosenShas])) {
        const s = bySha.get(sha) ?? { recalls: 0, chosenCount: 0, first: atMs, last: atMs, tools: {} };
        s.recalls++;
        if (chosenShas.has(sha)) s.chosenCount++;
        s.first = Math.min(s.first, atMs);
        s.last = Math.max(s.last, atMs);
        s.tools[ev.tool] = (s.tools[ev.tool] ?? 0) + 1;
        bySha.set(sha, s);
      }
    }

    // ── join: scanned atoms × attribution ────────────────────────────────────
    const recalled: RecalledAtomStat[] = [];
    const neverRecalled: ScannedAtom[] = [];
    for (const a of atoms) {
      const s = bySha.get(a.sha8);
      if (s) {
        recalled.push({
          path: a.path,
          repo: a.repo,
          kind: a.kind,
          slug: a.slug,
          sha8: a.sha8,
          recalls: s.recalls,
          chosenCount: s.chosenCount,
          firstRecalledAt: new Date(s.first).toISOString(),
          lastRecalledAt: new Date(s.last).toISOString(),
          tools: s.tools,
        });
      } else {
        neverRecalled.push(a);
      }
    }
    recalled.sort((x, y) => y.recalls - x.recalls || y.lastRecalledAt.localeCompare(x.lastRecalledAt));

    // ── staleness heatmap: atom age × last-recall recency ────────────────────
    const rowLabels = BUCKETS.map((b) => b.label);
    const colLabels = [...BUCKETS.map((b) => b.label), 'never'];
    const cells = BUCKETS.map(() => new Array(colLabels.length).fill(0));
    const NEVER_COL = colLabels.length - 1;
    let bucketed = 0;
    let unknownAge = 0;
    const lastBySha = new Map(recalled.map((r) => [r.sha8, r.lastRecalledAt]));
    for (const a of atoms) {
      if (!a.writtenAt) { unknownAge++; continue; }
      const ageDays = (now.getTime() - a.writtenAt.getTime()) / DAY_MS;
      const row = bucketIndex(Math.max(0, ageDays));
      const lastAt = lastBySha.get(a.sha8);
      const col = lastAt ? bucketIndex(Math.max(0, (now.getTime() - new Date(lastAt).getTime()) / DAY_MS)) : NEVER_COL;
      cells[row][col]++;
      bucketed++;
    }

    // ── dead atoms → gc-actionable report ────────────────────────────────────
    // No observations ≠ evidence of death: an empty telemetry log produces no
    // candidates at all rather than declaring the whole store dead.
    const pinned = new Set(listPins(env).map((p) => p.sha8));
    const dead: DeadAtom[] = [];
    let excludedPinned = 0;
    let excludedFresh = 0;
    if (events.length > 0) {
      for (const a of neverRecalled) {
        const ageDays = a.writtenAt ? Math.floor((now.getTime() - a.writtenAt.getTime()) / DAY_MS) : null;
        if (pinned.has(a.sha8)) { excludedPinned++; continue; }
        if (ageDays === null || ageDays < minDeadAgeDays) { excludedFresh++; continue; }
        dead.push({ path: a.path, repo: a.repo, kind: a.kind, slug: a.slug, sha8: a.sha8, written: a.writtenStamp, ageDays });
      }
      dead.sort((x, y) => y.ageDays - x.ageDays || x.path.localeCompare(y.path));
    }

    return {
      available: true,
      generatedAt,
      repo: repoScope ?? '',
      atomsScanned: atoms.length,
      recalledAtoms: recalled.length,
      events: { total: events.length, resolved, byTool, observedSince },
      topAtoms: recalled.slice(0, topLimit),
      staleness: { rowLabels, colLabels, cells, totalAtoms: bucketed, unknownAge },
      deadAtoms: dead.slice(0, deadLimit),
      deadTotal: dead.length,
      gc: {
        candidatePaths: dead.map((d) => d.path),
        excludedPinned,
        excludedFresh,
        note: events.length === 0
          ? 'telemetry log is empty — no recall observations yet, so no atom can be judged dead'
          : `never-recalled unpinned atoms ≥${minDeadAgeDays}d old; review before pruning — brain gc does not delete these automatically`,
      },
    };
  } catch (err) {
    return empty(`recall analytics failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
