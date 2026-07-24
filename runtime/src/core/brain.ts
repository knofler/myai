/**
 * brain.ts — Brain store core: git-versioned agent memory (BRAIN B1).
 *
 * Node mirror of scripts/lib/brain.sh (the two libs share the on-disk
 * contract — see plan/jam/brain-layer.md). The brain is a real, private git
 * repo SEPARATE from code git: sessions = commits, wrap up = merge, branches
 * = parallel thinking contexts, `main` = the consolidated truth agents boot
 * from. The B2 gateway tools (brain_status/commit/stash/…) build on this
 * module; the B3 distiller regenerates the compiled artifacts.
 *
 * Layout:
 *   BRAIN.md                          manifest
 *   memory/<atom>.md                  cross-repo memory facts
 *   repos/<name>/sessions/<atom>.md   one file per session block
 *   repos/<name>/handoffs/<atom>.md   one file per handoff entry
 *   repos/<name>/brief.md             compiled boot brief (~150 tok, on main)
 *   repos/<name>/working.md           compiled working context (~2k, on main)
 *
 * APPEND-ONLY ATOMS: one immutable file per fact, filename embeds a content
 * hash (<utc-ts>-<host>-<slug>-<sha8>.md) so concurrent writers can never
 * race on the same path with different content — merges are conflict-free by
 * construction. Atoms are never edited; identical re-writes dedup to a no-op.
 *
 * Location resolution (must agree with brain.sh):
 *   1. $MYAI_BRAIN_DIR   2. $MYAI_HOME/brain.path pointer   3. $MYAI_HOME/brain
 *   ($MYAI_HOME defaults to ~/.myai)
 *
 * Deliberately dependency-free (node builtins only) so it works in every
 * deployment tier, including the offline/sovereign path where the brain is
 * read straight from disk with no gateway.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export type AtomKind = 'session' | 'handoff' | 'memory';

export interface BrainInitOptions {
  /** Target directory (default: <myai home>/brain). */
  dir?: string;
  /** Optional git remote to register as `origin`. */
  remote?: string;
  /**
   * Write the machine-wide $MYAI_HOME/brain.path pointer (default true).
   * Tenant-scoped stores (ADR-010) pass false — the pointer names the
   * OPERATOR's brain and must never be redirected to a tenant dir.
   */
  pointer?: boolean;
}

/**
 * Code↔memory provenance (BRAIN B5): which code repo/branch/commits a brain
 * atom was written about. Stamped into the atom frontmatter AND as git
 * trailers on the brain commit, so `brainBlame` can answer both directions
 * ("who produced code commit X and what were they thinking" / "what code did
 * this idea branch produce") with plain `git log` — no index needed.
 */
export interface CodeProvenance {
  /** Code repo name (defaults to the atom's repo namespace). */
  repo?: string;
  /** Code branch the work happened on (e.g. test). */
  branch?: string;
  /** Code HEAD SHA at the time of the brain write. */
  sha?: string;
  /** Code commits this session produced. */
  commits?: string[];
}

export interface AtomInput {
  kind: AtomKind;
  /** Project namespace; omit (or null) for cross-repo memory/ atoms. */
  repo?: string | null;
  slug: string;
  content: string;
  /** Optional code provenance stamp (BRAIN B5). */
  code?: CodeProvenance;
}

export interface AtomResult {
  /** Repo-relative path of the atom file. */
  path: string;
  sha8: string;
  /** false when an identical atom already existed (dedup no-op). */
  created: boolean;
  /** Session-atom quality lint (kind=session only) — see lintSessionAtom. */
  lint?: AtomLint;
}

// ── session-atom quality lint ────────────────────────────────────────────────
// Non-blocking pre-commit gate for kind=session atoms, distinct from any brain
// health-score composite index (that's a fleet-wide rollup; this is a
// per-atom check). Flags a summary that's too short, carries no
// decision/next-step signal, or nearly repeats the prior session atom, so
// wrap-up can prompt for enrichment. writeAtom still commits either way —
// this only annotates the result.

export interface AtomLint {
  /** Human-readable nudges; empty when the atom looks signal-dense. */
  warnings: string[];
}

const LINT_MIN_WORDS = 25;
const LINT_SIGNAL_RE = /\b(decision|decided|next steps?|next:|todo|blocked|result:|shipped|merged|fixed|found|verified|plan:|approach|risk|root cause)\b/i;
const LINT_DUP_SIMILARITY = 0.85;

function lintWordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) || []);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function stripAtomFrontmatter(raw: string): string {
  const m = raw.match(/^---\n[\s\S]*?\n---\n\n?([\s\S]*)$/);
  return (m ? m[1] : raw).trim();
}

/**
 * Latest already-committed atom body (frontmatter stripped) in a namespace
 * dir, or null. Sorts by mtime (not filename) — the embedded timestamp is
 * second-resolution, so two atoms written in the same second would otherwise
 * sort by slug text rather than write order.
 */
function latestAtomBody(dir: string, relDir: string): string | null {
  const abs = join(dir, relDir);
  if (!existsSync(abs)) return null;
  const files = readdirSync(abs).filter((f) => f.endsWith('.md'));
  if (!files.length) return null;
  const last = files
    .map((f) => ({ f, mtimeMs: statSync(join(abs, f)).mtimeMs }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .pop()!.f;
  return stripAtomFrontmatter(readFileSync(join(abs, last), 'utf8'));
}

/**
 * Pre-commit quality lint for a session atom. Non-blocking: callers still
 * write the atom and surface these as a prompt to enrich, never a hard
 * failure.
 */
export function lintSessionAtom(content: string, priorContent?: string | null): AtomLint {
  const trimmed = content.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const warnings: string[] = [];

  if (wordCount < LINT_MIN_WORDS) {
    warnings.push(`too short (${wordCount} words) — add what happened, why, and what's next`);
  }
  if (!LINT_SIGNAL_RE.test(trimmed)) {
    warnings.push('no decision/next-step signal detected — name a decision or a "Next:" so the next session knows what to do');
  }
  if (priorContent && priorContent.trim()) {
    const similarity = jaccardSimilarity(lintWordSet(trimmed), lintWordSet(priorContent));
    if (similarity >= LINT_DUP_SIMILARITY) {
      warnings.push(`near-duplicate of the prior session atom (${Math.round(similarity * 100)}% word overlap) — summarize what's NEW this session`);
    }
  }
  return { warnings };
}

export interface BrainStatus {
  dir: string;
  initialized: boolean;
  branch?: string;
  namespaces?: number;
  atoms?: { sessions: number; handoffs: number; memory: number };
  lastCommit?: string;
  branches?: string[];
  /** Slugs of stash entries waiting on main (newest first). */
  stashes?: string[];
}

const SESSION_BRANCH = /^session\//;
const IDEA_BRANCH = /^idea\//;

// ── location resolution ──────────────────────────────────────────────────────

export function myaiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MYAI_HOME || join(homedir(), '.myai');
}

export function resolveBrainDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MYAI_BRAIN_DIR) return env.MYAI_BRAIN_DIR;
  const pointer = join(myaiHome(env), 'brain.path');
  if (existsSync(pointer)) {
    const first = readFileSync(pointer, 'utf8').split('\n')[0].trim();
    if (first) return first;
  }
  return join(myaiHome(env), 'brain');
}

export function isBrainRepo(dir: string): boolean {
  return existsSync(join(dir, '.git')) && existsSync(join(dir, 'BRAIN.md'));
}

// ── git plumbing ─────────────────────────────────────────────────────────────

