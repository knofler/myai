/**
 * backfill-topics.ts — ADR-020 one-time topic backfill classification pass.
 *
 * Every atom written before 2026-07-24 carries no `topic:` frontmatter line, so
 * the distiller buckets it as 'general' and `brain_lookup`'s topic traversal can
 * only descend into newly-written atoms. This module closes that gap:
 *
 *   planTopicBackfill()   scan every atom (memory/ + repos/×/{sessions,handoffs}),
 *                         skip already-tagged ones, classify the rest against
 *                         BRAIN_TOPICS with a deterministic keyword heuristic.
 *   refinePlan()          optional second pass (the CLI wires `agents_invoke`
 *                         tier=budget here) for atoms the heuristic left ambiguous.
 *   applyTopicBackfill()  write `topic:` frontmatter IN PLACE on a dedicated
 *                         brain branch (default idea/topic-backfill) so the
 *                         operator reviews + `brain merge`s before it lands.
 *   renderBackfillReport() stable markdown classification table + a drift report
 *                         of atoms still untagged / ambiguously classified.
 *
 * Idempotent by construction: a tagged atom is skipped at scan time AND
 * re-checked in place at apply time, so re-running plan/apply after an apply is
 * a no-op (no second commit). The classification itself is deterministic (plain
 * token counting, no randomness, no timestamps in the report), so a dry-run
 * table is byte-stable across runs.
 *
 * In-place frontmatter edit is safe w.r.t. atom identity: the filename's
 * trailing sha8 hashes the atom BODY only (`sha8(input.content)` in writeAtom),
 * and the frontmatter is stripped before any body use — adding a `topic:` line
 * never invalidates a supersedes ref or a dedup check. This is the ONE
 * sanctioned exception to "never edit an existing atom": frontmatter metadata
 * only, body untouched, on a review branch, per ADR-020 §Remaining.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BRAIN_TOPICS, isBrainRepo, resolveBrainDir, slugify } from './brain.js';

// ── classification vocabulary ────────────────────────────────────────────────
// Deterministic keyword vocabulary per controlled topic (BRAIN_TOPICS minus
// 'general' — 'general' is what an atom STAYS when nothing here clears the
// confidence bar; it is never proposed). Hyphenated terms match adjacent word
// pairs ("wrap up" ⇒ wrap-up), so multiword phrases classify too.

const TOPIC_TERMS: Record<string, string[]> = {
  'runner-ops': ['runner', 'launchd', 'headless', 'queue', 'queued', 'schedule', 'scheduled', 'scheduling', 'dispatch', 'worktree', 'cron', 'task-queue', 'tasks-claim', 'cli-task-runner', 'overnight'],
  'cost-policy': ['cost', 'credit', 'credits', 'burn', 'thrift', 'spend', 'quota', 'token-budget', 'usage-guard', 'cost-policy', 'budget-guard', 'free-window'],
  'gateway-infra': ['gateway', 'docker', 'compose', 'container', 'containers', 'mongo', 'mongodb', 'atlas', 'mcp', 'rebuild', 'image', 'selfheal', 'infra', 'localhost-3100', 'port', 'healthcheck'],
  'go-live': ['launch', 'go-live', 'show-hn', 'landing', 'marketing', 'demo', 'public', 'release', 'released', 'publish', 'published', 'v0', 'tag'],
  'continuity': ['handoff', 'wrap-up', 'session-close', 'agent-mode', 'boot', 'archive', 'rotate', 'continuity', 'checkpoint', 'state-md', 'resume', 'catch-up'],
  'distribution': ['npm', 'package', 'install', 'installed', 'myai-init', 'setup', 'wizard', 'onboarding', 'template', 'templates', 'propagate', 'propagated', 'propagation', 'fleet', 'rollout', 'update-all', 'mirror', 'managed-repos'],
  'billing': ['stripe', 'invoice', 'invoices', 'checkout', 'subscription', 'payment', 'payments', 'billing', 'pricing', 'plan-tier', 'metering'],
  'brain': ['brain', 'atom', 'atoms', 'distill', 'distiller', 'brief-md', 'working-md', 'rollup', 'supersede', 'supersedes', 'supersession', 'namespace', 'medallion', 'brain-commit', 'brain-merge', 'brain-delta', 'brain-lookup', 'gold', 'silver', 'bronze'],
  'security': ['security', 'auth', 'secret', 'secrets', 'vulnerability', 'owasp', 'cve', 'leak', 'unauthorized', 'rbac', 'tenant-isolation', 'permission', 'permissions', 'cors', 'jwt', 'gitguardian'],
  'docs': ['readme', 'documentation', 'docs', 'changelog', 'showcase', 'guide', 'adr', 'tutorial', 'doc'],
};

/** Minimum winning score before a proposal is trusted at all. */
const MIN_SCORE = 3;
/** Minimum lead over the runner-up topic — below this the atom is ambiguous. */
const MIN_MARGIN = 2;
/** Per-term hit cap so one repeated word can't single-handedly win a topic. */
const TERM_CAP = 3;

