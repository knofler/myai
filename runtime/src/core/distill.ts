/**
 * distill.ts — compile-at-write distiller + diff-since-SHA delta (BRAIN B3).
 *
 * `brain_merge` (wrap up) triggers a distill pass that regenerates the
 * compiled artifacts CHECKED INTO brain main as plain files:
 *
 *   repos/<ns>/brief.md    boot brief (~150 tok) — what a blank agent boots from
 *   repos/<ns>/working.md  working context (~2k tok) — latest handoff + recent sessions
 *   repos/<ns>/rollup.md   one-line-per-atom index of the namespace's history
 *
 * The distiller is EXTRACTIVE and deterministic — plain string work over the
 * append-only atoms, no LLM call — so it costs ZERO interactive tokens and can
 * run anywhere (gateway after a merge, the runner, a laptop with no provider).
 * Reading the brain needs NO server: the artifacts are plain files on main
 * (git pull → read files), which is the degraded/offline read path.
 *
 * `brainDelta` is the diff-only catch-up (plan §4): an agent remembers its
 * last-seen brain SHA and asks "what changed since <sha>" → a ~300–800 token
 * delta (new atoms + recompiled brief) instead of a full re-boot. A blank
 * agent (no SHA) gets the ~150-token brief.
 *
 * Token budgets are expressed in chars at ~4 chars/token.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { brainRemoteUrl, brainSyncPull, brainSyncWarning, isBrainRepo, myaiHome, resolveBrainDir, sha8, slugify, writeAtom } from './brain.js';
import type { BrainLogEntry } from './brain.js';
import { recordDeltaDegrade } from './brain-health.js';
import { SYSTEM_CONTEXT } from './tenant-context.js';
import { getEmbeddingProvider } from '../memory/embeddings.js';
import { cosineSimilarity } from '../memory/vector-index.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'brain-lookup' });

// ── char budgets (~4 chars/token) ────────────────────────────────────────────

/** brief.md — ~150 tokens (GOLD: current-status one-liner + topic TOC). */
const BRIEF_CHARS = 600;
/** GOLD current-status one-liner cap (the "current branch/blockers" line). */
const BRIEF_ONELINE_CHARS = 280;
/** working.md — ~2k tokens (SILVER: latest handoff + per-topic sections). */
const WORKING_CHARS = 8000;
/** brainDelta default total budget — ~800 tokens (plan target 300–800). */
const DELTA_BUDGET_CHARS = 3200;
/** Per-atom FLOOR inside a delta so one giant atom can't eat the whole budget — scaled up with `budget`, see brainDeltaCore. */
const DELTA_ATOM_CHARS = 900;
/**
 * Cap on the raw commits list in a delta — an unbounded `git log` over a
 * long-stale `since` (e.g. 60 commits behind) enumerates every commit
 * regardless of the atom budget above, which is what let a raw delta bloat
 * past working.md's compiled size (brain_token_eval.py measured 4,785 tok at
 * 60 commits behind vs working.md's 1,866 — task-9499766b). Newest-first, so
 * the most recent commits (already ordered that way by `git log`) survive.
 */
const DELTA_MAX_COMMITS = 20;
/**
 * Hard ceiling brainDelta will NEVER exceed, scoped or not (W2.2,
 * task-f58ce4c4): the size of the compiled working set (brief.md + working.md)
 * — the generic stand-in used when there's no per-repo working.md to compare
 * against (an unscoped/cross-repo delta, or a repo that hasn't been distilled
 * yet). W2.1 found the prior SMART cap gated on `repo` being passed — an
 * unscoped call skipped it entirely and grew unbounded as `since` got stale.
 * This ceiling applies to EVERY raw delta before it's returned, structurally,
 * not just the ns-scoped path.
 */
const DELTA_HARD_CAP_CHARS = BRIEF_CHARS + WORKING_CHARS;

const PLACEHOLDER_MARK = '_Not compiled yet';

// ── shared git plumbing (brain-repo scoped) ──────────────────────────────────

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

/**
 * ADR-010 directory isolation, shared by the brain tools and context_boot:
 * the default (local single-operator) tenant uses the machine brain (pointer
 * resolution, shared with `myai brain`); any other tenant is confined to
 * <myai home>/brains/<tenantId> and can never reach the operator's brain.
 */
export function brainEnvFor(tenantId: string): NodeJS.ProcessEnv {
  if (tenantId === SYSTEM_CONTEXT.tenantId) return process.env;
  return { ...process.env, MYAI_BRAIN_DIR: join(myaiHome(), 'brains', tenantId) };
}

function requireBrain(env: NodeJS.ProcessEnv): string {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) throw new Error(`brain: no brain repo at ${dir} — run 'myai brain init'`);
  return dir;
}

// ── atom parsing (extractive, filename + frontmatter contract) ───────────────

export interface Atom {
  file: string;
  /** UTC stamp prefix of the filename (sortable). */
  ts: string;
  /**
   * Frontmatter `kind:` — 'session' | 'handoff' | 'memory' from the Node
   * writer, plus 'session-auto' for the shell stop hook's mechanical
   * checkpoints (hooks/stop/05-brain-autoatom.sh). Inferred from the atom's
   * directory when the frontmatter predates the field.
   */
  kind: string;
  slug: string;
  /** Body with the frontmatter stripped. */
  body: string;
  /** ADR-020 topic tag (frontmatter `topic:`; 'general' when absent). */
  topic: string;
  /** ADR-020 supersession target — slug/sha8 of the atom this one retires. */
  supersedes?: string;
  /** Content sha8 (the filename's trailing -<sha8>.md) — a supersession handle. */
  sha8: string;
  /**
   * W2.3 dedup: count of near-duplicate atoms folded into this one (embedding
   * cosine similarity, same-topic only). Undefined = not deduped (default;
   * also true whenever BRAIN_DISTILL_DEDUP is unset).
   */
  collapsedCount?: number;
  /**
   * Never-drop pin (frontmatter `pin: true` at write time, OR the atom's
   * content sha8 is in the pins/ registry — see brain.ts pinAtom). Pinned
   * atoms are exempt from supersession retirement, near-dup collapse, and
   * budget-driven omission: they always render, first, in brief/working.
   */
  pinned?: boolean;
}

function stripFrontmatter(raw: string): string {
  const fm = raw.match(/^---\n[\s\S]*?\n---\n\n?/);
  return (fm ? raw.slice(fm[0].length) : raw).trim();
}

/** Collapse whitespace and hard-truncate to `max` chars with an ellipsis. */
function tightenText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** Hard-truncate to `max` chars with an ellipsis, PRESERVING newlines (unlike tightenText). */
function clampPreservingLines(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

// ── mechanical (session-auto) checkpoint distillation (BRAIN-1) ────────────────
//
// hooks/stop/05-brain-autoatom.sh synthesizes a zero-LLM "Auto-captured session
// (mechanical fallback)" atom at session close when no real atom was committed:
// a raw dump of branch, commits made, files touched, and every command run.
// Useful as a safety net, but replayed verbatim into a `brainDelta` it is a raw
// command list with near-zero continuity signal. Here we distil it to <=3 lines
// (what ran / commits / files touched) and skip it entirely when the session
// made no commits AND touched no files. The caller ranks these BRONZE — below
// any real session atom — via the kind check in the delta tiering.

/** True when `body` is a stop-hook mechanical fallback capture (see the hook's BODY heredoc). */
function isMechanicalCapture(body: string): boolean {
  return /^#\s+Auto-captured session \(mechanical fallback/m.test(body);
}

/**
 * Non-placeholder lines under a `## <header>` section of a mechanical-capture
 * body — blank lines, the trailing italic footer, and the hook's `sentinel`
 * placeholder ("(none)" / "(none recorded)") all dropped.
 */
function mechanicalSection(body: string, header: string, sentinel: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('## ')) {
      inSection = line.slice(3).trim().toLowerCase().startsWith(header.toLowerCase());
      continue;
    }
    if (!inSection) continue;
    const t = line.trim();
    if (!t || t.startsWith('_') || t === sentinel) continue;
    out.push(t);
  }
  return out;
}

/**
 * Distil a mechanical-fallback capture to <=3 lines (what ran / commits / files
 * touched). Returns null — signalling "drop this atom" — when the session made
 * no commits and touched no files: a bare command echo with zero continuity value.
 */
function summarizeMechanicalCapture(body: string): string | null {
  const commits = mechanicalSection(body, 'Commits', '(none)');
  const files = mechanicalSection(body, 'Files touched', '(none recorded)');
  if (commits.length === 0 && files.length === 0) return null;

  const branch = body.match(/^Branch:\s*(.+)$/m)?.[1]?.trim();
  const tools = body.match(/^Tool calls observed:\s*(.+)$/m)?.[1]?.trim();
  const lines: string[] = [];
  lines.push(
    tightenText(
      `Mechanical continuity checkpoint${branch && branch !== 'unknown' ? ` on ${branch}` : ''}` +
        `${tools ? ` — ${tools} tool calls` : ''} (no atom saved this session).`,
      200,
    ),
  );
  if (commits.length) lines.push(tightenText(`${commits.length} commit(s): ${commits.slice(0, 3).join('; ')}`, 200));
  if (files.length) lines.push(tightenText(`${files.length} file(s) touched: ${files.slice(0, 5).join(', ')}`, 200));
  return lines.slice(0, 3).join('\n');
}

/**
 * Pinned sha8s from the worktree pins/ registry (caller ensures main — the
 * registry is committed to main, so under withMain the worktree is current).
 */
function worktreePinSet(dir: string): Set<string> {
  const abs = join(dir, 'pins');
  if (!existsSync(abs)) return new Set();
  return new Set(
    readdirSync(abs)
      .map((f) => f.match(/^([0-9a-f]{8})\.md$/)?.[1])
      .filter((s): s is string => Boolean(s)),
  );
}