function git(dir: string, ...args: string[]): string {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (res.error) throw new Error(`brain: git unavailable: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`brain: git ${args[0]} failed: ${(res.stderr || res.stdout || '').trim()}`);
  }
  return res.stdout.trim();
}

function gitOk(dir: string, ...args: string[]): boolean {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return res.status === 0;
}

// ── shared naming helpers (contract shared with brain.sh) ────────────────────

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function brainHost(env: NodeJS.ProcessEnv = process.env): string {
  return slugify(env.BRAIN_HOST || hostname().split('.')[0] || 'unknown');
}

export function sha8(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);
}

function utcStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// ── remote auto-sync (push-on-merge / pull-on-boot) ──────────────────────────
//
// When the brain has an `origin` remote, sync is invisible: merges and stashes
// push main, boots (context_boot / brain_delta / session start) do a bounded
// fast-fail fetch + ff-only pull. Every network op is NON-FATAL — offline stays
// first-class (documentation/BRAIN_OFFLINE.md). Bash mirror: brain_sync_push /
// brain_sync_pull in scripts/lib/brain.sh.

/** Bounded network-git timeout — fast-fail so a boot can never hang offline. */
const NET_TIMEOUT_MS = Number(process.env.BRAIN_NET_TIMEOUT_MS) || 2000;

export function brainRemoteUrl(dir: string): string | undefined {
  const res = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

function netGitOk(dir: string, ...args: string[]): boolean {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: NET_TIMEOUT_MS });
  return res.status === 0;
}

export interface BrainSyncResult {
  synced: boolean;
  /** Why the sync didn't happen — absent when synced. */
  reason?: 'no-brain' | 'no-remote' | 'offline' | 'dirty' | 'diverged';
}

/** Push main to origin. Never throws — offline is a reported no-op. */
export function brainSyncPush(env: NodeJS.ProcessEnv = process.env): BrainSyncResult {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) return { synced: false, reason: 'no-brain' };
  if (!brainRemoteUrl(dir)) return { synced: false, reason: 'no-remote' };
  return netGitOk(dir, 'push', '-q', 'origin', 'main')
    ? { synced: true }
    : { synced: false, reason: 'offline' };
}

/**
 * Bounded fetch + ff-only advance of local main. Never merges or rebases:
 * diverged/dirty → no-op (the next push-on-merge reconciles). Never throws.
 */
export function brainSyncPull(env: NodeJS.ProcessEnv = process.env): BrainSyncResult {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) return { synced: false, reason: 'no-brain' };
  if (!brainRemoteUrl(dir)) return { synced: false, reason: 'no-remote' };
  if (!netGitOk(dir, 'fetch', '-q', 'origin', 'main')) return { synced: false, reason: 'offline' };
  if (git(dir, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main') {
    if (git(dir, 'status', '--porcelain') !== '') return { synced: false, reason: 'dirty' };
    return gitOk(dir, 'merge', '-q', '--ff-only', 'origin/main')
      ? { synced: true }
      : { synced: false, reason: 'diverged' };
  }
  // main not checked out → ff-only ref update (git refuses non-ff without +).
  return gitOk(dir, 'fetch', '-q', '.', 'refs/remotes/origin/main:refs/heads/main')
    ? { synced: true }
    : { synced: false, reason: 'diverged' };
}

// ── code provenance helpers (BRAIN B5, contract shared with brain.sh) ────────

const CODE_SHA = /^[0-9a-f]{7,40}$/;

function normalizeCodeSha(sha: string, what: string): string {
  const s = sha.trim().toLowerCase();
  if (!CODE_SHA.test(s)) throw new Error(`brain: ${what} '${sha}' is not a git SHA (7-40 hex chars)`);
  return s;
}

/** Validated copy of a provenance stamp; null when there is nothing to stamp. */
function normalizeProvenance(code?: CodeProvenance): Required<Pick<CodeProvenance, 'commits'>> & CodeProvenance | null {
  if (!code) return null;
  const repo = code.repo ? slugify(code.repo) : undefined;
  const branch = code.branch?.trim() || undefined;
  const sha = code.sha ? normalizeCodeSha(code.sha, 'code.sha') : undefined;
  const commits = (code.commits || []).map((c) => normalizeCodeSha(c, 'code.commits[]'));
  if (!repo && !branch && !sha && commits.length === 0) return null;
  return { repo, branch, sha, commits };
}

// ── init ─────────────────────────────────────────────────────────────────────

const BRAIN_MANIFEST = `# myAI Brain

Git-versioned agent memory. Sessions = commits, wrap up = merge, \`main\` = the
consolidated truth every agent boots from.

- \`memory/\` — cross-repo memory facts (append-only atoms)
- \`repos/<name>/sessions/\` — session blocks (append-only atoms)
- \`repos/<name>/handoffs/\` — handoff entries (append-only atoms)
- \`repos/<name>/brief.md\` — compiled boot brief (~150 tokens)
- \`repos/<name>/working.md\` — compiled working context (~2k tokens)

Atoms are immutable once written — never edit them; write a new atom.
Compiled artifacts (\`brief.md\`, \`working.md\`) are regenerated by the distiller
(\`brain merge\`) and are the ONLY files here that change in place.

Managed by \`myai brain\` (scripts/lib/brain.sh · runtime/src/core/brain.ts).
`;

/**
 * Create (or adopt) the brain repo and record the machine-wide pointer file.
 * Idempotent — an existing brain is never re-initialized.
 */
export function brainInit(
  opts: BrainInitOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): { dir: string; created: boolean } {
  const home = myaiHome(env);
  let dir = opts.dir || join(home, 'brain');
  if (!isAbsolute(dir)) dir = resolve(dir);
  mkdirSync(home, { recursive: true });

  if (isBrainRepo(dir)) {
    if (opts.pointer !== false) writeFileSync(join(home, 'brain.path'), `${dir}\n`);
    if (opts.remote && !gitOk(dir, 'remote', 'get-url', 'origin')) {
      git(dir, 'remote', 'add', 'origin', opts.remote);
    }
    return { dir, created: false };
  }
  if (existsSync(dir) && !existsSync(join(dir, '.git')) && readdirSync(dir).length > 0) {
    throw new Error(`brain: ${dir} exists and is not empty (and not a brain repo) — refusing`);
  }

  mkdirSync(join(dir, 'memory'), { recursive: true });
  mkdirSync(join(dir, 'repos'), { recursive: true });
  if (!gitOk(dir, 'init', '-q', '-b', 'main')) {
    git(dir, 'init', '-q');
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  }
  // Local identity so headless/runner commits never depend on global git config.
  git(dir, 'config', 'user.name', 'myai-brain');
  git(dir, 'config', 'user.email', 'brain@myai.local');
  git(dir, 'config', 'commit.gpgsign', 'false');

  writeFileSync(join(dir, 'BRAIN.md'), BRAIN_MANIFEST);
  writeFileSync(join(dir, 'memory', '.gitkeep'), '');
  writeFileSync(join(dir, 'repos', '.gitkeep'), '');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'brain: init store (layout v1)');
  if (opts.remote) git(dir, 'remote', 'add', 'origin', opts.remote);

  if (opts.pointer !== false) writeFileSync(join(home, 'brain.path'), `${dir}\n`);
  return { dir, created: true };
}

// ── project namespaces + compiled artifacts ──────────────────────────────────

/**
 * Ensure repos/<name>/ exists with sessions/, handoffs/ and placeholder
 * compiled artifacts (brief.md + working.md — the B3 distiller regenerates
 * them). Commits only when newly created. Returns the namespace's abs path.
 */
export function ensureNamespace(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) throw new Error(`brain: no brain repo at ${dir} — run 'myai brain init'`);
  const ns = slugify(name);
  if (!ns) throw new Error('brain: namespace name required');
  const nsDir = join(dir, 'repos', ns);
  if (!existsSync(nsDir)) {
    mkdirSync(join(nsDir, 'sessions'), { recursive: true });
    mkdirSync(join(nsDir, 'handoffs'), { recursive: true });
    writeFileSync(join(nsDir, 'sessions', '.gitkeep'), '');
    writeFileSync(join(nsDir, 'handoffs', '.gitkeep'), '');
    writeFileSync(
      join(nsDir, 'brief.md'),
      `# ${ns} — boot brief\n\n_Not compiled yet. The distiller (\`brain merge\`) fills this (~150 tokens)._\n`,
    );
    writeFileSync(
      join(nsDir, 'working.md'),
      `# ${ns} — working context\n\n_Not compiled yet. The distiller (\`brain merge\`) fills this (~2k tokens)._\n`,
    );
    git(dir, 'add', `repos/${ns}`);
    git(dir, 'commit', '-q', '-m', `brain(ns): add repo namespace ${ns}`);
  }
  return nsDir;
}