export interface TopicScore {
  /** Winning BRAIN_TOPICS slug (never 'general' — that's the non-answer). */
  topic: string;
  score: number;
  runnerUp?: string;
  runnerUpScore: number;
  /** score − runnerUpScore. */
  margin: number;
  /** Clears MIN_SCORE + MIN_MARGIN → safe to auto-apply. */
  confident: boolean;
  /** 'heuristic' here; refinePlan() marks its winners 'llm'. */
  method: 'heuristic' | 'llm';
  /** Matched vocabulary terms for the winning topic (spot-check explainability). */
  terms: string[];
}

/**
 * Deterministic keyword classification of one atom's text (slug + body).
 * Pure token counting — same input, same output, no clock, no randomness.
 */
export function classifyTopic(text: string): TopicScore {
  const tokens = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const unigrams = new Map<string, number>();
  const bigrams = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    unigrams.set(tokens[i], (unigrams.get(tokens[i]) ?? 0) + 1);
    if (i + 1 < tokens.length) {
      const bg = `${tokens[i]}-${tokens[i + 1]}`;
      bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1);
    }
  }
  const scored = Object.entries(TOPIC_TERMS).map(([topic, terms]) => {
    let score = 0;
    const hits: string[] = [];
    for (const term of terms) {
      const n = term.includes('-') ? (bigrams.get(term) ?? 0) : (unigrams.get(term) ?? 0);
      if (n > 0) {
        score += Math.min(n, TERM_CAP);
        hits.push(term);
      }
    }
    return { topic, score, hits };
  }).sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic));

  const [top, second] = scored;
  const margin = top.score - (second?.score ?? 0);
  return {
    topic: top.topic,
    score: top.score,
    runnerUp: second?.score ? second.topic : undefined,
    runnerUpScore: second?.score ?? 0,
    margin,
    confident: top.score >= MIN_SCORE && margin >= MIN_MARGIN,
    method: 'heuristic',
    terms: hitsCapped(top.hits),
  };
}

function hitsCapped(hits: string[]): string[] {
  return hits.slice(0, 6);
}

// ── atom scanning ────────────────────────────────────────────────────────────

export interface ScannedAtom {
  /** Brain-repo-relative path. */
  path: string;
  kind: 'session' | 'handoff' | 'memory';
  /** Namespace ('' for cross-repo memory/ atoms). */
  ns: string;
  slug: string;
  /** Existing frontmatter topic, when the atom is already tagged. */
  topic?: string;
  body: string;
}

export type EntryStatus = 'tagged' | 'proposed' | 'ambiguous';

export interface BackfillEntry {
  atom: ScannedAtom;
  status: EntryStatus;
  /** Present for proposed AND ambiguous (the ambiguous best-guess aids spot-check). */
  score?: TopicScore;
}