/** Read a namespace's atoms from the WORKTREE (caller ensures main), newest first. */
function readAtoms(dir: string, relDir: string): Atom[] {
  const abs = join(dir, relDir);
  if (!existsSync(abs)) return [];
  const pins = worktreePinSet(dir);
  return readdirSync(abs)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .map((file) => {
      const raw = readFileSync(join(abs, file), 'utf8');
      const slugLine = raw.match(/^slug: (.+)$/m);
      const kindLine = raw.match(/^kind: (.+)$/m);
      const topicLine = raw.match(/^topic: (.+)$/m);
      const supLine = raw.match(/^supersedes: (.+)$/m);
      const sha8 = file.match(/-([0-9a-f]{8})\.md$/)?.[1] ?? '';
      return {
        file,
        ts: file.slice(0, 16),
        kind: kindLine ? kindLine[1].trim() : relDir.endsWith('/handoffs') ? 'handoff' : 'session',
        slug: slugLine ? slugLine[1].trim() : file.replace(/\.md$/, ''),
        body: stripFrontmatter(raw),
        // Atoms written before ADR-020 carry no topic → treated as 'general'.
        topic: topicLine ? topicLine[1].trim() : 'general',
        supersedes: supLine ? supLine[1].trim() : undefined,
        sha8,
        pinned: /^pin: true$/m.test(raw) || (sha8 !== '' && pins.has(sha8)) || undefined,
      };
    });
}

// ── ADR-020 supersession + topic grouping (extractive, deterministic) ─────────

/**
 * Partition atoms into the LIVE hot-path set and the RETIRED set: an atom is
 * retired when a LATER atom's `supersedes` names its slug or its content sha8.
 * This is the structural fix for the ACTION-section-bloat failure mode — a
 * supersession pointer retires the old item automatically, no keep-last-N cap.
 * Retired atoms remain in history (BRONZE/rollup) — only the hot path shrinks.
 */
const SHA8_RE = /^[0-9a-f]{8}$/;

function pruneSuperseded(atoms: Atom[]): { live: Atom[]; retired: Atom[] } {
  // A `supersedes` ref is the CANONICAL sha8 of the target atom (ADR-020:
  // "the atom-id/SHA this replaces") — exact, unambiguous, and immune to the
  // second-resolution timestamp collision that makes filename ordering
  // unreliable within the same second. A slug ref is a convenience: it retires
  // any STRICTLY-OLDER (by filename) same-slug atom, best-effort.
  const shaTargets = new Set<string>();
  const slugTargets: Array<{ slug: string; byFile: string }> = [];
  for (const a of atoms) {
    if (!a.supersedes) continue;
    if (SHA8_RE.test(a.supersedes)) shaTargets.add(a.supersedes);
    else slugTargets.push({ slug: slugify(a.supersedes), byFile: a.file });
  }
  // Pinned atoms are NEVER retired — the never-drop contract outranks an
  // explicit supersession pointer (unpin first if the replacement is real).
  const isRetired = (b: Atom) =>
    !b.pinned &&
    ((b.sha8 !== '' && shaTargets.has(b.sha8)) ||
      slugTargets.some((s) => s.slug === b.slug && s.byFile > b.file));
  const live: Atom[] = [];
  const retired: Atom[] = [];
  for (const a of atoms) (isRetired(a) ? retired : live).push(a);
  return { live, retired };
}

/** Group atoms by topic, preserving newest-first order within each topic. */
function groupByTopic(atoms: Atom[]): Map<string, Atom[]> {
  const groups = new Map<string, Atom[]>();
  for (const a of atoms) {
    const list = groups.get(a.topic) ?? [];
    list.push(a);
    groups.set(a.topic, list);
  }
  return groups;
}

/** Topics ordered by most-recent activity (newest atom first) for stable TOCs. */
function topicsByRecency(groups: Map<string, Atom[]>): string[] {
  return [...groups.keys()].sort((a, b) => {
    const ta = groups.get(a)![0]?.ts ?? '';
    const tb = groups.get(b)![0]?.ts ?? '';
    return tb.localeCompare(ta);
  });
}

// ── the distiller ────────────────────────────────────────────────────────────

export interface DistillResult {
  namespace: string;
  /** false when the regenerated artifacts were byte-identical (no commit). */
  changed: boolean;
  files: string[];
}

/**
 * Render brief.md — GOLD: the ~150-token index a blank agent boots from. A
 * current-status one-liner (latest handoff/session) followed by a topic TOC:
 * one line per LIVE topic branch {topic, atom count, newest 1-line summary}.
 * NEVER a growing prose blob — the topic index is what makes "never blank"
 * cheap and keeps GOLD hard-capped (ADR-020).
 */
/**
 * The atom that headlines GOLD and SILVER — brief.md's current-status
 * one-liner and working.md's `## Latest handoff`: the NEWEST live,
 * hand-written atom across BOTH handoffs/ and sessions/, a handoff atom
 * winning only a same-second tie.
 *
 * Why not `handoffs[0] ?? sessions[0]` (the rule this replaces): `wrap up`
 * step 1e writes ONE kind=session atom as THE primary continuity record and
 * no handoff atom, so whichever handoff atom happened to be written last
 * headlined the brief forever, however many wraps followed. Observed
 * 2026-09-09 on ai-management: three wraps later (PR #440/#441/#442) brief.md
 * still opened with the 2026-09-07 PR #439 wrap, so every returning
 * `agent mode -min` boot — where `brain_delta` says upToDate and the compiled
 * brief IS the boot — reported a superseded ACTION block.
 *
 * `session-auto` atoms (the stop hook's zero-LLM checkpoints) never headline:
 * they are mechanical tallies, not a handoff. Superseded atoms (ADR-020) are
 * retired from candidacy exactly as they leave SILVER. Mirrored by
 * `_brain_distill_ns` in scripts/lib/brain.sh — the two distillers MUST agree
 * or the gateway merge path and the shell merge path compile different briefs.
 */
function headlineAtom(handoffs: Atom[], sessions: Atom[]): Atom | undefined {
  const liveFiles = new Set(pruneSuperseded([...handoffs, ...sessions]).live.map((a) => a.file));
  const rank = (a: Atom) => (a.kind === 'handoff' ? 0 : 1);
  const candidates = [...handoffs, ...sessions]
    .filter((a) => a.kind !== 'session-auto' && liveFiles.has(a.file))
    // Plain comparison, not localeCompare: stamps are fixed-width ASCII
    // (YYYYMMDDTHHMMSSZ) and the rest of this file orders filenames the same way.
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0) || rank(a) - rank(b));
  return candidates[0] ?? handoffs[0] ?? sessions[0];
}

/**
 * The headline atom of a namespace as it stands on main — what brief.md /
 * working.md lead with. Exposed so `brain_merge` can mirror the session's
 * primary continuity record into the gateway handoff store (`handoff_read`):
 * that store had gone dark on 2026-07-26 because `wrap up` writes the brain atom
 * and never calls `handoff_write`. Returns undefined for an empty namespace.
 */
export function headlineFor(name: string, env: NodeJS.ProcessEnv = process.env): { file: string; slug: string; ts: string; body: string } | undefined {
  const dir = requireBrain(env);
  const ns = slugify(name);
  if (!ns) return undefined;
  return withMain(dir, () => {
    const a = headlineAtom(readAtoms(dir, `repos/${ns}/handoffs`), readAtoms(dir, `repos/${ns}/sessions`));
    return a ? { file: a.file, slug: a.slug, ts: a.ts, body: a.body } : undefined;
  });
}

function renderBrief(ns: string, handoffs: Atom[], sessions: Atom[], liveOverride?: Atom[]): string {
  const latest = headlineAtom(handoffs, sessions);
  const lines = [
    `# ${ns} — boot brief`,
    '',
    `_${sessions.length} sessions · ${handoffs.length} handoffs · distilled from atoms on main._`,
    '',
  ];
  if (!latest) {
    lines.push('_No atoms yet — commit session/handoff atoms and merge to fill this._');
    return lines.join('\n') + '\n';
  }
  // Current-status one-liner (the ADR "current branch/blockers" line).
  lines.push(tightenText(latest.body, BRIEF_ONELINE_CHARS));

  // Topic index — one line per LIVE branch, most-recently-active first. When
  // `liveOverride` is supplied (W2.3 near-dup collapse already applied by the
  // caller) it replaces the plain pruneSuperseded set so the TOC's per-topic
  // counts reflect the collapsed reality, not the raw atom count.
  const live = liveOverride ?? pruneSuperseded([...handoffs, ...sessions]).live;
  // Never-drop pins render FIRST, before the topic TOC spends any budget — the
  // structural guarantee that a growing store can't crowd a critical fact out
  // of GOLD. Pinned atoms are excluded from the topic groups below (no double
  // spend); working.md carries their fuller text.
  const pinned = live.filter((a) => a.pinned);
  if (pinned.length) {
    lines.push('', '## pinned');
    for (const a of pinned) lines.push(`- ${a.slug} — ${tightenText(a.body, 90)}`);
  }
  const groups = groupByTopic(live.filter((a) => !a.pinned));
  const topicOrder = topicsByRecency(groups);
  if (topicOrder.length) {
    lines.push('', '## topics');
    for (const topic of topicOrder) {
      const draft = lines.join('\n');
      if (draft.length >= BRIEF_CHARS) break;
      const list = groups.get(topic)!;
      const summary = tightenText(list[0].body, Math.min(90, Math.max(0, BRIEF_CHARS - draft.length)));
      lines.push(`- ${topic} (${list.length}) — ${summary}`);
    }
  }
  const out = lines.join('\n');
  return (out.length > BRIEF_CHARS ? out.slice(0, BRIEF_CHARS).trimEnd() + '…' : out).trimEnd() + '\n';
}

/**
 * Render working.md — SILVER: latest handoff, then one section per LIVE topic
 * branch, each item {ts, slug, summary, supersedes?}. Superseded atoms drop out
 * of the hot path (they remain in rollup.md/BRONZE) — this is the structural
 * replacement for the blunt keep-last-N cap. Capped at ~2k tokens.
 */