// ── append-only atoms ────────────────────────────────────────────────────────

/**
 * Append one immutable atom and commit it on the CURRENT branch. Dedup: an
 * existing <slug>-<sha8> match in the target dir returns created:false.
 */
export function writeAtom(input: AtomInput, env: NodeJS.ProcessEnv = process.env): AtomResult {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) throw new Error(`brain: no brain repo at ${dir} — run 'myai brain init'`);
  const slug = slugify(input.slug);
  if (!slug) throw new Error('brain: atom slug required');
  if (!input.content || !input.content.trim()) throw new Error('brain: empty atom content');

  const subdir = { memory: 'memory', session: 'sessions', handoff: 'handoffs' }[input.kind];
  if (!subdir) throw new Error(`brain: kind must be session|handoff|memory (got '${input.kind}')`);

  let relDir: string;
  const repo = input.repo && input.repo !== '-' ? slugify(input.repo) : '';
  if (input.kind === 'memory' && !repo) {
    relDir = 'memory';
  } else {
    if (!repo) throw new Error(`brain: kind '${input.kind}' requires a repo name`);
    ensureNamespace(repo, env);
    relDir = `repos/${repo}/${subdir}`;
  }

  const hash = sha8(input.content);
  const suffix = `-${slug}-${hash}.md`;
  const existing = readdirSync(join(dir, relDir)).find((f) => f.endsWith(suffix));
  if (existing) return { path: `${relDir}/${existing}`, sha8: hash, created: false };

  // Session-atom quality lint runs against what's on disk BEFORE this write.
  const lint = input.kind === 'session' ? lintSessionAtom(input.content, latestAtomBody(dir, relDir)) : undefined;

  const ts = utcStamp();
  const host = brainHost(env);
  const rel = `${relDir}/${ts}-${host}-${slug}-${hash}.md`;
  const abs = join(dir, rel);
  if (existsSync(abs)) throw new Error(`brain: refusing to overwrite existing atom ${rel}`);

  // BRAIN B5: provenance goes in the frontmatter (human/file side) AND as git
  // trailers on the brain commit (git side — what brainBlame greps).
  const prov = normalizeProvenance(input.code);
  const provRepo = prov ? prov.repo || repo || undefined : undefined;
  const fmLines = [
    '---',
    `kind: ${input.kind}`,
    `repo: ${repo || '—'}`,
    `slug: ${slug}`,
    `host: ${host}`,
    `written: ${ts}`,
  ];
  if (prov) {
    if (provRepo) fmLines.push(`code-repo: ${provRepo}`);
    if (prov.branch) fmLines.push(`code-branch: ${prov.branch}`);
    if (prov.sha) fmLines.push(`code-sha: ${prov.sha}`);
    if (prov.commits.length) fmLines.push(`code-commits: ${prov.commits.join(' ')}`);
  }
  fmLines.push('---', '');
  writeFileSync(abs, `${fmLines.join('\n')}\n${input.content}\n`);
  git(dir, 'add', rel);
  let message = `brain(${input.kind}): ${repo || 'memory'}/${slug}`;
  if (prov) {
    const trailers = [
      ...(provRepo ? [`Code-Repo: ${provRepo}`] : []),
      ...(prov.branch ? [`Code-Branch: ${prov.branch}`] : []),
      ...(prov.sha ? [`Code-SHA: ${prov.sha}`] : []),
      ...prov.commits.map((c) => `Code-Commit: ${c}`),
    ];
    message += `\n\n${trailers.join('\n')}`;
  }
  git(dir, 'commit', '-q', '-m', message);
  return { path: rel, sha8: hash, created: true, ...(lint ? { lint } : {}) };
}

// ── session / idea branch lifecycle ──────────────────────────────────────────

/** Create (or resume) today's session branch: session/<YYYYMMDD>-<host>-<profile>. */
export function sessionStart(profile = 'cli', env: NodeJS.ProcessEnv = process.env): string {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) throw new Error(`brain: no brain repo at ${dir} — run 'myai brain init'`);
  // Pull-on-boot: catch up main from origin before branching (bounded, non-fatal).
  brainSyncPull(env);
  const day = utcStamp().slice(0, 8);
  const branch = `session/${day}-${brainHost(env)}-${slugify(profile) || 'cli'}`;
  if (gitOk(dir, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`)) {
    git(dir, 'checkout', '-q', branch);
  } else {
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'checkout', '-q', '-b', branch);
  }
  return branch;
}

/**
 * Merge a session (or idea) branch into main with --no-ff and delete it
 * (idea/ branches are long-lived and survive the merge). Conflict → abort the
 * merge, restore the branch checkout, throw.
 */
export function sessionMerge(branch?: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) throw new Error(`brain: no brain repo at ${dir}`);
  const target = branch || git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (target === 'main') throw new Error('brain: already on main — nothing to merge');
  if (!SESSION_BRANCH.test(target) && !IDEA_BRANCH.test(target)) {
    throw new Error(`brain: refusing to merge non-session branch '${target}'`);
  }
  if (!gitOk(dir, 'show-ref', '--verify', '--quiet', `refs/heads/${target}`)) {
    throw new Error(`brain: no such branch '${target}'`);
  }
  git(dir, 'checkout', '-q', 'main');
  if (!gitOk(dir, 'merge', '-q', '--no-ff', '-m', `brain(merge): ${target}`, target)) {
    spawnSync('git', ['-C', dir, 'merge', '--abort'], { encoding: 'utf8' });
    git(dir, 'checkout', '-q', target);
    throw new Error(
      `brain: CONFLICT merging ${target} into main — left unmerged (atoms are append-only; check compiled artifacts)`,
    );
  }
  if (SESSION_BRANCH.test(target)) git(dir, 'branch', '-q', '-D', target);
  return target;
}

/** Create (or resume) a long-lived idea branch off main. */
export function ideaBranch(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) throw new Error(`brain: no brain repo at ${dir} — run 'myai brain init'`);
  const s = slugify(slug);
  if (!s) throw new Error('brain: idea slug required');
  const branch = `idea/${s}`;
  if (gitOk(dir, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`)) {
    git(dir, 'checkout', '-q', branch);
  } else {
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'checkout', '-q', '-b', branch);
  }
  return branch;
}

// ── status ───────────────────────────────────────────────────────────────────

