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

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { brainRemoteUrl, brainSyncPull, isBrainRepo, myaiHome, resolveBrainDir, slugify } from './brain.js';
import type { BrainLogEntry } from './brain.js';
import { SYSTEM_CONTEXT } from './tenant-context.js';

// ── char budgets (~4 chars/token) ────────────────────────────────────────────

/** brief.md — ~150 tokens. */
const BRIEF_CHARS = 600;
/** working.md — ~2k tokens. */
const WORKING_CHARS = 8000;
/** Recent session atoms folded verbatim into working.md. */
const WORKING_RECENT_SESSIONS = 5;
/** brainDelta default total budget — ~800 tokens (plan target 300–800). */
const DELTA_BUDGET_CHARS = 3200;
/** Per-atom cap inside a delta so one giant atom can't eat the whole budget. */
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

interface Atom {
  file: string;
  /** UTC stamp prefix of the filename (sortable). */
  ts: string;
  slug: string;
  /** Body with the frontmatter stripped. */
  body: string;
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

/** Read a namespace's atoms from the WORKTREE (caller ensures main), newest first. */
function readAtoms(dir: string, relDir: string): Atom[] {
  const abs = join(dir, relDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .map((file) => {
      const raw = readFileSync(join(abs, file), 'utf8');
      const slugLine = raw.match(/^slug: (.+)$/m);
      return {
        file,
        ts: file.slice(0, 16),
        slug: slugLine ? slugLine[1].trim() : file.replace(/\.md$/, ''),
        body: stripFrontmatter(raw),
      };
    });
}

// ── the distiller ────────────────────────────────────────────────────────────

export interface DistillResult {
  namespace: string;
  /** false when the regenerated artifacts were byte-identical (no commit). */
  changed: boolean;
  files: string[];
}

/** Render brief.md — the ~150-token boot brief a blank agent starts from. */
function renderBrief(ns: string, handoffs: Atom[], sessions: Atom[]): string {
  const latest = handoffs[0] ?? sessions[0];
  const lines = [
    `# ${ns} — boot brief`,
    '',
    `_${sessions.length} sessions · ${handoffs.length} handoffs · distilled from atoms on main._`,
    '',
  ];
  if (latest) {
    lines.push(tightenText(latest.body, BRIEF_CHARS - lines.join('\n').length - 40));
  } else {
    lines.push('_No atoms yet — commit session/handoff atoms and merge to fill this._');
  }
  return lines.join('\n') + '\n';
}

/** Render working.md — latest handoff + recent sessions, capped at ~2k tokens. */
function renderWorking(ns: string, handoffs: Atom[], sessions: Atom[]): string {
  const parts = [`# ${ns} — working context`, ''];
  if (handoffs[0]) {
    parts.push('## Latest handoff', '', handoffs[0].body.trim(), '');
  }
  const recent = sessions.slice(0, WORKING_RECENT_SESSIONS);
  if (recent.length) {
    parts.push('## Recent sessions (newest first)', '');
    for (const s of recent) {
      const draft = parts.join('\n');
      if (draft.length >= WORKING_CHARS) break;
      parts.push(`### ${s.ts} ${s.slug}`, '', tightenText(s.body, Math.min(1200, WORKING_CHARS - draft.length)), '');
    }
  }
  if (!handoffs.length && !sessions.length) {
    parts.push('_No atoms yet — commit session/handoff atoms and merge to fill this._', '');
  }
  const out = parts.join('\n');
  return (out.length > WORKING_CHARS ? out.slice(0, WORKING_CHARS).trimEnd() + '\n…' : out).trimEnd() + '\n';
}

/** Render rollup.md — one line per atom, the namespace's full index. */
function renderRollup(ns: string, handoffs: Atom[], sessions: Atom[]): string {
  const line = (kind: string, a: Atom) => `- ${a.ts} ${kind} ${a.slug} — ${tightenText(a.body, 120)}`;
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

/**
 * Regenerate one namespace's compiled artifacts from its atoms and commit the
 * result to main. Extractive + deterministic — identical atoms always produce
 * identical artifacts, so a re-run is a no-op (changed:false).
 */
export function distillNamespace(name: string, env: NodeJS.ProcessEnv = process.env): DistillResult {
  const dir = requireBrain(env);
  const ns = slugify(name);
  if (!ns) throw new Error('brain: namespace name required');
  return withMain(dir, () => {
    const nsDir = join(dir, 'repos', ns);
    if (!existsSync(nsDir)) throw new Error(`brain: no namespace repos/${ns} to distill`);
    const sessions = readAtoms(dir, `repos/${ns}/sessions`);
    const handoffs = readAtoms(dir, `repos/${ns}/handoffs`);
    const files = ['brief.md', 'working.md', 'rollup.md'];
    writeFileSync(join(nsDir, 'brief.md'), renderBrief(ns, handoffs, sessions));
    writeFileSync(join(nsDir, 'working.md'), renderWorking(ns, handoffs, sessions));
    writeFileSync(join(nsDir, 'rollup.md'), renderRollup(ns, handoffs, sessions));
    if (git(dir, 'status', '--porcelain', '--', `repos/${ns}`) === '') {
      return { namespace: ns, changed: false, files };
    }
    git(dir, 'add', `repos/${ns}`);
    git(dir, 'commit', '-q', '-m', `brain(distill): ${ns} — compiled brief/working/rollup`);
    return { namespace: ns, changed: true, files };
  });
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

// ── serving the compiled artifacts (no-server read path) ─────────────────────

/** SHA of the brain's main — the anchor agents remember for brainDelta. */
export function brainMainSha(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) return undefined;
  return gitOk(dir, 'rev-parse', '--verify', '--quiet', 'main') ? git(dir, 'rev-parse', 'main') : undefined;
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
  /** New atoms since `since`, newest last, contents capped to the budget. */
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
  /** Approx token cost of the returned payload (~4 chars/token). */
  tokenEstimate: number;
}

/**
 * "What changed in the brain since <sha>?" — the ~300–800 token catch-up.
 * Scope with `repo` to one namespace (+ cross-repo memory/). Unknown or absent
 * `since` degrades to the blank-agent path: the ~150-token compiled brief.
 */
export function brainDelta(
  opts: { since?: string; repo?: string; budget?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): BrainDeltaResult {
  const dir = requireBrain(env);
  // Pull-on-boot: catch up main from origin before diffing (bounded fast-fail,
  // non-fatal) — so a delta on this machine sees what another machine merged.
  brainSyncPull(env);
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

  const since = opts.since?.trim();
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

  const atoms: Array<{ path: string; content: string }> = [];
  let spent = 0;
  let truncated = false;
  for (const path of atomPaths) {
    if (spent >= budget) {
      truncated = true;
      break;
    }
    const raw = git(dir, 'show', `${sha}:${path}`);
    const content = tightenText(stripFrontmatter(raw), Math.min(DELTA_ATOM_CHARS, budget - spent));
    if (content.endsWith('…')) truncated = true;
    atoms.push({ path, content });
    spent += content.length;
  }

  const r: BrainDeltaResult = {
    sha,
    since: resolved,
    commits,
    atoms,
    compiledChanged,
    truncated: (truncated || commitsTruncated) || undefined,
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
  if (ns && r.tokenEstimate > DELTA_BUDGET_CHARS / 4) {
    const working = readCompiledWorking(ns, env);
    if (working !== undefined) {
      const workingTok = estimateText(working);
      if (r.tokenEstimate > workingTok) {
        const capped: BrainDeltaResult = {
          sha,
          since: resolved,
          brief: readCompiledBrief(ns, env),
          working,
          cappedToWorking: true,
          tokenEstimate: 0,
        };
        capped.tokenEstimate = estimate(capped);
        return capped;
      }
    }
  }

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