function renderWorking(ns: string, handoffs: Atom[], sessions: Atom[], liveOverride?: Atom[]): string {
  const parts = [`# ${ns} — working context`, ''];
  const { live: prunedLive, retired } = pruneSuperseded([...handoffs, ...sessions]);
  // W2.3 near-dup collapse (already computed by the caller, embedding-scored,
  // same-topic only) replaces the plain pruned set when supplied — collapsed
  // atoms drop out of SILVER exactly like a supersession, but (unlike
  // supersession) are never marked "retired": they were never wrong, just
  // repetitive, and rollup.md (BRONZE) still carries every one of them —
  // principle 1, never lose a session.
  const live = liveOverride ?? prunedLive;
  // Never-drop pins: a dedicated section rendered FIRST (before even the
  // latest handoff, so nothing unbounded precedes it into the doc-level cap)
  // and with NO budget break of its own — pinned atoms always survive the
  // ~2k-token cap no matter how large the store grows. Excluded from the
  // topic groups below so the budget isn't spent on them twice.
  const pinned = live.filter((a) => a.pinned);
  if (pinned.length) {
    parts.push(`## pinned (${pinned.length})`, '');
    for (const a of pinned) {
      parts.push(`- ${a.ts} **${a.slug}** _(pinned)_ — ${tightenText(a.body, 400)}`);
    }
    parts.push('');
  }
  const latest = headlineAtom(handoffs, sessions);
  if (latest) {
    parts.push('## Latest handoff', '', latest.body.trim(), '');
  }
  const groups = groupByTopic(live.filter((a) => !a.pinned));
  for (const topic of topicsByRecency(groups)) {
    const draft = parts.join('\n');
    if (draft.length >= WORKING_CHARS) break;
    const list = groups.get(topic)!;
    parts.push(`## ${topic} (${list.length})`, '');
    for (const a of list) {
      const d = parts.join('\n');
      if (d.length >= WORKING_CHARS) break;
      const sup = a.supersedes ? ` _(supersedes ${a.supersedes})_` : '';
      const dedup = a.collapsedCount ? ` _(+${a.collapsedCount} similar collapsed)_` : '';
      parts.push(`- ${a.ts} **${a.slug}**${sup}${dedup} — ${tightenText(a.body, Math.min(400, Math.max(0, WORKING_CHARS - d.length)))}`);
    }
    parts.push('');
  }
  if (retired.length) {
    parts.push(`_${retired.length} atom(s) retired via supersession — full history in rollup.md (BRONZE)._`, '');
  }
  if (!handoffs.length && !sessions.length) {
    parts.push('_No atoms yet — commit session/handoff atoms and merge to fill this._', '');
  }
  const out = parts.join('\n');
  return (out.length > WORKING_CHARS ? out.slice(0, WORKING_CHARS).trimEnd() + '\n…' : out).trimEnd() + '\n';
}

/** Render rollup.md — BRONZE: one line per atom (topic-tagged), the namespace's
 *  full history INCLUDING superseded atoms (the hot path prunes them; BRONZE
 *  keeps everything). */
function renderRollup(ns: string, handoffs: Atom[], sessions: Atom[]): string {
  const line = (kind: string, a: Atom) =>
    `- ${a.ts} [${a.topic}] ${kind} ${a.slug} — ${tightenText(a.body, 120)}`;
  return [
    `# ${ns} — rollup`,
    '',
    ...sessions.map((a) => line('session', a)),
    ...handoffs.map((a) => line('handoff', a)),
  ].join('\n') + '\n';
}

/** Run fn with main checked out, then restore the original branch. */
function withMain<T>(dir: string, fn: () => T): T {
  const original = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (git(dir, 'status', '--porcelain') !== '') {
    throw new Error('brain: working tree is dirty — refusing to distill');
  }
  if (original !== 'main') git(dir, 'checkout', '-q', 'main');
  try {
    return fn();
  } finally {
    if (original !== 'main') git(dir, 'checkout', '-q', original);
  }
}

// ── BRAIN-3 — recurring-fact promotion to cross-repo memory atoms ─────────────
//
// The gap (task-29c0f7ca, handoff 2026-09-04): 2244 sessions had distilled into
// only 6 durable memory atoms, so a fact restated in session after session
// (e.g. "dropbox .git corruption recovered by re-cloning") never crystallised
// into the cross-repo `memory/` store where a LATER, unrelated session would
// see it. Brain health sat flat because the store kept accreting sessions with
// no rising signal.
//
// The distiller already knows how to be extractive + deterministic; here it does
// one more extractive pass: a normalized fact LINE that recurs across
// PROMOTE_MIN_SESSIONS or more DISTINCT session atoms is a durable fact, not a
// one-off, and is promoted to a cross-repo memory atom. Idempotent by
// construction — the promoted atom's slug is derived from the fact's content
// hash and `writeAtom` dedups by (slug, content-hash), so re-running the
// distiller over the same atoms creates nothing. When a later session restates
// the fact (the seen-count rises, so the atom body changes), the fresh atom
// carries a `supersedes` pointer to the prior one: an ADR-020 supersession chain
// that retires the stale count from the hot path while BRONZE keeps every link.
// Opt-in via BRAIN_DISTILL_PROMOTE=1/true — same posture as BRAIN_DISTILL_DEDUP:
// a distiller behaviour that MUTATES the store (writes memory atoms, which then
// legitimately surface in `brain_delta`'s cross-repo `memory/` scope) stays off
// by default so the pre-BRAIN-3 distiller is byte-for-byte unchanged for an
// operator who hasn't enabled it. The gateway enables it in its env to raise the
// durable memory-atom count without hand-authoring.

/** Minimum DISTINCT session atoms a normalized fact must appear in to be promoted. */
const PROMOTE_MIN_SESSIONS = Number(process.env.BRAIN_PROMOTE_MIN_SESSIONS) || 3;
/** A candidate fact line must be at least this many chars (normalized) — filters trivia. */
const PROMOTE_FACT_MIN_CHARS = 40;
/** Representative fact text is capped to this many chars in the promoted memory atom. */
const PROMOTE_FACT_MAX_CHARS = 240;