export function brainStatus(env: NodeJS.ProcessEnv = process.env): BrainStatus {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) return { dir, initialized: false };

  const countAtoms = (d: string): number => {
    if (!existsSync(d)) return 0;
    return readdirSync(d).filter((f) => f.endsWith('.md')).length;
  };
  const reposDir = join(dir, 'repos');
  const namespaces = existsSync(reposDir)
    ? readdirSync(reposDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  let sessions = 0;
  let handoffs = 0;
  for (const ns of namespaces) {
    sessions += countAtoms(join(reposDir, ns, 'sessions'));
    handoffs += countAtoms(join(reposDir, ns, 'handoffs'));
  }
  const branches = git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/session/*', 'refs/heads/idea/*')
    .split('\n')
    .filter(Boolean);
  return {
    dir,
    initialized: true,
    branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    namespaces: namespaces.length,
    atoms: { sessions, handoffs, memory: countAtoms(join(dir, 'memory')) },
    lastCommit: git(dir, 'log', '-1', '--format=%h %s'),
    branches,
    stashes: listStashes(env).map((s) => s.slug),
  };
}

// ── brain explore: read-only browsable snapshot (dashboard /brain) ───────────
//
// Everything the /brain explorer page renders in one tenant-scoped, read-only
// pass: the namespaces with their per-kind atom counts, a recent slice of the
// actual atoms (parsed frontmatter, newest first), the open stashes (with a
// body preview), the session/idea branches, recent commits, and the code↔memory
// provenance links recorded on HEAD. Never checks out, merges, or writes — pure
// inspection over the on-disk store (the working tree of the current branch).

export interface BrainAtomMeta {
  /** Path within the brain repo, e.g. repos/foo/sessions/<ts>-...-<sha>.md */
  path: string;
  file: string;
  kind: AtomKind;
  /** '' for cross-repo memory atoms. */
  repo: string;
  slug: string;
  host: string;
  /** UTC stamp from frontmatter (YYYYMMDDTHHMMSSZ). */
  written: string;
  sha8: string;
  /** Code provenance recorded in the atom's frontmatter (BRAIN B5), if any. */
  code?: { repo?: string; branch?: string; sha?: string; commits: string[] };
}

export interface BrainNamespaceSummary {
  name: string;
  sessions: number;
  handoffs: number;
  hasBrief: boolean;
  hasWorking: boolean;
}

export interface BrainStashDetail {
  slug: string;
  path: string;
  file: string;
  from?: string;
  repo?: string;
  host?: string;
  written?: string;
  /** First slice of the frozen body (read-only preview; capped). */
  preview: string;
}

/** The three EXPENSIVE explorer sections the dashboard can request à la carte —
 *  each maps to one dashboard tab. Namespaces, totals, branches, recent commits
 *  and the open-stash COUNT are always cheap and always returned; these three
 *  cost per-atom file reads or extra git subprocesses, so an off-tab load skips
 *  them (e.g. Overview never pays for the provenance blame walk). */
export type BrainSection = 'atoms' | 'stashes' | 'provenance';

export interface BrainExplore {
  dir: string;
  initialized: boolean;
  branch?: string;
  lastCommit?: string;
  namespaces: BrainNamespaceSummary[];
  memoryAtoms: number;
  totals: { sessions: number; handoffs: number; memory: number; namespaces: number };
  /** Recent atoms across every namespace + cross-repo memory, newest first. */
  atoms: BrainAtomMeta[];
  atomsTruncated: boolean;
  stashes: BrainStashDetail[];
  branches: { sessions: string[]; ideas: string[] };
  recentCommits: BrainLogEntry[];
  provenance: BrainBlameEntry[];
}

/** Parse the leading `--- ... ---` frontmatter block into a key→value map. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n\n?/);
  if (!fm) return { meta, body: raw };
  for (const line of fm[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: raw.slice(fm[0].length) };
}

/** Turn an atom filename `<ts>-<host>-<slug>-<sha8>.md` into a meta record,
 *  preferring the frontmatter where present (host/slug can contain dashes). */
function readAtomMeta(dir: string, rel: string, kind: AtomKind, repo: string): BrainAtomMeta {
  const file = rel.slice(rel.lastIndexOf('/') + 1);
  const shaMatch = file.match(/-([0-9a-f]{8})\.md$/);
  const sha8 = shaMatch ? shaMatch[1] : '';
  let meta: Record<string, string> = {};
  try {
    meta = parseFrontmatter(readFileSync(join(dir, rel), 'utf8')).meta;
  } catch {
    // Unreadable atom → fall back to filename-derived fields (best effort).
  }
  const atom: BrainAtomMeta = {
    path: rel,
    file,
    kind,
    repo: meta.repo && meta.repo !== '—' ? meta.repo : repo,
    slug: meta.slug || file.replace(/\.md$/, ''),
    host: meta.host || '',
    written: meta.written || '',
    sha8,
  };
  const commits = meta['code-commits'] ? meta['code-commits'].split(/\s+/).filter(Boolean) : [];
  if (meta['code-repo'] || meta['code-branch'] || meta['code-sha'] || commits.length) {
    atom.code = {
      repo: meta['code-repo'] || undefined,
      branch: meta['code-branch'] || undefined,
      sha: meta['code-sha'] || undefined,
      commits,
    };
  }
  return atom;
}

const EXPLORE_ATOM_CAP = 60;
const STASH_PREVIEW_CHARS = 240;

/**
 * A single read-only pass over the brain store for the dashboard explorer.
 * `atomLimit` caps how many recent atoms are returned (default 60); the rest are
 * summarised only by the per-namespace counts.
 */