export interface BackfillPlan {
  brainDir: string;
  /** Sorted by path — the stable ordering the report relies on. */
  entries: BackfillEntry[];
  counts: { total: number; tagged: number; proposed: number; ambiguous: number };
}

const FM_RE = /^---\n([\s\S]*?)\n---\n\n?/;

function parseAtomFile(raw: string): { topic?: string; slug?: string; body: string } {
  const fm = raw.match(FM_RE);
  if (!fm) return { body: raw.trim() };
  const head = fm[1];
  return {
    topic: head.match(/^topic:\s*(.+)$/m)?.[1].trim(),
    slug: head.match(/^slug:\s*(.+)$/m)?.[1].trim(),
    body: raw.slice(fm[0].length).trim(),
  };
}

function atomDirs(dir: string): Array<{ rel: string; kind: ScannedAtom['kind']; ns: string }> {
  const out: Array<{ rel: string; kind: ScannedAtom['kind']; ns: string }> = [
    { rel: 'memory', kind: 'memory', ns: '' },
  ];
  const reposDir = join(dir, 'repos');
  if (existsSync(reposDir)) {
    for (const e of readdirSync(reposDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      out.push({ rel: `repos/${e.name}/sessions`, kind: 'session', ns: e.name });
      out.push({ rel: `repos/${e.name}/handoffs`, kind: 'handoff', ns: e.name });
    }
  }
  return out;
}

/**
 * Scan every atom and classify the untagged ones. Read-only — never touches
 * the store. `repo` filters to one namespace (memory/ is always included).
 */
export function planTopicBackfill(
  opts: { repo?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): BackfillPlan {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) throw new Error(`brain: no brain repo at ${dir} — run 'myai brain init'`);
  const nsFilter = opts.repo ? slugify(opts.repo) : undefined;

  const entries: BackfillEntry[] = [];
  for (const d of atomDirs(dir)) {
    if (nsFilter && d.ns && d.ns !== nsFilter) continue;
    const abs = join(dir, d.rel);
    if (!existsSync(abs)) continue;
    for (const file of readdirSync(abs).filter((f) => f.endsWith('.md')).sort()) {
      const raw = readFileSync(join(abs, file), 'utf8');
      const parsed = parseAtomFile(raw);
      const atom: ScannedAtom = {
        path: `${d.rel}/${file}`,
        kind: d.kind,
        ns: d.ns,
        slug: parsed.slug ?? file.replace(/\.md$/, ''),
        topic: parsed.topic,
        body: parsed.body,
      };
      if (atom.topic) {
        entries.push({ atom, status: 'tagged' });
        continue;
      }
      const score = classifyTopic(`${atom.slug.replace(/-/g, ' ')} ${atom.body}`);
      entries.push({ atom, status: score.confident ? 'proposed' : 'ambiguous', score });
    }
  }
  entries.sort((a, b) => a.atom.path.localeCompare(b.atom.path));
  return {
    brainDir: dir,
    entries,
    counts: {
      total: entries.length,
      tagged: entries.filter((e) => e.status === 'tagged').length,
      proposed: entries.filter((e) => e.status === 'proposed').length,
      ambiguous: entries.filter((e) => e.status === 'ambiguous').length,
    },
  };
}

/**
 * Second-pass refinement for ambiguous entries via a caller-supplied
 * classifier (the CLI passes an `agents_invoke` tier=budget call). The
 * classifier must return a BRAIN_TOPICS slug or undefined; anything else is
 * discarded and the entry stays ambiguous (strict validation — a chatty LLM
 * reply can never introduce an off-taxonomy tag). Mutates + returns the plan.
 */
export async function refinePlan(
  plan: BackfillPlan,
  classify: (atom: ScannedAtom) => Promise<string | undefined>,
): Promise<BackfillPlan> {
  const valid = new Set<string>(BRAIN_TOPICS);
  for (const entry of plan.entries) {
    if (entry.status !== 'ambiguous') continue;
    let reply: string | undefined;
    try {
      reply = await classify(entry.atom);
    } catch {
      continue; // classifier unavailable → entry stays in the drift report
    }
    const t = reply ? slugify(reply) : '';
    if (t && t !== 'general' && valid.has(t)) {
      entry.status = 'proposed';
      entry.score = {
        topic: t,
        score: entry.score?.score ?? 0,
        runnerUp: entry.score?.runnerUp,
        runnerUpScore: entry.score?.runnerUpScore ?? 0,
        margin: entry.score?.margin ?? 0,
        confident: true,
        method: 'llm',
        terms: entry.score?.terms ?? [],
      };
    }
  }
  plan.counts.proposed = plan.entries.filter((e) => e.status === 'proposed').length;
  plan.counts.ambiguous = plan.entries.filter((e) => e.status === 'ambiguous').length;
  return plan;
}

// ── apply (in-place frontmatter tag on a review branch) ──────────────────────

export interface BackfillApplyResult {
  branch: string;
  /** Atom paths that gained a `topic:` line in this run. */
  updated: string[];
  /** Proposed atoms skipped because the branch copy is already tagged (idempotence). */
  alreadyTagged: string[];
  /** True when a commit was created (updated.length > 0). */
  committed: boolean;
  sha?: string;
}

function git(dir: string, ...args: string[]): string {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (res.error) throw new Error(`brain: git unavailable: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`brain: git ${args[0]} failed: ${(res.stderr || res.stdout || '').trim()}`);
  }
  return res.stdout.trim();
}

function gitOk(dir: string, ...args: string[]): boolean {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).status === 0;
}

/** Insert `topic: <t>` into an atom's frontmatter (after `slug:`, the writeAtom
 *  field order). Returns undefined when the file already has a topic (no-op). */
function tagFrontmatter(raw: string, topic: string): string | undefined {
  const fm = raw.match(FM_RE);
  if (!fm || /^topic:\s*.+$/m.test(fm[1])) return undefined;
  const lines = fm[1].split('\n');
  const slugIdx = lines.findIndex((l) => l.startsWith('slug:'));
  const insertAt = slugIdx >= 0 ? slugIdx + 1 : lines.length;
  lines.splice(insertAt, 0, `topic: ${topic}`);
  return `---\n${lines.join('\n')}\n---\n\n${raw.slice(fm[0].length)}`;
}

/**
 * Write the plan's proposed `topic:` tags in place on a dedicated brain branch
 * (created from main, or resumed) as ONE commit, then restore the original
 * checkout. Every file is re-read and re-checked on the branch before writing,
 * so a re-run over an already-applied branch is a clean no-op. Ambiguous atoms
 * are never written — they stay 'general' and appear in the drift report.
 */
export function applyTopicBackfill(
  plan: BackfillPlan,
  opts: { branch?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): BackfillApplyResult {
  const dir = plan.brainDir;
  if (!isBrainRepo(dir)) throw new Error(`brain: no brain repo at ${dir}`);
  const branch = opts.branch || 'idea/topic-backfill';
  if (!/^(idea|session)\//.test(branch)) {
    throw new Error(`brain: backfill branch must be idea/* or session/* (got '${branch}') — sessionMerge refuses anything else`);
  }
  if (git(dir, 'status', '--porcelain') !== '') {
    throw new Error('brain: working tree is dirty — refusing to backfill');
  }

  const original = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (gitOk(dir, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`)) {
    git(dir, 'checkout', '-q', branch);
  } else {
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'checkout', '-q', '-b', branch);
  }

  const updated: string[] = [];
  const alreadyTagged: string[] = [];
  try {
    for (const entry of plan.entries) {
      if (entry.status !== 'proposed' || !entry.score) continue;
      const abs = join(dir, entry.atom.path);
      if (!existsSync(abs)) continue; // atom absent on this branch — never invent one
      const tagged = tagFrontmatter(readFileSync(abs, 'utf8'), entry.score.topic);
      if (tagged === undefined) {
        alreadyTagged.push(entry.atom.path);
        continue;
      }
      writeFileSync(abs, tagged);
      updated.push(entry.atom.path);
    }
    if (updated.length) {
      git(dir, 'add', '-A');
      git(
        dir, 'commit', '-q', '-m',
        `brain(backfill): topic-tag ${updated.length} atom(s) — ADR-020 one-time classification pass`,
      );
    }
    return {
      branch,
      updated,
      alreadyTagged,
      committed: updated.length > 0,
      sha: git(dir, 'rev-parse', 'HEAD'),
    };
  } finally {
    if (original !== branch) git(dir, 'checkout', '-q', original);
  }
}

// ── report ───────────────────────────────────────────────────────────────────

/**
 * Deterministic markdown report: proposed-classification table + the drift
 * report (atoms still untagged / ambiguous, with best guess + why) + any
 * off-taxonomy topics already present. No timestamps — a dry-run re-run over
 * the same store is byte-identical (the stability contract the fixture test
 * asserts).
 */
export function renderBackfillReport(plan: BackfillPlan, opts: { mode?: string } = {}): string {
  const controlled = new Set<string>(BRAIN_TOPICS);
  const proposed = plan.entries.filter((e) => e.status === 'proposed');
  const ambiguous = plan.entries.filter((e) => e.status === 'ambiguous');
  const offTaxonomy = plan.entries.filter(
    (e) => e.status === 'tagged' && e.atom.topic && !controlled.has(slugify(e.atom.topic)),
  );

  const lines: string[] = [
    '# Brain topic backfill — classification report (ADR-020)',
    '',
    `Mode: ${opts.mode ?? 'dry-run'} · brain: ${plan.brainDir}`,
    '',
    '## Summary',
    '',
    `- atoms scanned: ${plan.counts.total}`,
    `- already tagged (skipped): ${plan.counts.tagged}`,
    `- proposed for tagging: ${plan.counts.proposed}`,
    `- ambiguous / left untagged: ${plan.counts.ambiguous}`,
    '',
  ];

  if (proposed.length) {
    lines.push(
      '## Proposed classifications',
      '',
      '| atom | kind | topic | score | margin | method | matched terms |',
      '|------|------|-------|-------|--------|--------|---------------|',
      ...proposed.map((e) =>
        `| ${e.atom.path} | ${e.atom.kind} | **${e.score!.topic}** | ${e.score!.score} | ${e.score!.margin} | ${e.score!.method} | ${e.score!.terms.join(', ')} |`,
      ),
      '',
    );
  }

  lines.push('## Drift report — atoms still untagged (distill as \'general\')', '');
  if (ambiguous.length) {
    lines.push(
      '| atom | kind | best guess | score | runner-up | why |',
      '|------|------|-----------|-------|-----------|-----|',
      ...ambiguous.map((e) => {
        const s = e.score!;
        const why = s.score < MIN_SCORE
          ? `score ${s.score} < ${MIN_SCORE}`
          : `margin ${s.margin} < ${MIN_MARGIN} (vs ${s.runnerUp ?? '—'})`;
        return `| ${e.atom.path} | ${e.atom.kind} | ${s.score ? s.topic : '—'} | ${s.score} | ${s.runnerUp ?? '—'} | ${why} |`;
      }),
      '',
      '_Spot-check these before merge — tag by hand (or re-run with `--llm`) or leave as general._',
      '',
    );
  } else {
    lines.push('_None — every atom is tagged or has a confident proposal._', '');
  }

  if (offTaxonomy.length) {
    lines.push(
      '## Off-taxonomy topics already present (consolidation candidates)',
      '',
      ...offTaxonomy.map((e) => `- ${e.atom.path} — \`${e.atom.topic}\``),
      '',
    );
  }
  return lines.join('\n');
}