/** BRAIN-3 promotion gate — opt-in, same posture as BRAIN_DISTILL_DEDUP. */
function distillPromoteEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.BRAIN_DISTILL_PROMOTE || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** Normalize a fact line for cross-atom equality: lowercase, alphanumerics only, collapsed. */
function normalizeFact(line: string): string {
  return line.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Durable-fact candidate lines from a session-atom body: each non-trivial line
 * with list/quote/header markers stripped. A Set so a fact repeated within ONE
 * atom counts once — recurrence must be ACROSS sessions, not within one.
 */
function factLinesOf(body: string): Map<string, string> {
  const out = new Map<string, string>(); // normalized → representative (stripped original)
  for (const raw of body.split('\n')) {
    const stripped = raw.replace(/^[\s>#*\-]+/, '').trim();
    if (stripped.length < PROMOTE_FACT_MIN_CHARS) continue;
    const norm = normalizeFact(stripped);
    if (norm.length < PROMOTE_FACT_MIN_CHARS) continue;
    if (!out.has(norm)) out.set(norm, tightenText(stripped, PROMOTE_FACT_MAX_CHARS));
  }
  return out;
}

/** Existing cross-repo memory atoms sharing a promotion slug, with their stripped bodies. */
function existingMemoryForSlug(dir: string, slug: string): Array<{ file: string; body: string }> {
  const abs = join(dir, 'memory');
  if (!existsSync(abs)) return [];
  const re = new RegExp(`-${slug}-[0-9a-f]{8}\\.md$`);
  return readdirSync(abs)
    .filter((f) => re.test(f))
    .map((f) => ({ file: f, body: stripFrontmatter(readFileSync(join(abs, f), 'utf8')) }));
}

/**
 * Promote every recurring fact in `sessions` to a cross-repo memory atom.
 * Best-effort and idempotent — writes only when a genuinely new/changed durable
 * fact is found; returns the count of atoms written (0 on a clean re-run).
 * Runs INSIDE `distillNamespace`'s withMain critical section (main checked out,
 * clean tree between commits), so the memory atoms land on brain main directly.
 */
function promoteRecurringFacts(dir: string, sessions: Atom[], env: NodeJS.ProcessEnv): number {
  // Only real, hand-written session atoms count toward recurrence — the stop
  // hook's mechanical checkpoints (session-auto) are noise, not durable facts.
  const real = sessions.filter((a) => a.kind === 'session');
  if (real.length < PROMOTE_MIN_SESSIONS) return 0;

  // Count DISTINCT atoms per normalized fact; keep the newest atom's representative
  // text and topic (sessions are newest-first, so the first sighting wins).
  const count = new Map<string, number>();
  const repr = new Map<string, { text: string; topic: string }>();
  for (const a of real) {
    for (const [norm, text] of factLinesOf(a.body)) {
      count.set(norm, (count.get(norm) ?? 0) + 1);
      if (!repr.has(norm)) repr.set(norm, { text, topic: a.topic });
    }
  }

  let written = 0;
  // Deterministic order: sort by normalized fact so a re-run always visits facts
  // in the same order (no bearing on output, but keeps commits reproducible).
  for (const norm of [...count.keys()].sort()) {
    const seen = count.get(norm)!;
    if (seen < PROMOTE_MIN_SESSIONS) continue;
    const { text, topic } = repr.get(norm)!;
    const slug = `recurring-${sha8(norm)}`;
    const content =
      `${text}\n\n_Recurring fact distilled from ${seen} sessions (topic: ${topic}). ` +
      `Auto-promoted by the brain distiller (BRAIN-3)._`;
    const existing = existingMemoryForSlug(dir, slug);
    // Idempotent: an identical promoted atom already exists → nothing to do.
    if (existing.some((e) => e.body.trim() === content.trim())) continue;
    // A different-bodied prior atom for the same fact (the seen-count grew, or the
    // representative text shifted) → supersession chain (ADR-020, by slug ref).
    const supersedes = existing.length ? slug : undefined;
    try {
      const res = writeAtom({ kind: 'memory', slug, content, topic, supersedes }, env);
      if (res.created) written++;
    } catch {
      // Promotion is best-effort — a single write failure must never break the distill.
    }
  }
  return written;
}

/**
 * Regenerate one namespace's compiled artifacts from its atoms and commit the
 * result to main. Extractive + deterministic — identical atoms always produce
 * identical artifacts, so a re-run is a no-op (changed:false).
 *
 * `opts.dedupedLive`, when supplied, is the W2.3 near-dup-collapsed live atom
 * set (see `collapseNearDuplicates`) and replaces the plain pruneSuperseded
 * output for GOLD (brief.md) and SILVER (working.md) — rollup.md (BRONZE)
 * always renders from the raw, uncollapsed atoms so no session is ever lost,
 * only de-duplicated out of the hot path. Omitted → byte-identical to the
 * pre-W2.3 distiller.
 */
export function distillNamespace(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { dedupedLive?: Atom[] } = {},
): DistillResult {
  const dir = requireBrain(env);
  const ns = slugify(name);
  if (!ns) throw new Error('brain: namespace name required');
  return withMain(dir, () => {
    const nsDir = join(dir, 'repos', ns);
    if (!existsSync(nsDir)) throw new Error(`brain: no namespace repos/${ns} to distill`);
    const sessions = readAtoms(dir, `repos/${ns}/sessions`);
    const handoffs = readAtoms(dir, `repos/${ns}/handoffs`);
    const files = ['brief.md', 'working.md', 'rollup.md'];
    writeFileSync(join(nsDir, 'brief.md'), renderBrief(ns, handoffs, sessions, opts.dedupedLive));
    writeFileSync(join(nsDir, 'working.md'), renderWorking(ns, handoffs, sessions, opts.dedupedLive));
    writeFileSync(join(nsDir, 'rollup.md'), renderRollup(ns, handoffs, sessions));
    // BRAIN-3: promote recurring facts to cross-repo memory atoms (separate
    // commits under memory/, so they don't affect the repos/<ns> changed check
    // below). Idempotent — a clean re-run writes nothing. Best-effort inside its
    // own guard so a promotion hiccup never blocks the artifact commit.
    if (distillPromoteEnabled(env)) {
      try {
        promoteRecurringFacts(dir, sessions, env);
      } catch {
        /* promotion is best-effort — never let it break the distill */
      }
    }
    if (git(dir, 'status', '--porcelain', '--', `repos/${ns}`) === '') {
      return { namespace: ns, changed: false, files };
    }
    git(dir, 'add', `repos/${ns}`);
    git(dir, 'commit', '-q', '-m', `brain(distill): ${ns} — compiled brief/working/rollup`);
    return { namespace: ns, changed: true, files };
  });
}

// ── W2.3 — near-duplicate atom collapse (extends ADR-020 topic index) ────────
//
// As W1.1-1.4 make capture unconditional, atom count per topic grows without
// bound (591+ sessions and climbing) — a run of near-identical checkpoint/
// session atoms (e.g. repeated "chore: update state" landings) crowds
// genuinely distinct atoms out of the GOLD/SILVER budget purely by volume,
// degrading principle 2 ("boot cost is flat") even though W2.1/W2.2 fixed the
// immediate brain_delta bloat regression. This folds near-duplicate atoms
// WITHIN THE SAME TOPIC into one representative before compilation, using the
// same embedding provider `brain_lookup`'s ADR-020 v2 path (and the `vectors`
// collection `memory_search`/`recall_session` are built on) already scores
// topic branches with — no new infra. Gated off by default (BRAIN_DISTILL_DEDUP)
// so an install with no vector-capable provider, or one where the extra
// embed cost isn't wanted on every merge, sees the pre-W2.3 distiller
// unchanged. Never collapses across topics, and never touches rollup.md
// (BRONZE) — principle 1, never lose a session; collapse only shrinks the
// hot path, exactly like supersession already does.

/** ADR-020 v2 dedup gate — off by default, same posture as BRAIN_LOOKUP_EMBED. */
function distillDedupEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.BRAIN_DISTILL_DEDUP || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * Minimum cosine similarity for two same-topic atoms to be treated as
 * near-duplicates. Deliberately conservative (well above EMBED_CONFIDENCE_FLOOR's
 * 0.35 "is this even the right branch" bar) — collapse must only ever catch
 * near-verbatim repeats, never merely-related-but-distinct atoms.
 */
const DEDUP_SIMILARITY_FLOOR = Number(process.env.BRAIN_DISTILL_DEDUP_FLOOR) || 0.93;

/**
 * Fold near-duplicate atoms (same topic, cosine similarity >= DEDUP_SIMILARITY_FLOOR)
 * into one representative — the first (newest) atom of each cluster keeps its
 * slot, annotated with `collapsedCount`; the rest drop out of the returned
 * array. No-op (returns `atoms` unchanged) when disabled, when there's
 * nothing to compare, or when the embedding provider fails/degrades — same
 * confidence-gated-upgrade posture as `embeddingMatchTopics`.
 */
export async function collapseNearDuplicates(
  atoms: Atom[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Atom[]> {
  if (!distillDedupEnabled(env) || atoms.length < 2) return atoms;
  try {
    const provider = getEmbeddingProvider();
    const embeddings = await provider.embedBatch(atoms.map((a) => a.body));
    if (provider.degraded) {
      log.warn('brain_distill dedup embedding provider degraded (hash fallback) — skipping near-dup collapse');
      return atoms;
    }
    const n = atoms.length;
    const clusterOf = new Array<number>(n).fill(-1);
    let nextCluster = 0;
    for (let i = 0; i < n; i++) {
      if (clusterOf[i] !== -1) continue;
      clusterOf[i] = nextCluster;
      for (let j = i + 1; j < n; j++) {
        // Pinned atoms never fold into a cluster (and never absorb others) —
        // the never-drop contract keeps them verbatim in the hot path.
        if (clusterOf[j] !== -1 || atoms[j].topic !== atoms[i].topic || atoms[i].pinned || atoms[j].pinned) continue;
        if (cosineSimilarity(embeddings[i], embeddings[j]) >= DEDUP_SIMILARITY_FLOOR) clusterOf[j] = clusterOf[i];
      }
      nextCluster++;
    }
    const clusterSize = new Map<number, number>();
    for (const c of clusterOf) clusterSize.set(c, (clusterSize.get(c) ?? 0) + 1);
    const seen = new Set<number>();
    const out: Atom[] = [];
    for (let i = 0; i < n; i++) {
      const c = clusterOf[i];
      if (seen.has(c)) continue; // folded into this cluster's representative (index i's earlier member)
      seen.add(c);
      const size = clusterSize.get(c) ?? 1;
      out.push(size > 1 ? { ...atoms[i], collapsedCount: size - 1 } : atoms[i]);
    }
    return out;
  } catch (err) {
    log.warn({ err }, 'brain_distill dedup failed — skipping near-dup collapse');
    return atoms;
  }
}

/**
 * W2.3 async entry point: compute the near-dup collapse over a namespace's
 * live atoms, then distill using the collapsed set. Two synchronous
 * `withMain` critical sections around one async (network/model) step in
 * between — reading atoms needs main checked out; the embedding call does
 * not touch the brain repo at all, so it's safe to run with main released.
 * Falls straight through to the plain `distillNamespace` when dedup is
 * disabled, so the common case pays zero extra cost.
 */
export async function distillNamespaceWithDedup(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DistillResult> {
  if (!distillDedupEnabled(env)) return distillNamespace(name, env);
  const dir = requireBrain(env);
  const ns = slugify(name);
  if (!ns) throw new Error('brain: namespace name required');
  const { handoffs, sessions } = withMain(dir, () => ({
    handoffs: readAtoms(dir, `repos/${ns}/handoffs`),
    sessions: readAtoms(dir, `repos/${ns}/sessions`),
  }));
  const { live } = pruneSuperseded([...handoffs, ...sessions]);
  const dedupedLive = await collapseNearDuplicates(live, env);
  return distillNamespace(ns, env, { dedupedLive });
}

/**
 * The compile-at-write pass `brain_merge` triggers: distill every namespace
 * the just-landed merge commit touched (HEAD on main right after the merge).
 * No namespaces touched (e.g. memory/-only merge) → no-op.
 */
export function distillAfterMerge(env: NodeJS.ProcessEnv = process.env): DistillResult[] {
  const dir = requireBrain(env);
  const head = git(dir, 'rev-parse', 'main');
  // First-parent diff of the merge commit = everything the session brought in.
  const base = gitOk(dir, 'rev-parse', '--verify', '--quiet', `${head}^1`) ? `${head}^1` : null;
  if (!base) return [];
  const touched = new Set(
    git(dir, 'diff', '--name-only', base, head)
      .split('\n')
      .map((p) => p.match(/^repos\/([^/]+)\//)?.[1])
      .filter((ns): ns is string => Boolean(ns)),
  );
  return [...touched].map((ns) => distillNamespace(ns, env));
}

/**
 * W2.3 async twin of `distillAfterMerge` — same touched-namespace discovery,
 * but routes each namespace through `distillNamespaceWithDedup`. This is what
 * `brain_merge` calls; disabled (the default), it's byte-for-byte the same
 * work as `distillAfterMerge`.
 */
export async function distillAfterMergeWithDedup(env: NodeJS.ProcessEnv = process.env): Promise<DistillResult[]> {
  if (!distillDedupEnabled(env)) return distillAfterMerge(env);
  const dir = requireBrain(env);
  const head = git(dir, 'rev-parse', 'main');
  const base = gitOk(dir, 'rev-parse', '--verify', '--quiet', `${head}^1`) ? `${head}^1` : null;
  if (!base) return [];
  const touched = new Set(
    git(dir, 'diff', '--name-only', base, head)
      .split('\n')
      .map((p) => p.match(/^repos\/([^/]+)\//)?.[1])
      .filter((ns): ns is string => Boolean(ns)),
  );
  const results: DistillResult[] = [];
  for (const ns of touched) results.push(await distillNamespaceWithDedup(ns, env));
  return results;
}

// ── serving the compiled artifacts (no-server read path) ─────────────────────

/** SHA of the brain's main — the anchor agents remember for brainDelta. */
export function brainMainSha(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) return undefined;
  return gitOk(dir, 'rev-parse', '--verify', '--quiet', 'main') ? git(dir, 'rev-parse', 'main') : undefined;
}

// ── per-repo delta anchor (BRAIN-2) ───────────────────────────────────────
// `brain_merge` stamps the main SHA it just landed at here, per repo
// namespace, the moment a session's atoms land on main. A later
// `brain_delta({ repo })` call with no explicit `since` resolves it from
// here instead of degrading to a full boot — this is the anchor an agent
// used to have to grep out of its own last handoff's `Brain:` header.
// Local to this machine's `myaiHome` (like the delta-degrade log) — never
// committed to the brain repo itself.

function lastAnchorPath(env: NodeJS.ProcessEnv): string {
  return join(myaiHome(env), 'brain-last-anchor.json');
}

function readLastAnchors(env: NodeJS.ProcessEnv): Record<string, string> {
  try {
    const path = lastAnchorPath(env);
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** The brain main SHA `repo`'s own last `brain_merge` landed at, if any. */
export function readLastAnchor(repo: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readLastAnchors(env)[slugify(repo)];
}

/** Stamp `repo`'s delta anchor to `sha` (best-effort — must never break the merge it decorates). */
export function writeLastAnchor(repo: string, sha: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    mkdirSync(myaiHome(env), { recursive: true });
    const anchors = readLastAnchors(env);
    anchors[slugify(repo)] = sha;
    writeFileSync(lastAnchorPath(env), `${JSON.stringify(anchors, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort bookkeeping — a write failure here must never fail brain_merge
  }
}

/**
 * The compiled boot brief for a repo, read from brain MAIN (plain file via git
 * plumbing — works whatever branch is checked out). Returns undefined when the
 * brain/namespace is missing or the brief is still the uncompiled placeholder.
 */
export function readCompiledBrief(repo: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) return undefined;
  const ns = slugify(repo);
  if (!ns) return undefined;
  const res = spawnSync('git', ['-C', dir, 'show', `main:repos/${ns}/brief.md`], { encoding: 'utf8' });
  if (res.status !== 0) return undefined;
  const content = res.stdout.trim();
  if (!content || content.includes(PLACEHOLDER_MARK)) return undefined;
  return content;
}

/**
 * The compiled working set (latest handoff + recent sessions, ~2k tok) for a
 * repo, read from brain MAIN the same way as `readCompiledBrief`. This is the
 * SMART returning-boot fallback: when a raw `brainDelta` bloats past this
 * size (a long-absent agent replaying a huge commit range), serving this
 * instead bounds the worst case (brain_token_eval.py §returning).
 */
export function readCompiledWorking(repo: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) return undefined;
  const ns = slugify(repo);
  if (!ns) return undefined;
  const res = spawnSync('git', ['-C', dir, 'show', `main:repos/${ns}/working.md`], { encoding: 'utf8' });
  if (res.status !== 0) return undefined;
  const content = res.stdout.trim();
  if (!content || content.includes(PLACEHOLDER_MARK)) return undefined;
  return content;
}

// ── brainLookup — root→branch topic traversal (ADR-020) ──────────────────────
//
// The "traverse, not scan" retrieval path: read GOLD (brief.md, ~150 tok),
// tag-match the query/topic against the topic branches, and descend into ONLY
// the matching SILVER branch(es) (working.md sections) — never load branches
// that didn't match. Cost is O(1) root + O(1) matched branch instead of O(n)
// over the whole namespace. v1 is plain string/tag matching; embedding
// similarity (reusing the `vectors` collection) is the deferred v2.

export interface BrainLookupResult {
  repo: string;
  query?: string;
  topic?: string;
  /** GOLD index (brief.md) — the always-loaded root, when compiled. */
  gold?: string;
  /** Every topic branch present in SILVER (working.md). */
  availableTopics: string[];
  /** Topic branches the query/topic filter selected. */
  matchedTopics: string[];
  /** The matched SILVER section text — the descend result (only matched branches). */
  silver?: string;
  /** Approx token cost of the payload (~4 chars/token). */
  tokenEstimate: number;
  /**
   * Which path selected `matchedTopics`: 'topic' (exact topic arg), 'embedding'
   * (ADR-020 v2, BRAIN_LOOKUP_EMBED=1) or 'string' (v1 tag/term match). Absent
   * when nothing matched.
   */
  matchMethod?: 'topic' | 'embedding' | 'string';
}

/** ADR-020 v2 gate — off by default so a vector-less install is unchanged. */
function embedLookupEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.BRAIN_LOOKUP_EMBED || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** Minimum cosine similarity for an embedding match to be trusted over falling back to string/tag matching. */
const EMBED_CONFIDENCE_FLOOR = Number(process.env.BRAIN_LOOKUP_EMBED_FLOOR) || 0.35;

/**
 * ADR-020 v2 (deferred, now unblocked by the vector-store retrieval fix):
 * score `query` against each topic branch's SILVER section text via the
 * embedding provider (the same one `memory_search`/`recall_session` use — no
 * new infra), and return the topics whose cosine similarity clears
 * EMBED_CONFIDENCE_FLOOR, best match first. Any failure (no model available,
 * no network, embedding provider misconfigured) degrades to an empty result
 * so the caller falls back to plain string/tag matching — this path is a
 * confidence-gated upgrade, never a hard dependency.
 */
async function embeddingMatchTopics(
  query: string,
  availableTopics: string[],
  sections: Map<string, string>,
): Promise<string[]> {
  if (availableTopics.length === 0) return [];
  try {
    const provider = getEmbeddingProvider();
    const texts = availableTopics.map((tp) => `${tp}\n${sections.get(tp) || ''}`);
    const [queryEmbedding, topicEmbeddings] = await Promise.all([
      provider.embed(query),
      provider.embedBatch(texts),
    ]);
    // LocalEmbeddingProvider degrades to a non-semantic hash fallback when the
    // real model can't load (no network / first-run download failed) instead
    // of throwing — its cosine scores are noise, not similarity, so a random
    // topic could clear EMBED_CONFIDENCE_FLOOR by chance. Trust it exactly as
    // little as the "no model available" case the ADR-020 v2 contract already
    // falls back on.
    if (provider.degraded) {
      log.warn('brain_lookup embedding provider degraded (hash fallback) — falling back to string/tag match');
      return [];
    }
    return availableTopics
      .map((tp, i) => ({ tp, score: cosineSimilarity(queryEmbedding, topicEmbeddings[i]) }))
      .filter((s) => s.score >= EMBED_CONFIDENCE_FLOOR)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.tp);
  } catch (err) {
    log.warn({ err }, 'brain_lookup embedding match failed — falling back to string/tag match');
    return [];
  }
}

/**
 * Split a compiled working.md (SILVER) into a {topic → section text} map by its
 * `## <topic> (n)` headers. The "Latest handoff" preamble is keyed 'handoff'.
 */
function parseTopicSections(working: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) sections.set(current, buf.join('\n').trim());
    buf = [];
  };
  for (const line of working.split('\n')) {
    const m = line.match(/^##\s+(.+?)(?:\s+\(\d+\))?\s*$/);
    if (m) {
      flush();
      const heading = m[1].trim().toLowerCase();
      current = heading === 'latest handoff' ? 'handoff' : heading;
      buf.push(line);
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Root→branch→leaf lookup over the compiled topic index (ADR-020). Reads GOLD,
 * matches `topic` (exact) or `query` (tag/term match) against the SILVER topic
 * branches, and returns ONLY the matched branch text. No match → GOLD + the
 * available-topics list so the caller can pick a branch (never blank).
 */
export async function brainLookup(
  opts: { query?: string; topic?: string; repo: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrainLookupResult> {
  const ns = slugify(opts.repo);
  const gold = ns ? readCompiledBrief(ns, env) : undefined;
  const working = ns ? readCompiledWorking(ns, env) : undefined;
  const sections = working ? parseTopicSections(working) : new Map<string, string>();
  const availableTopics = [...sections.keys()];

  let matched: string[] = [];
  let matchMethod: BrainLookupResult['matchMethod'];
  if (opts.topic && opts.topic.trim()) {
    const t = slugify(opts.topic);
    matched = availableTopics.filter((tp) => tp === t);
    if (matched.length) matchMethod = 'topic';
  } else if (opts.query && opts.query.trim()) {
    if (embedLookupEnabled(env)) {
      matched = await embeddingMatchTopics(opts.query, availableTopics, sections);
      if (matched.length) matchMethod = 'embedding';
    }
    if (matched.length === 0) {
      const q = opts.query.toLowerCase();
      const terms = q.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
      matched = availableTopics.filter(
        (tp) =>
          q.includes(tp) ||
          tp.split('-').some((w) => w.length >= 3 && q.includes(w)) ||
          terms.some((term) => (sections.get(tp) || '').toLowerCase().includes(term)),
      );
      if (matched.length) matchMethod = 'string';
    }
  }

  const silver = matched.length ? matched.map((tp) => sections.get(tp)!).join('\n\n') : undefined;

  const result: BrainLookupResult = {
    repo: ns,
    query: opts.query,
    topic: opts.topic,
    gold,
    availableTopics,
    matchedTopics: matched,
    silver,
    tokenEstimate: 0,
    matchMethod,
  };
  result.tokenEstimate = Math.ceil(JSON.stringify(result).length / 4);
  return result;
}

// ── brainManifest — control-plane boot manifest (BRAIN B2) ───────────────────
//
// "Know where what is without reading it" (BRAIN_BUILD_PLAN.md §2, control
// plane). A tiny table-of-contents over the stores the 3-plane router
// dispatches against — no atom/chunk bodies, just what exists and how fresh
// it is. Extends ADR-020's tiered topic index one level UP: which STORE or
// namespace to descend into, not which topic within one namespace's SILVER
// branch (that's still `brief.md`/`working.md`, fetched via brain_delta).

export interface BrainManifestStore {
  name: string;
  kind: 'git' | 'sqlite' | 'vector';
  /** Where the store lives (a path or a store/collection name) — informational, not a body. */
  location: string;
  description: string;
  /** MCP tool names (or script paths, where no tool exists yet) to fetch from this store. */
  fetchTools: string[];
}

export interface BrainManifestNamespace {
  name: string;
  hasBrief: boolean;
  hasWorking: boolean;
  sessions: number;
  handoffs: number;
  /** BRAIN-2: the main SHA this repo's own last `brain_merge` landed at — the
   * anchor a returning `agent mode -min` boot can hand `brain_delta({ repo })`
   * as `since` with zero file reads (surfaced read-free via context_boot /
   * the MCP-initialize bundle). Absent until this repo's first merge. */
  lastAnchor?: string;
}

export interface BrainManifest {
  /** Brain main HEAD SHA — the freshness anchor for a later `brain_delta({ since })`. */
  freshnessSha?: string;
  stores: BrainManifestStore[];
  namespaces: BrainManifestNamespace[];
  /** Cross-repo memory/ atom count (no per-atom detail — see brain_explore for that). */
  memoryAtoms: number;
  /** Approx token cost of this payload (~4 chars/token) — should stay tiny by construction. */
  tokenEstimate: number;
}

/** Stores that don't vary with the brain dir — their location/description/fetchTools are static. */
const STATIC_MANIFEST_STORES: BrainManifestStore[] = [
  {
    name: 'repo-sqlite-index',
    kind: 'sqlite',
    location: 'state/.repo_index.sqlite3',
    description: 'Repo-local symbols/refs/chunks/tests/atoms/sparse_terms/embeddings — deterministic tools-over-tokens pre-filter for code retrieval (BRAIN B1). Rebuildable, gitignored; no MCP tool yet.',
    fetchTools: ['scripts/scan_repo_index.py', 'scripts/index_brain_atoms.py', 'scripts/build_sparse_index.py', 'scripts/embed_atoms.py'],
  },
  {
    name: 'atlas-vectors',
    kind: 'vector',
    location: 'Atlas `vectors` collection',
    description: 'Dense HNSW index over session/memory atoms — fuzzy natural-language recall (opt-in RAG_RECALL path).',
    fetchTools: ['recall_session'],
  },
];

/**
 * Tiny control-plane boot manifest: the stores the 3-plane router dispatches
 * against, this brain's namespaces (name + hasBrief/hasWorking + atom counts —
 * NO bodies), the cross-repo memory atom count, and the freshness SHA an agent
 * anchors a later `brain_delta` to. Deliberately cheap — directory listings and
 * `git rev-parse` only, never reads an atom's content.
 */
export function brainManifest(env: NodeJS.ProcessEnv = process.env): BrainManifest {
  const dir = resolveBrainDir(env);
  const ready = isBrainRepo(dir);
  const reposDir = join(dir, 'repos');
  const countMd = (d: string): number => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.md')).length : 0);

  const namespaces: BrainManifestNamespace[] = ready && existsSync(reposDir)
    ? readdirSync(reposDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .map((ns) => ({
        name: ns,
        hasBrief: existsSync(join(reposDir, ns, 'brief.md')),
        hasWorking: existsSync(join(reposDir, ns, 'working.md')),
        sessions: countMd(join(reposDir, ns, 'sessions')),
        handoffs: countMd(join(reposDir, ns, 'handoffs')),
        lastAnchor: readLastAnchor(ns, env),
      }))
    : [];

  const brainGitStore: BrainManifestStore = {
    name: 'brain-git',
    kind: 'git',
    location: dir,
    description: 'Git-versioned append-only agent memory — session/handoff/memory atoms + compiled brief/working/rollup per namespace (BRAIN B1-B3).',
    fetchTools: ['brain_delta', 'brain_commit', 'brain_log', 'brain_diff', 'brain_blame', 'brain_entity', 'brain_timeline'],
  };

  const result: BrainManifest = {
    freshnessSha: ready ? brainMainSha(env) : undefined,
    stores: [brainGitStore, ...STATIC_MANIFEST_STORES],
    namespaces,
    memoryAtoms: ready ? countMd(join(dir, 'memory')) : 0,
    tokenEstimate: 0,
  };
  result.tokenEstimate = Math.ceil(JSON.stringify(result).length / 4);
  return result;
}

// ── brainDelta — diff-only catch-up since a last-seen SHA ────────────────────

export interface BrainDeltaResult {
  /** Current main HEAD — remember this as the next `since` anchor. */
  sha: string;
  /** The `since` the caller passed, when it resolved. */
  since?: string;
  /** since == main HEAD: nothing new. */
  upToDate?: boolean;
  /** No/unknown `since` → full boot path: the compiled brief is returned. */
  full?: boolean;
  /** Compiled boot brief (only on the full path, ~150 tok). */
  brief?: string;
  commits?: BrainLogEntry[];
  /**
   * New atoms since `since`, contents capped to the budget. Default order is
   * oldest→newest (chronological). When `opts.topic` is supplied, order
   * becomes ADR-020 tier-then-topic-match: GOLD (live atoms matching the
   * requested topic) first, then SILVER (live atoms on any other topic), then
   * BRONZE (superseded atoms) — recency is the tiebreak within each tier. This
   * keeps a same-topic atom from being crowded out of the budget by an
   * unrelated-topic atom that merely sorts earlier/later chronologically.
   */
  atoms?: Array<{ path: string; content: string }>;
  /** Compiled artifacts that changed since `since` (re-read via brief/working). */
  compiledChanged?: string[];
  /** True when atoms were dropped/cut to honor the token budget. */
  truncated?: boolean;
  /**
   * SMART returning boot (brain_token_eval.py §returning): the raw commits/atoms
   * delta exceeded the compiled working.md size (a long-absent agent replaying
   * a huge commit range), so `working` was served instead — bounded above by
   * `brief + working` rather than an unbounded raw delta.
   */
  cappedToWorking?: boolean;
  /** Compiled working set (only present when `cappedToWorking` is true). */
  working?: string;
  /**
   * Hard-budget auto-degrade fired (W2.2) but no per-repo working set existed
   * to degrade TO (unscoped/cross-repo delta, or the repo hasn't been
   * distilled yet) — the raw atoms/commits were truncated in place instead.
   * Mutually exclusive with `cappedToWorking`.
   */
  cappedHard?: boolean;
  /**
   * BRAIN-3 prior-art surfacing: cross-repo memory atoms whose topic matches a
   * topic among the NEW atoms in this delta — the durable facts an earlier
   * session already distilled about what you're now touching. One short line per
   * matched memory atom (topic + slug + summary), capped. Present only when the
   * delta carried new atoms AND at least one matched a memory atom's topic — the
   * fix for the 2026-09-04 miss where prior art (dropbox-git-corruption-recovered)
   * existed in the store but was never surfaced to the session that hit it again.
   */
  priorArt?: string[];
  /** Approx token cost of the returned payload (~4 chars/token). */
  tokenEstimate: number;
  /**
   * Set when pull-on-boot could NOT catch local main up with origin/main
   * (diverged or dirty, with commits genuinely behind) — this delta was
   * computed from a stale `main` and may be missing sessions merged on other
   * machines. Every return path of `brainDelta` carries this when it applies
   * so a divergent clone can never silently serve a delta (task-1195b1a7).
   */
  syncWarning?: string;
}

/**
 * "What changed in the brain since <sha>?" — the ~300–800 token catch-up.
 * Scope with `repo` to one namespace (+ cross-repo memory/). Unknown or absent
 * `since` degrades to the blank-agent path: the ~150-token compiled brief —
 * UNLESS `repo` is scoped and that repo has a stored BRAIN-2 delta anchor
 * (the SHA its own last `brain_merge` landed at), in which case that anchor
 * is used automatically: a repo-scoped call needs no `since` at all.
 * Pass `topic` (the session's actual working topic, ADR-020 `BRAIN_TOPICS`
 * slug) to apply GOLD/SILVER/BRONZE tier-then-topic-match atom ordering
 * instead of plain chronological order — see `BrainDeltaResult.atoms`.
 */
/** Max prior-art lines a delta surfaces — a nudge, not a second payload. */
const PRIOR_ART_MAX_LINES = 5;

/**
 * BRAIN-3 prior-art surfacing: cross-repo memory atoms (read at `sha`) whose
 * topic is in `topics` — the durable facts an earlier session already distilled
 * about the topics this delta is touching. Live only (ADR-020 supersession is
 * applied so a retired fact never resurfaces), newest first, capped. Read via
 * git plumbing at the exact delta SHA so it needs no branch checkout. Best-effort
 * — any git/parse failure yields no prior art rather than breaking the delta.
 */
function computePriorArt(dir: string, sha: string, topics: Set<string>): string[] {
  if (topics.size === 0) return [];
  try {
    const listing = git(dir, 'ls-tree', '-r', '--name-only', sha, '--', 'memory');
    const paths = listing.split('\n').filter((p) => /^memory\/.*\.md$/.test(p));
    if (paths.length === 0) return [];
    // Parse each memory atom into the minimal Atom shape pruneSuperseded needs.
    const atoms: Atom[] = paths.map((path) => {
      const file = path.split('/').pop()!;
      const raw = git(dir, 'show', `${sha}:${path}`);
      const slugLine = raw.match(/^slug: (.+)$/m);
      const topicLine = raw.match(/^topic: (.+)$/m);
      const supLine = raw.match(/^supersedes: (.+)$/m);
      return {
        file,
        ts: file.slice(0, 16),
        kind: 'memory',
        slug: slugLine ? slugLine[1].trim() : file.replace(/\.md$/, ''),
        body: stripFrontmatter(raw),
        topic: topicLine ? topicLine[1].trim() : 'general',
        supersedes: supLine ? supLine[1].trim() : undefined,
        sha8: file.match(/-([0-9a-f]{8})\.md$/)?.[1] ?? '',
      };
    });
    const { live } = pruneSuperseded(atoms);
    return live
      .filter((a) => topics.has(a.topic))
      .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
      .slice(0, PRIOR_ART_MAX_LINES)
      .map((a) => `[${a.topic}] ${a.slug} — ${tightenText(a.body, 120)}`);
  } catch {
    return [];
  }
}

function brainDeltaCore(
  opts: { since?: string; repo?: string; budget?: number; topic?: string },
  env: NodeJS.ProcessEnv,
): BrainDeltaResult {
  const dir = requireBrain(env);
  const sha = git(dir, 'rev-parse', 'main');
  const budget = opts.budget && opts.budget > 400 ? Math.floor(opts.budget) : DELTA_BUDGET_CHARS;
  const ns = opts.repo ? slugify(opts.repo) : undefined;
  const scope = ns ? [`repos/${ns}`, 'memory'] : [];

  const estimate = (r: BrainDeltaResult) => Math.ceil(JSON.stringify(r).length / 4);
  // Plain-text estimate (no JSON quoting overhead) — for comparing working.md's
  // own compiled size against a delta payload's tokenEstimate on a like-for-like
  // basis (brain_token_eval.py estimates both sides the same way).
  const estimateText = (s: string) => Math.ceil(s.length / 4);

  const fullBoot = (): BrainDeltaResult => {
    const r: BrainDeltaResult = { sha, full: true, tokenEstimate: 0 };
    if (ns) r.brief = readCompiledBrief(ns, env);
    r.tokenEstimate = estimate(r);
    return r;
  };

  // BRAIN-2: an explicit `since` always wins; omitted + `repo` scoped falls
  // back to the anchor that repo's own last `brain_merge` stamped (see
  // writeLastAnchor) — a caller no longer has to grep its own last handoff
  // for the SHA. No stored anchor yet (this repo's first merge) → full boot.
  const since = opts.since?.trim() || (ns ? readLastAnchor(ns, env) : undefined);
  if (!since) return fullBoot();
  if (!gitOk(dir, 'rev-parse', '--verify', '--quiet', `${since}^{commit}`)) return fullBoot();
  const resolved = git(dir, 'rev-parse', `${since}^{commit}`);
  // A since that isn't on main's history (e.g. an unmerged session sha) can't
  // anchor a main-delta — degrade to the full boot path.
  if (!gitOk(dir, 'merge-base', '--is-ancestor', resolved, sha)) return fullBoot();
  if (resolved === sha) {
    const r: BrainDeltaResult = { sha, since: resolved, upToDate: true, tokenEstimate: 0 };
    r.tokenEstimate = estimate(r);
    return r;
  }

  const range = [`${resolved}..${sha}`];
  const pathArgs = scope.length ? ['--', ...scope] : [];
  const allCommits = git(dir, 'log', '--format=%H%x09%h%x09%aI%x09%s', ...range, ...pathArgs)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [full, short, date, ...rest] = line.split('\t');
      return { sha: full, short, date, subject: rest.join('\t') };
    });
  const commits = allCommits.slice(0, DELTA_MAX_COMMITS);
  const commitsTruncated = allCommits.length > commits.length;

  const nameStatus = git(dir, 'diff', '--name-status', resolved, sha, ...pathArgs)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...path] = line.split('\t');
      return { status, path: path.join('\t') };
    });

  const compiledChanged = nameStatus
    .filter((f) => /^repos\/[^/]+\/(brief|working|rollup)\.md$/.test(f.path))
    .map((f) => f.path);

  // New atoms (added .md files under atom dirs), oldest→newest so the story reads forward.
  const atomPaths = nameStatus
    .filter((f) => f.status === 'A' && /^(memory|repos\/[^/]+\/(sessions|handoffs))\/.*\.md$/.test(f.path))
    .map((f) => f.path)
    .sort();

  // Read each candidate once — its raw content is needed either way (to build
  // the returned atom, and, when `topic` is scoped, to rank it first).
  const rawByPath = new Map(atomPaths.map((path) => [path, git(dir, 'show', `${sha}:${path}`)]));

  // ADR-020 tier-then-topic-match ordering (B-8 follow-on, task-82e5416b): the
  // prior plain chronological order let an atom on an unrelated topic crowd a
  // same-topic atom out of the budget purely by sorting earlier/later. Rank
  // candidates into three tiers — GOLD (live, matches the requested topic — the
  // most relevant atoms, mirroring brief.md's topic-indexed TOC), SILVER (live,
  // any other topic), BRONZE (superseded via ADR-020 `supersedes`, OR a
  // session-auto mechanical checkpoint (BRAIN-1) — both history-only, below any
  // real session atom) — with recency (the existing sort order) as the tiebreak
  // within each tier. With no `topic`, every real atom shares the top tier and
  // stays in plain chronological order (unchanged), and BRONZE still sinks last.
  const requestedTopic = opts.topic?.trim() ? slugify(opts.topic) : undefined;
  const candidates = atomPaths.map((path) => {
    const raw = rawByPath.get(path)!;
    const kindLine = raw.match(/^kind: (.+)$/m);
    const topicLine = raw.match(/^topic: (.+)$/m);
    const supLine = raw.match(/^supersedes: (.+)$/m);
    return {
      path,
      kind: kindLine ? kindLine[1].trim() : path.includes('/handoffs/') ? 'handoff' : 'session',
      topic: topicLine ? topicLine[1].trim() : 'general',
      sha8: path.split('/').pop()?.match(/-([0-9a-f]{8})\.md$/)?.[1] ?? '',
      supersedes: supLine ? supLine[1].trim() : undefined,
    };
  });
  const kindByPath = new Map(candidates.map((c) => [c.path, c.kind]));
  const supersededSha8 = new Set(
    candidates.map((c) => c.supersedes).filter((s): s is string => !!s && SHA8_RE.test(s)),
  );
  const tierOf = (c: (typeof candidates)[number]): number => {
    // BRONZE — superseded, or a mechanical session-auto checkpoint (BRAIN-1):
    // always below any real session/handoff atom, whatever its topic.
    if (c.kind === 'session-auto' || (c.sha8 && supersededSha8.has(c.sha8))) return 2;
    if (requestedTopic) return c.topic === requestedTopic ? 0 : 1; // GOLD (topic match) / SILVER (other)
    return 0; // no topic → all real atoms one tier, plain chronological
  };
  const orderedPaths = candidates
    .map((c, i) => ({ c, i })) // stable sort: preserve chronological order within a tier
    .sort((a, b) => tierOf(a.c) - tierOf(b.c) || a.i - b.i)
    .map(({ c }) => c.path);

  // Per-atom cap. A flat DELTA_ATOM_CHARS chopped every wrap atom: `wrap up`
  // step 1e's session atom is a ~300-token (~1200-char) narrative whose ACTION
  // block sits at the END, so the 900-char slice returned the recap and dropped
  // the one part a returning boot needs — and an explicit larger `budget` never
  // lifted it (2026-09-09: budget 5000 and 20000 both returned the same
  // 900-char cut with `truncated: true`). Scale the cap with the budget — half
  // of it, so at least two atoms always fit — never below the historical floor.
  const atomCap = Math.max(DELTA_ATOM_CHARS, Math.floor(budget / 2));
  const atoms: Array<{ path: string; content: string }> = [];
  let spent = 0;
  let truncated = false;
  for (const path of orderedPaths) {
    if (spent >= budget) {
      truncated = true;
      break;
    }
    const raw = rawByPath.get(path)!;
    const stripped = stripFrontmatter(raw);
    const cap = Math.min(atomCap, budget - spent);
    let content: string;
    if (kindByPath.get(path) === 'session-auto' || isMechanicalCapture(stripped)) {
      // BRAIN-1: distil the stop hook's raw command dump to <=3 lines; skip the
      // atom entirely when the session made no commits and touched no files.
      const summary = summarizeMechanicalCapture(stripped);
      if (summary === null) continue;
      content = clampPreservingLines(summary, cap);
    } else {
      content = tightenText(stripped, cap);
    }
    if (content.endsWith('…')) truncated = true;
    atoms.push({ path, content });
    spent += content.length;
  }

  // BRAIN-3 prior-art: the topics of the atoms actually returned in this delta —
  // for each, surface any durable memory atom already distilled on that topic, so
  // a returning session sees the prior art instead of rediscovering it. Scoped to
  // returned atoms (what the agent sees), excluding BRONZE mechanical checkpoints.
  const topicByPath = new Map(candidates.map((c) => [c.path, { topic: c.topic, kind: c.kind }]));
  const deltaTopics = new Set(
    atoms
      .map((a) => topicByPath.get(a.path))
      .filter((c): c is { topic: string; kind: string } => !!c && c.kind !== 'session-auto')
      .map((c) => c.topic),
  );
  const priorArt = computePriorArt(dir, sha, deltaTopics);

  const r: BrainDeltaResult = {
    sha,
    since: resolved,
    commits,
    atoms,
    compiledChanged,
    truncated: (truncated || commitsTruncated) || undefined,
    ...(priorArt.length ? { priorArt } : {}),
    tokenEstimate: 0,
  };
  r.tokenEstimate = estimate(r);

  // SMART returning boot (brain_token_eval.py §returning, task-9499766b): a
  // long-absent agent's raw delta can still bloat past the compiled working
  // set even after the caps above (many small atoms/commits add up). Rather
  // than serve an unbounded catch-up, fall back to `brief + working` — bounded
  // above by the compiled artifacts regardless of how stale `since` is.
  //
  // Gated by DELTA_BUDGET_CHARS/4 (the plan's normal delta ceiling) so an
  // ordinary fresh delta (a handful of tokens, comfortably inside budget) is
  // never capped just because a namespace's working.md happens to be small
  // too — this only fires once the raw payload is genuinely bloated relative
  // to what a returning boot should ever cost.
  //
  // W2.2 (task-f58ce4c4, structurally closing the W2.1 gap): this check used
  // to be gated on `ns` being set — an unscoped call (repo omitted, by design
  // or by caller bug, exactly what W2.1 found) skipped it ENTIRELY and could
  // grow without bound as `since` got stale. It now runs unconditionally: a
  // scoped delta still degrades to that repo's actual compiled brief+working;
  // an unscoped delta (or one whose repo was never distilled, so there's no
  // working.md to compare against) instead gets hard-truncated in place
  // against the generic DELTA_HARD_CAP_CHARS ceiling — either way, brain_delta
  // can never structurally return more than the compiled working set again.
  if (r.tokenEstimate > DELTA_BUDGET_CHARS / 4) {
    const working = ns ? readCompiledWorking(ns, env) : undefined;
    if (working !== undefined && r.tokenEstimate > estimateText(working)) {
      recordDeltaDegrade({ at: new Date().toISOString(), repo: ns, rawTokens: r.tokenEstimate, mode: 'working' }, env);
      const capped: BrainDeltaResult = {
        sha,
        since: resolved,
        brief: readCompiledBrief(ns!, env),
        working,
        cappedToWorking: true,
        tokenEstimate: 0,
      };
      capped.tokenEstimate = estimate(capped);
      return capped;
    }
    if (working === undefined && r.tokenEstimate > DELTA_HARD_CAP_CHARS / 4) {
      recordDeltaDegrade({ at: new Date().toISOString(), repo: ns, rawTokens: r.tokenEstimate, mode: 'hard' }, env);
      // Drop newest-sorted atoms from the tail first (oldest survive — same
      // "story reads forward" ordering as the build loop above), then commits,
      // until the serialized payload is back under the hard ceiling.
      while (r.atoms!.length && estimate(r) > DELTA_HARD_CAP_CHARS / 4) {
        r.atoms!.pop();
      }
      if (estimate(r) > DELTA_HARD_CAP_CHARS / 4) {
        r.commits = r.commits!.slice(0, 1);
      }
      r.truncated = true;
      r.cappedHard = true;
      r.tokenEstimate = estimate(r);
    }
  }

  return r;
}

/**
 * "What changed in the brain since <sha>?" — the ~300–800 token catch-up.
 * Scope with `repo` to one namespace (+ cross-repo memory/). Unknown or absent
 * `since` degrades to the blank-agent path: the ~150-token compiled brief.
 * Pass `topic` (the session's actual working topic, ADR-020 `BRAIN_TOPICS`
 * slug) to apply GOLD/SILVER/BRONZE tier-then-topic-match atom ordering
 * instead of plain chronological order — see `BrainDeltaResult.atoms`.
 *
 * Pull-on-boot runs first (bounded fast-fail, non-fatal) so a delta on this
 * machine sees what another machine merged. When local main is diverged or
 * dirty and genuinely behind origin, that pull is structurally a no-op (ff-only
 * can't reconcile a divergent history) — `syncWarning` on the result carries
 * that forward instead of letting a stale clone silently serve a delta that
 * looks fresh (task-1195b1a7).
 */
export function brainDelta(
  opts: { since?: string; repo?: string; budget?: number; topic?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): BrainDeltaResult {
  const sync = brainSyncPull(env);
  const r = brainDeltaCore(opts, env);
  const warning = brainSyncWarning(sync);
  if (warning) r.syncWarning = warning;
  return r;
}

// ── reconcileMain — deterministic merge-conflict resolver for concurrent mains ─
//
// The multi-device hazard: two machines each merge a session branch into their
// LOCAL brain main and push. The first push wins; the second is rejected
// (non-ff), and brainSyncPull is ff-only so it will not reconcile a DIVERGED
// main — the two histories drift apart forever. This is the "merge-conflict UX
// for concurrent multi-device sessions" gap (task-da19637c).
//
// Why it resolves cleanly: atoms are append-only immutable files (§writeAtom),
// so a real 3-way merge of two mains NEVER conflicts on an atom — both sides'
// atoms simply union. The ONLY files that can conflict are the distiller's
// compiled artifacts (brief/working/rollup.md), which are regenerated in place
// on main. And those have a canonical resolution: throw away BOTH conflicted
// versions and re-run the distiller over the merged (union) atom set. The
// distiller is extractive + deterministic, so the result is identical no matter
// which machine runs the reconcile — the resolution is order-independent and
// convergent. If a NON-artifact (atom) path ever conflicts, that is a contract
// violation (append-only broken): we abort the merge and throw loudly rather
// than silently pick a side.

/** Bounded network-git timeout — fast-fail so a reconcile can never hang offline. */
const RECONCILE_NET_TIMEOUT_MS = Number(process.env.BRAIN_NET_TIMEOUT_MS) || 2000;

function netGitOk(dir: string, ...args: string[]): boolean {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: RECONCILE_NET_TIMEOUT_MS });
  return res.status === 0;
}

/** A compiled artifact (brief/working/rollup.md) — deterministically re-distillable. */
const COMPILED_ARTIFACT = /^repos\/([^/]+)\/(brief|working|rollup)\.md$/;
/** An append-only atom — must NEVER conflict on a merge (contract invariant). */
const ATOM_PATH = /^(memory\/|repos\/[^/]+\/(sessions|handoffs)\/).*\.md$/;

export interface BrainReconcileResult {
  /** true when local main now contains origin's work (converged, ff'd, or ahead+pushed). */
  reconciled: boolean;
  /** How the two mains were brought together. */
  strategy?: 'up-to-date' | 'push' | 'ff' | 'merge';
  /** Why reconcile could not run to completion (absent on success). */
  reason?: 'no-brain' | 'no-remote' | 'offline' | 'not-on-main' | 'dirty';
  /** Compiled artifacts that conflicted and were deterministically re-distilled. */
  resolvedArtifacts?: string[];
  /** Namespaces re-distilled to canonical form after a divergent merge. */
  distilled?: string[];
  /** main SHA after the reconcile. */
  sha?: string;
  /** Whether the reconciled main was pushed to origin. */
  pushed?: boolean;
}

/**
 * Reconcile the local brain main with origin/main and publish the result.
 *
 * Fast paths (no divergence): up-to-date (nothing to do), behind (ff to origin),
 * ahead (push local). Divergent path: a real --no-ff merge whose only possible
 * conflicts are compiled artifacts, resolved by re-distilling from the union of
 * atoms (see the block comment above). Every network op is bounded + non-fatal;
 * the only throw is the append-only-contract-violation safety case.
 *
 * Local-only brain (no origin) → reported no-op: there is nothing to diverge
 * from. Must be called with main checked out and a clean tree (the state
 * brain_merge leaves behind); otherwise a reported no-op, never a throw.
 */
export function reconcileMain(env: NodeJS.ProcessEnv = process.env): BrainReconcileResult {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) return { reconciled: false, reason: 'no-brain' };
  if (!brainRemoteUrl(dir)) return { reconciled: false, reason: 'no-remote' };
  if (git(dir, 'rev-parse', '--abbrev-ref', 'HEAD') !== 'main') {
    return { reconciled: false, reason: 'not-on-main' };
  }
  if (git(dir, 'status', '--porcelain') !== '') return { reconciled: false, reason: 'dirty' };

  // Bounded fetch of all refs — offline stays first-class (BRAIN_OFFLINE.md).
  // Fetch WITHOUT a refspec so a brand-new empty remote (no main yet) succeeds
  // with nothing rather than erroring; origin/main is still populated when it exists.
  if (!netGitOk(dir, 'fetch', '-q', 'origin')) return { reconciled: false, reason: 'offline' };

  const local = git(dir, 'rev-parse', 'main');
  // A brand-new remote may have no main yet → our push seeds it.
  if (!gitOk(dir, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main')) {
    const pushed = netGitOk(dir, 'push', '-q', 'origin', 'main');
    return { reconciled: pushed, strategy: 'push', sha: local, pushed };
  }
  const remote = git(dir, 'rev-parse', 'refs/remotes/origin/main');

  if (local === remote) return { reconciled: true, strategy: 'up-to-date', sha: local, pushed: true };

  // Behind: origin strictly ahead → fast-forward, already on origin (no push).
  if (gitOk(dir, 'merge-base', '--is-ancestor', local, remote)) {
    git(dir, 'merge', '-q', '--ff-only', 'refs/remotes/origin/main');
    return { reconciled: true, strategy: 'ff', sha: git(dir, 'rev-parse', 'main'), pushed: true };
  }
  // Ahead: we strictly contain origin → publish local.
  if (gitOk(dir, 'merge-base', '--is-ancestor', remote, local)) {
    const pushed = netGitOk(dir, 'push', '-q', 'origin', 'main');
    return { reconciled: pushed, strategy: 'push', sha: local, pushed };
  }

  // ── Diverged: real 3-way merge, resolved deterministically by re-distill ──
  if (!gitOk(dir, 'merge', '--no-commit', '--no-ff', 'refs/remotes/origin/main')) {
    const conflicts = git(dir, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
    const atomConflicts = conflicts.filter((p) => ATOM_PATH.test(p));
    if (atomConflicts.length) {
      // Contract violation — append-only atoms must never collide. Abort loudly.
      spawnSync('git', ['-C', dir, 'merge', '--abort'], { encoding: 'utf8' });
      throw new Error(
        `brain: unexpected atom-level conflict during reconcile (${atomConflicts.join(', ')}) — ` +
          'atoms are append-only and must never conflict; not auto-resolving. Reconcile by hand.',
      );
    }
    // Every conflict is a compiled artifact → discard both sides (re-distilled below).
    for (const path of conflicts) {
      git(dir, 'checkout', '--ours', '--', path);
      git(dir, 'add', '--', path);
    }
    git(dir, 'commit', '-q', '--no-edit');
    const distilled = redistillTouched(dir, env, conflicts);
    const pushed = netGitOk(dir, 'push', '-q', 'origin', 'main');
    return {
      reconciled: pushed,
      strategy: 'merge',
      resolvedArtifacts: conflicts,
      distilled,
      sha: git(dir, 'rev-parse', 'main'),
      pushed,
    };
  }
  // Clean divergent merge (disjoint namespaces) — complete it, then re-distill
  // whatever the remote brought in so the compiled artifacts stay canonical.
  git(dir, 'commit', '-q', '--no-edit');
  const distilled = redistillTouched(dir, env, []);
  const pushed = netGitOk(dir, 'push', '-q', 'origin', 'main');
  return { reconciled: pushed, strategy: 'merge', resolvedArtifacts: [], distilled, sha: git(dir, 'rev-parse', 'main'), pushed };
}

/**
 * After a reconcile merge lands on main, re-distill every namespace the merge
 * touched (distillAfterMerge, first-parent diff = what origin brought in) UNION
 * every namespace whose compiled artifact conflicted — so a picked-`--ours`
 * artifact is always overwritten with the canonical distillation of the union
 * atom set. Returns the sorted namespaces that were re-distilled.
 */
function redistillTouched(dir: string, env: NodeJS.ProcessEnv, conflicts: string[]): string[] {
  const namespaces = new Set(distillAfterMerge(env).map((d) => d.namespace));
  for (const path of conflicts) {
    const ns = path.match(COMPILED_ARTIFACT)?.[1];
    if (ns && !namespaces.has(ns)) {
      distillNamespace(ns, env);
      namespaces.add(ns);
    }
  }
  return [...namespaces].sort();
}