export function brainExplore(
  opts: { atomLimit?: number; sections?: BrainSection[] } = {},
  env: NodeJS.ProcessEnv = process.env,
): BrainExplore {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) {
    return {
      dir,
      initialized: false,
      namespaces: [],
      memoryAtoms: 0,
      totals: { sessions: 0, handoffs: 0, memory: 0, namespaces: 0 },
      atoms: [],
      atomsTruncated: false,
      stashes: [],
      branches: { sessions: [], ideas: [] },
      recentCommits: [],
      provenance: [],
    };
  }
  const atomLimit = Math.min(Math.max(Math.trunc(opts.atomLimit || EXPLORE_ATOM_CAP), 1), 200);
  // Which of the three EXPENSIVE sections to compute. Default (undefined) = all,
  // so the MCP tool contract and every existing caller/test stay unchanged; the
  // dashboard passes only the active tab's section so e.g. Overview never pays
  // for the atom file reads, per-stash previews, or the provenance blame walk.
  const want = (s: BrainSection) => !opts.sections || opts.sections.includes(s);

  const listFiles = (relDir: string): string[] => {
    const abs = join(dir, relDir);
    if (!existsSync(abs)) return [];
    return readdirSync(abs).filter((f) => f.endsWith('.md'));
  };

  const reposDir = join(dir, 'repos');
  const nsNames = existsSync(reposDir)
    ? readdirSync(reposDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];

  // Namespaces + totals from readdir COUNTS only — no per-atom file reads. Atom
  // rel-paths are collected (filename only) so the atoms section can sort by the
  // filename UTC-stamp and read frontmatter for the top-N slice ALONE.
  type AtomRef = { rel: string; file: string; kind: AtomKind; ns: string };
  const refs: AtomRef[] = [];
  const namespaces: BrainNamespaceSummary[] = [];
  let totalSessions = 0;
  let totalHandoffs = 0;
  for (const ns of nsNames) {
    const sessionFiles = listFiles(`repos/${ns}/sessions`);
    const handoffFiles = listFiles(`repos/${ns}/handoffs`);
    totalSessions += sessionFiles.length;
    totalHandoffs += handoffFiles.length;
    namespaces.push({
      name: ns,
      sessions: sessionFiles.length,
      handoffs: handoffFiles.length,
      hasBrief: existsSync(join(reposDir, ns, 'brief.md')),
      hasWorking: existsSync(join(reposDir, ns, 'working.md')),
    });
    if (want('atoms')) {
      for (const f of sessionFiles) refs.push({ rel: `repos/${ns}/sessions/${f}`, file: f, kind: 'session', ns });
      for (const f of handoffFiles) refs.push({ rel: `repos/${ns}/handoffs/${f}`, file: f, kind: 'handoff', ns });
    }
  }
  const memoryFiles = listFiles('memory');
  const memoryAtoms = memoryFiles.length;
  if (want('atoms')) {
    for (const f of memoryFiles) refs.push({ rel: `memory/${f}`, file: f, kind: 'memory', ns: '' });
  }
  const totalAtoms = totalSessions + totalHandoffs + memoryAtoms;

  // Atoms: the filename `<ts>-<host>-<slug>-<sha8>.md` embeds the same dash-free,
  // fixed-width UTC stamp that goes in the frontmatter `written` (see writeAtom),
  // so a descending filename sort is newest-first WITHOUT reading a single file.
  // We readFileSync frontmatter for the top-N slice only — not the whole store.
  let atoms: BrainAtomMeta[] = [];
  if (want('atoms')) {
    refs.sort((a, b) => b.file.localeCompare(a.file));
    atoms = refs.slice(0, atomLimit).map((r) => readAtomMeta(dir, r.rel, r.kind, r.ns));
  }

  // Open-stash COUNT is always shown in the header, but the per-stash `git show`
  // preview is only needed on the stashes tab. Enumerate cheaply (one ls-tree),
  // and pay for the frontmatter/preview reads only when the section is requested.
  const stashFiles = gitOk(dir, 'rev-parse', '--verify', '--quiet', 'main:stash')
    ? git(dir, 'ls-tree', '--name-only', 'main', 'stash/').split('\n').filter((f) => f.endsWith('.md'))
    : [];
  let stashes: BrainStashDetail[];
  if (want('stashes')) {
    stashes = listStashes(env).map((s) => {
      let preview = '';
      let meta: Record<string, string> = {};
      try {
        const parsed = parseFrontmatter(git(dir, 'show', `main:${s.path}`));
        meta = parsed.meta;
        preview = parsed.body.trim().slice(0, STASH_PREVIEW_CHARS);
      } catch {
        // Stash unreadable (raced pop) → surface the slug only.
      }
      return {
        slug: s.slug,
        path: s.path,
        file: s.file,
        from: meta.from || undefined,
        repo: meta.repo && meta.repo !== '—' ? meta.repo : undefined,
        host: meta.host || undefined,
        written: meta.written || undefined,
        preview,
      };
    });
  } else {
    // Count-only placeholders — the header reads `.length`; previews go unused
    // off-tab, so skip the per-stash `git show` and derive the slug cheaply.
    stashes = stashFiles.map((path) => ({
      slug: path.slice('stash/'.length).replace(/\.md$/, ''),
      path,
      file: path.slice('stash/'.length),
      preview: '',
    }));
  }

  const branchRefs = git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/session/*', 'refs/heads/idea/*')
    .split('\n')
    .filter(Boolean);

  // Provenance: reverse blame from HEAD lists the code SHAs the brain recorded.
  // The heaviest git op here — computed only on the provenance tab.
  let provenance: BrainBlameEntry[] = [];
  if (want('provenance')) {
    try {
      provenance = brainBlame({ ref: 'HEAD', limit: 25 }, env).entries.filter((e) => e.code.commits.length || e.code.sha);
    } catch {
      // brainBlame is best-effort here — never fail the explorer over provenance.
    }
  }

  return {
    dir,
    initialized: true,
    branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    lastCommit: git(dir, 'log', '-1', '--format=%h %s'),
    namespaces,
    memoryAtoms,
    totals: { sessions: totalSessions, handoffs: totalHandoffs, memory: memoryAtoms, namespaces: nsNames.length },
    atoms,
    atomsTruncated: want('atoms') && totalAtoms > atoms.length,
    stashes,
    branches: {
      sessions: branchRefs.filter((b) => SESSION_BRANCH.test(b)),
      ideas: branchRefs.filter((b) => IDEA_BRANCH.test(b)),
    },
    recentCommits: brainLog({ limit: 15 }, env),
    provenance,
  };
}

// ── B2 gateway ops: checkout / log / diff / revert / stash ──────────────────
//
// Server-side git verbs the brain_* MCP tools expose (agents never touch the
// brain repo directly). All of them operate on the SAME on-disk store as the
// B1 primitives above; none of them ever force-push, rewrite history, or edit
// an existing atom.

/** Refs an agent may check out: the truth branch + the two managed families. */
const CHECKOUTABLE = /^(main|session\/[a-z0-9][a-z0-9/_-]*|idea\/[a-z0-9][a-z0-9/_-]*)$/;

function requireBrain(env: NodeJS.ProcessEnv): string {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) throw new Error(`brain: no brain repo at ${dir} — run 'myai brain init'`);
  return dir;
}

function requireCleanTree(dir: string): void {
  if (git(dir, 'status', '--porcelain') !== '') {
    throw new Error('brain: working tree is dirty — brain ops always commit; refusing to proceed');
  }
}

/** Check out main or an existing session/idea branch. Returns the branch name. */
export function brainCheckout(ref: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = requireBrain(env);
  if (!CHECKOUTABLE.test(ref)) {
    throw new Error(`brain: refusing checkout of '${ref}' — only main, session/* or idea/*`);
  }
  if (!gitOk(dir, 'show-ref', '--verify', '--quiet', `refs/heads/${ref}`)) {
    throw new Error(`brain: no such branch '${ref}'`);
  }
  requireCleanTree(dir);
  git(dir, 'checkout', '-q', ref);
  return ref;
}

export interface BrainLogEntry {
  sha: string;
  short: string;
  date: string;
  subject: string;
}

/** Commit history of a ref (default HEAD), optionally scoped to a path. */
export function brainLog(
  opts: { ref?: string; path?: string; limit?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): BrainLogEntry[] {
  const dir = requireBrain(env);
  const limit = Math.min(Math.max(Math.trunc(opts.limit || 20), 1), 200);
  const args = ['log', `-n${limit}`, '--format=%H%x09%h%x09%aI%x09%s'];
  if (opts.ref) {
    if (!gitOk(dir, 'rev-parse', '--verify', '--quiet', `${opts.ref}^{commit}`)) {
      throw new Error(`brain: unknown ref '${opts.ref}'`);
    }
    args.push(opts.ref);
  }
  if (opts.path) args.push('--', opts.path);
  const out = git(dir, ...args);
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [sha, short, date, ...rest] = line.split('\t');
    return { sha, short, date, subject: rest.join('\t') };
  });
}

export interface BrainDiff {
  from: string;
  to: string;
  files: Array<{ status: string; path: string }>;
  stat: string;
  /** Unified patch, present when requested; truncated to `patchLimit` chars. */
  patch?: string;
  patchTruncated?: boolean;
}

const PATCH_LIMIT = 20_000;

/**
 * Diff two refs (default main..HEAD — "what has this session added that main
 * doesn't have yet"), optionally scoped to a path.
 */
export function brainDiff(
  opts: { from?: string; to?: string; path?: string; patch?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): BrainDiff {
  const dir = requireBrain(env);
  const from = opts.from || 'main';
  const to = opts.to || 'HEAD';
  for (const ref of [from, to]) {
    if (!gitOk(dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)) {
      throw new Error(`brain: unknown ref '${ref}'`);
    }
  }
  const range = [`${from}..${to}`];
  const scope = opts.path ? ['--', opts.path] : [];
  const files = git(dir, 'diff', '--name-status', ...range, ...scope)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...path] = line.split('\t');
      return { status, path: path.join('\t') };
    });
  const stat = git(dir, 'diff', '--shortstat', ...range, ...scope);
  const result: BrainDiff = { from, to, files, stat };
  if (opts.patch) {
    const patch = git(dir, 'diff', ...range, ...scope);
    result.patch = patch.slice(0, PATCH_LIMIT);
    result.patchTruncated = patch.length > PATCH_LIMIT;
  }
  return result;
}

/**
 * Revert a commit with an inverse commit (history is never rewritten — atoms
 * stay append-only; the revert itself is a new commit). Merge commits revert
 * against their first parent. Conflict → abort, throw.
 */
export function brainRevert(
  sha: string,
  env: NodeJS.ProcessEnv = process.env,
): { reverted: string; revertCommit: string } {
  const dir = requireBrain(env);
  if (!gitOk(dir, 'rev-parse', '--verify', '--quiet', `${sha}^{commit}`)) {
    throw new Error(`brain: unknown commit '${sha}'`);
  }
  requireCleanTree(dir);
  const full = git(dir, 'rev-parse', `${sha}^{commit}`);
  const isMerge = git(dir, 'rev-list', '--parents', '-n1', full).split(' ').length > 2;
  const args = ['revert', '--no-edit', ...(isMerge ? ['-m', '1'] : []), full];
  if (!gitOk(dir, ...args)) {
    spawnSync('git', ['-C', dir, 'revert', '--abort'], { encoding: 'utf8' });
    throw new Error(`brain: CONFLICT reverting ${sha} — aborted, brain unchanged`);
  }
  return { reverted: full, revertCommit: git(dir, 'rev-parse', 'HEAD') };
}

// ── brain blame: code↔memory provenance lookup (BRAIN B5) ────────────────────

export interface BrainBlameEntry {
  /** Brain commit. */
  sha: string;
  short: string;
  date: string;
  subject: string;
  /** Atom files this brain commit added (the session logs / memory facts). */
  atoms: string[];
  /** Code provenance recorded on the commit (git trailers). */
  code: { repo?: string; branch?: string; sha?: string; commits: string[] };
}

export interface BrainBlameResult {
  direction: 'code->brain' | 'brain->code';
  query: string;
  entries: BrainBlameEntry[];
}

/** Parse one brain commit's Code-* trailers + touched atom files. */
function blameEntry(dir: string, sha: string): BrainBlameEntry {
  const [meta, ...body] = git(dir, 'show', '-s', '--format=%H%x09%h%x09%aI%x09%s%n%B', sha).split('\n');
  const [full, short, date, ...subj] = meta.split('\t');
  const code: BrainBlameEntry['code'] = { commits: [] };
  for (const line of body) {
    const m = line.match(/^Code-(Repo|Branch|SHA|Commit): (.+)$/);
    if (!m) continue;
    const value = m[2].trim();
    if (m[1] === 'Repo') code.repo = value;
    else if (m[1] === 'Branch') code.branch = value;
    else if (m[1] === 'SHA') code.sha = value;
    else code.commits.push(value);
  }
  const atoms = git(dir, 'show', '--format=', '--name-only', '--diff-merges=first-parent', sha)
    .split('\n')
    .filter((f) => f.endsWith('.md') && (f.startsWith('memory/') || /^repos\/[^/]+\/(sessions|handoffs)\//.test(f)));
  return { sha: full, short, date, subject: subj.join('\t'), atoms, code };
}

/**
 * Provenance lookup in either direction (BRAIN B5):
 *   • codeSha (full or ≥7-char prefix) → the brain commits whose Code-SHA /
 *     Code-Commit trailers reference it — "what was the agent thinking when it
 *     produced code commit X", with the atom files (session logs) to read.
 *   • ref (brain branch/commit, e.g. idea/<slug>) → every code SHA its commits
 *     recorded — "what code did this line of thinking produce".
 */
export function brainBlame(
  opts: { codeSha?: string; ref?: string; limit?: number },
  env: NodeJS.ProcessEnv = process.env,
): BrainBlameResult {
  const dir = requireBrain(env);
  const limit = Math.min(Math.max(Math.trunc(opts.limit || 50), 1), 200);
  if (opts.codeSha && opts.ref) throw new Error('brain: blame takes codeSha OR ref, not both');

  if (opts.codeSha) {
    const query = normalizeCodeSha(opts.codeSha, 'codeSha');
    // --grep narrows candidates cheaply; trailer parsing below is the truth
    // (a SHA fragment could coincidentally appear in a subject line).
    const out = spawnSync(
      'git',
      ['-C', dir, 'log', '--all', `-n${limit * 4}`, '--format=%H', `--grep=${query}`],
      { encoding: 'utf8' },
    );
    const candidates = (out.stdout || '').split('\n').filter(Boolean);
    const entries = candidates
      .map((sha) => blameEntry(dir, sha))
      .filter((e) => e.code.sha?.startsWith(query) || e.code.commits.some((c) => c.startsWith(query)))
      .slice(0, limit);
    return { direction: 'code->brain', query, entries };
  }

  const ref = opts.ref || 'HEAD';
  if (!gitOk(dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)) {
    throw new Error(`brain: unknown ref '${ref}'`);
  }
  const shas = git(dir, 'log', `-n${limit * 4}`, '--format=%H', ref).split('\n').filter(Boolean);
  const entries: BrainBlameEntry[] = [];
  for (const sha of shas) {
    if (entries.length >= limit) break;
    const entry = blameEntry(dir, sha);
    if (entry.code.repo || entry.code.branch || entry.code.sha || entry.code.commits.length) {
      entries.push(entry);
    }
  }
  return { direction: 'brain->code', query: ref, entries };
}

// ── git-notes back-links: code-repo-side provenance index (BRAIN B9) ─────────
//
// The Code-* trailers writeAtom stamps answer provenance from the BRAIN repo
// (brainBlame, both directions). B9 completes the loop from the OTHER side: it
// attaches a git note on each produced CODE commit under refs/notes/myai-brain,
// so `git log --notes=myai-brain` in the code repo — with the brain not even
// present — shows which brain commit/atom documents it. Notes live on a
// SEPARATE ref: zero code-HISTORY pollution (no new code commit, nothing on the
// working branch changes). Node mirror of brain_capture_code / brain_note_code /
// brain_stamp_code in scripts/lib/brain.sh (same on-disk contract — twin tests
// in scripts/tests/test_brain.sh).

/** The dedicated notes ref the back-links live under (never the default notes). */
export const CODE_NOTES_REF = 'myai-brain';

function isGitRepo(dir: string): boolean {
  return gitOk(dir, 'rev-parse', '--git-dir');
}

/**
 * Read {repo, branch, sha} from a code checkout so the next writeAtom/stampCode
 * can stamp provenance. repo defaults to the checkout's directory basename.
 * Throws if `codeDir` is not a git repo.
 */
export function captureCode(codeDir: string): Required<Pick<CodeProvenance, 'repo' | 'branch' | 'sha'>> {
  if (!isGitRepo(codeDir)) throw new Error(`brain: ${codeDir} is not a git repo`);
  const top = git(codeDir, 'rev-parse', '--show-toplevel');
  return {
    repo: top.split(/[/\\]/).pop() || 'code',
    branch: git(codeDir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    sha: git(codeDir, 'rev-parse', 'HEAD'),
  };
}

/** One back-link recorded as a git note on a code commit. */
export interface CodeNoteLink {
  /** Brain commit SHA this code commit was linked to. */
  brainSha: string;
  /** Atom (session log) file the brain recorded for this link. */
  atom: string;
}

/**
 * Back-link code commits to a brain commit via git notes (refs/notes/myai-brain).
 * APPEND-only (a code commit may relate to several brain commits) and never adds
 * a code commit — notes are a separate ref. Returns how many commits were noted.
 */
export function noteCode(
  codeDir: string,
  brainSha: string,
  atomPath: string,
  codeShas: string[],
): { noted: number; ref: string } {
  if (!isGitRepo(codeDir)) throw new Error(`brain: ${codeDir} is not a git repo`);
  if (!codeShas.length) throw new Error('brain: noteCode requires at least one code SHA');
  const brain = normalizeCodeSha(brainSha, 'brainSha');
  const message = `myai-brain: ${brain} ${atomPath}`;
  let noted = 0;
  for (const c of codeShas) {
    const sha = normalizeCodeSha(c, 'codeShas[]');
    if (gitOk(codeDir, 'notes', `--ref=${CODE_NOTES_REF}`, 'append', '-m', message, sha)) noted++;
  }
  return { noted, ref: `refs/notes/${CODE_NOTES_REF}` };
}

/**
 * REVERSE lookup, read straight from the CODE repo (no brain needed): which
 * brain commits/atoms back-link this code commit. Empty when the commit carries
 * no myai-brain note. This is the code→brain direction served by the notes B9
 * writes — the mirror image of brainBlame's brain→code trailer read.
 */
export function readCodeNotes(codeDir: string, codeSha: string): CodeNoteLink[] {
  if (!isGitRepo(codeDir)) throw new Error(`brain: ${codeDir} is not a git repo`);
  const sha = normalizeCodeSha(codeSha, 'codeSha');
  const res = spawnSync('git', ['-C', codeDir, 'notes', `--ref=${CODE_NOTES_REF}`, 'show', sha], { encoding: 'utf8' });
  if (res.status !== 0) return []; // no note on this commit
  return res.stdout
    .split('\n')
    .map((l) => l.match(/^myai-brain: ([0-9a-f]{7,40}) (.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ brainSha: m[1], atom: m[2] }));
}

export interface StampCodeInput {
  /** Path to the code checkout the work happened in. */
  codeDir: string;
  /** Brain repo namespace (usually the code repo name). */
  repo: string;
  slug: string;
  content: string;
  /** Code commits this session produced (each gets a git-notes back-link). */
  commits?: string[];
}

export interface StampCodeResult {
  /** Repo-relative atom path on brain main. */
  atom: string;
  /** Brain commit that added the atom (what the code notes point at). */
  brainSha: string;
  /** How many code commits were back-linked with git notes. */
  noted: number;
  code: CodeProvenance;
}

/**
 * Runner one-shot (BRAIN B9): capture code provenance from `codeDir`, write ONE
 * session atom on a runner session branch, merge it to main, then
 * git-notes-back-link each produced code commit to that brain commit. Never
 * touches code history. Node mirror of brain_stamp_code (compile/distill is
 * layered on at the gateway, same as sessionMerge).
 */
export function stampCode(input: StampCodeInput, env: NodeJS.ProcessEnv = process.env): StampCodeResult {
  const dir = requireBrain(env);
  if (!input.content || !input.content.trim()) throw new Error('brain: stampCode empty content');
  const code = captureCode(input.codeDir);
  const commits = (input.commits || []).map((c) => normalizeCodeSha(c, 'commits[]'));
  sessionStart('runner', env);
  const atom = writeAtom(
    { kind: 'session', repo: input.repo, slug: input.slug, content: input.content, code: { ...code, commits } },
    env,
  );
  // Capture the atom-adding commit BEFORE merge — that is what the notes point
  // at (still reachable from main after the --no-ff merge).
  const brainSha = git(dir, 'rev-parse', 'HEAD');
  sessionMerge(undefined, env);
  const noted = commits.length ? noteCode(input.codeDir, brainSha, atom.path, commits).noted : 0;
  return { atom: atom.path, brainSha, noted, code: { ...code, commits } };
}

// ── stash: freeze context on main, resume from ANY session/device ───────────
//
// A brain stash is NOT `git stash` (which is local, ref-based and invisible to
// other checkouts): it is a FILE under stash/ committed straight to `main`, so
// any later session — different branch, different host, different agent — sees
// it after a plain pull and can pop it. Pop removes the file with a normal
// commit; nothing is ever rewritten.

export interface BrainStashEntry {
  slug: string;
  path: string;
  file: string;
}

export interface BrainStashResult extends BrainStashEntry {
  /** Branch the stasher was on (recorded in frontmatter, restored after). */
  from: string;
}

export interface BrainPopResult extends BrainStashEntry {
  content: string;
  meta: Record<string, string>;
}

/** List stash entries visible on main, newest first (by stash-commit order —
 * filenames only have second precision, so they can't order same-second stashes). */
export function listStashes(env: NodeJS.ProcessEnv = process.env): BrainStashEntry[] {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) return [];
  if (!gitOk(dir, 'rev-parse', '--verify', '--quiet', 'main:stash')) return [];
  const alive = new Set(
    git(dir, 'ls-tree', '--name-only', 'main', 'stash/').split('\n').filter((f) => f.endsWith('.md')),
  );
  const added = git(dir, 'log', 'main', '--diff-filter=A', '--name-only', '--format=', '--', 'stash/')
    .split('\n')
    .filter((p) => alive.has(p));
  return added.map((path) => {
    const file = path.slice('stash/'.length);
    // Slug comes from frontmatter, not the filename — hostnames may contain
    // dashes, which makes filename parsing ambiguous.
    const slugLine = git(dir, 'show', `main:${path}`).match(/^slug: (.+)$/m);
    const slug = slugLine ? slugLine[1].trim() : file.replace(/\.md$/, '');
    return { slug, path, file };
  });
}

/** Run fn with main checked out, then restore the original branch. */
function onMain<T>(dir: string, fn: () => T): T {
  const original = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  requireCleanTree(dir);
  if (original !== 'main') git(dir, 'checkout', '-q', 'main');
  try {
    return fn();
  } finally {
    if (original !== 'main') git(dir, 'checkout', '-q', original);
  }
}

/**
 * Freeze a context payload so ANY later session can resume it: the payload is
 * committed to `main` under stash/, independent of the current session branch.
 */
export function brainStash(
  input: { slug: string; content: string; repo?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): BrainStashResult {
  const dir = requireBrain(env);
  const slug = slugify(input.slug);
  if (!slug) throw new Error('brain: stash slug required');
  if (!input.content || !input.content.trim()) throw new Error('brain: empty stash content');

  const from = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  // Content hash in the filename (same contract as atoms): same-second stashes
  // with different payloads can never collide on a path.
  const file = `${utcStamp()}-${brainHost(env)}-${slug}-${sha8(input.content)}.md`;
  const rel = `stash/${file}`;
  if (gitOk(dir, 'cat-file', '-e', `main:${rel}`)) {
    return { slug, path: rel, file, from }; // identical stash already frozen — dedup
  }
  const result = onMain(dir, () => {
    mkdirSync(join(dir, 'stash'), { recursive: true });
    const frontmatter = [
      '---',
      `slug: ${slug}`,
      `repo: ${input.repo ? slugify(input.repo) : '—'}`,
      `from: ${from}`,
      `host: ${brainHost(env)}`,
      `written: ${utcStamp()}`,
      '---',
      '',
    ].join('\n');
    writeFileSync(join(dir, rel), `${frontmatter}\n${input.content}\n`);
    git(dir, 'add', rel);
    git(dir, 'commit', '-q', '-m', `brain(stash): ${slug}`);
    return { slug, path: rel, file, from };
  });
  // Stash pushes IMMEDIATELY — its whole point is cross-device resume.
  brainSyncPush(env);
  return result;
}

/**
 * Pop the newest stash (or the newest matching `slug`): returns the frozen
 * context and removes the entry from main with a normal commit.
 */
export function brainPop(
  slug?: string,
  env: NodeJS.ProcessEnv = process.env,
): BrainPopResult {
  const dir = requireBrain(env);
  const wanted = slug ? slugify(slug) : undefined;
  const entry = listStashes(env).find((s) => !wanted || s.slug === wanted);
  if (!entry) {
    throw new Error(wanted ? `brain: no stash matching '${wanted}'` : 'brain: no stashes to pop');
  }
  const raw = git(dir, 'show', `main:${entry.path}`);
  const meta: Record<string, string> = {};
  let content = raw;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n\n?/);
  if (fm) {
    content = raw.slice(fm[0].length);
    for (const line of fm[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  onMain(dir, () => {
    git(dir, 'rm', '-q', entry.path);
    git(dir, 'commit', '-q', '-m', `brain(pop): ${entry.slug}`);
  });
  return { ...entry, content: content.replace(/\n$/, ''), meta };
}

// ── gc: compact the store (dedup / prune / repack) ───────────────────────────
//
// Node mirror of brain_gc in scripts/lib/brain.sh — same contract: bound the
// store's growth WITHOUT rewriting history or mutating an atom's content. It
// removes only provably-redundant files (with normal, revertable commits) then
// repacks:
//   • atom dedup   — atoms sharing (dir, slug, content-sha8) collapse to the
//                    earliest; the survivor is byte-identical (recall unchanged)
//   • orphan prune — repos/<ns>/ namespaces with zero session+handoff atoms
//   • stash prune  — stashes frozen > stashMaxAgeDays ago and never popped
//   • repack       — `git gc --prune=now` folds loose objects + drops the now
//                    -unreachable blobs
// dryRun computes and returns the plan without touching the store.

export interface BrainGcOptions {
  /** Report the plan without mutating the store (default false). */
  dryRun?: boolean;
  /** Prune stashes frozen more than this many days ago (default 30). */
  stashMaxAgeDays?: number;
}

export interface BrainGcPlan {
  /** Repo-relative atom paths to remove (byte-identical duplicates). */
  dedupAtoms: string[];
  /** repos/<ns> namespaces to remove (no session/handoff atoms). */
  orphanNamespaces: string[];
  /** stash/<file> paths to remove (abandoned, past the age cutoff). */
  abandonedStashes: string[];
}

export interface BrainGcResult {
  dryRun: boolean;
  stashMaxAgeDays: number;
  dedupedAtoms: number;
  prunedNamespaces: number;
  prunedStashes: number;
  repacked: boolean;
  /** .git size in KB before / after (equal on a dry run). */
  bytesBefore: number;
  bytesAfter: number;
  reclaimedKb: number;
  plan: BrainGcPlan;
}

/** Recursive byte size of a directory tree (KB, matching `du -sk` granularity). */
function dirSizeKb(dir: string): number {
  let bytes = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) bytes += statSync(p).size;
    }
  };
  if (existsSync(dir)) walk(dir);
  return Math.ceil(bytes / 1024);
}

const ATOM_DIRS_GLOB = (dir: string): string[] => {
  const out: string[] = ['memory'];
  const reposDir = join(dir, 'repos');
  if (!existsSync(reposDir)) return out;
  for (const e of readdirSync(reposDir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(`repos/${e.name}/sessions`, `repos/${e.name}/handoffs`);
  }
  return out;
};

export function brainGc(
  opts: BrainGcOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): BrainGcResult {
  const dir = requireBrain(env);
  requireCleanTree(dir);
  const dryRun = opts.dryRun ?? false;
  const stashMaxAgeDays = Math.max(0, Math.trunc(opts.stashMaxAgeDays ?? 30));

  // ── plan: atom dedup ────────────────────────────────────────────────────────
  // Key = (reldir, slug, sha8). sha8 is the filename's trailing -<sha8>.md (=
  // sha8(body)); slug comes from frontmatter (avoids host/slug boundary parsing).
  // Files sort chronologically by their <ts> prefix, so keep the first per key.
  const dedupAtoms: string[] = [];
  const shaTail = /-([0-9a-f]{8})\.md$/;
  for (const reldir of ATOM_DIRS_GLOB(dir)) {
    const abs = join(dir, reldir);
    if (!existsSync(abs)) continue;
    const files = readdirSync(abs).filter((f) => f.endsWith('.md') && f !== '.gitkeep').sort();
    const seen = new Set<string>();
    for (const f of files) {
      const m = f.match(shaTail);
      if (!m) continue;
      const slugLine = readFileSync(join(abs, f), 'utf8').match(/^slug: (.+)$/m);
      const slug = slugLine ? slugLine[1].trim() : '';
      const key = `${reldir}|${slug}|${m[1]}`;
      if (seen.has(key)) dedupAtoms.push(`${reldir}/${f}`);
      else seen.add(key);
    }
  }

  // ── plan: orphan namespaces (zero session+handoff atoms) ─────────────────────
  const orphanNamespaces: string[] = [];
  const reposDir = join(dir, 'repos');
  if (existsSync(reposDir)) {
    for (const e of readdirSync(reposDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const count = ['sessions', 'handoffs'].reduce((n, sub) => {
        const d = join(reposDir, e.name, sub);
        return n + (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.md') && f !== '.gitkeep').length : 0);
      }, 0);
      if (count === 0) orphanNamespaces.push(`repos/${e.name}`);
    }
  }

  // ── plan: abandoned stashes (frozen past the age cutoff) ─────────────────────
  const abandonedStashes: string[] = [];
  if (stashMaxAgeDays >= 0) {
    const cutoff = Math.floor(Date.now() / 1000) - stashMaxAgeDays * 86400;
    for (const s of listStashes(env)) {
      const ct = Number(git(dir, 'log', '-1', '--format=%ct', '--', s.path));
      if (Number.isFinite(ct) && ct < cutoff) abandonedStashes.push(s.path);
    }
  }

  const plan: BrainGcPlan = { dedupAtoms, orphanNamespaces, abandonedStashes };
  const bytesBefore = dirSizeKb(join(dir, '.git'));

  if (dryRun) {
    return {
      dryRun: true, stashMaxAgeDays,
      dedupedAtoms: dedupAtoms.length, prunedNamespaces: orphanNamespaces.length, prunedStashes: abandonedStashes.length,
      repacked: false, bytesBefore, bytesAfter: bytesBefore, reclaimedKb: 0, plan,
    };
  }

  // ── apply on main (revertable commits), then repack ──────────────────────────
  onMain(dir, () => {
    const removals = [...dedupAtoms, ...orphanNamespaces, ...abandonedStashes];
    if (removals.length) {
      for (const p of dedupAtoms) git(dir, 'rm', '-q', '--', p);
      for (const ns of orphanNamespaces) git(dir, 'rm', '-q', '-r', '--', ns);
      for (const s of abandonedStashes) git(dir, 'rm', '-q', '--', s);
      git(dir, 'commit', '-q', '-m',
        `brain(gc): dedup ${dedupAtoms.length} atoms · prune ${orphanNamespaces.length} ns · ${abandonedStashes.length} stash`);
    }
    // Repack even with no removals — atom commits accrue loose objects regardless.
    if (!gitOk(dir, 'gc', '--prune=now', '--quiet')) gitOk(dir, 'gc', '--quiet');
  });
  brainSyncPush(env);

  const bytesAfter = dirSizeKb(join(dir, '.git'));
  return {
    dryRun: false, stashMaxAgeDays,
    dedupedAtoms: dedupAtoms.length, prunedNamespaces: orphanNamespaces.length, prunedStashes: abandonedStashes.length,
    repacked: true, bytesBefore, bytesAfter, reclaimedKb: Math.max(0, bytesBefore - bytesAfter), plan,
  };
}
