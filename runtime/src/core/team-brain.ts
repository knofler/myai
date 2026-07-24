/**
 * team-brain.ts — Team brain: a SHARED namespace in the brain store that every
 * agent on a team boots from, RBAC-gated (ADR-013 roles) with per-member
 * attribution via git provenance. This is the $49 Team-tier value (ADR-013
 * §Team-tier, GRAND_PRODUCT_ROADMAP §4.2): a solo brain is one operator's
 * memory; a team brain is the team's shared, continuously-merged truth.
 *
 * Slice 1 (this module): shared-namespace read/merge + the role gate + member
 * attribution. It lives in the SAME brain repo as the per-repo namespaces
 * (brain.ts) — a team is a first-class subtree parallel to `repos/`:
 *
 *   teams/<team>/sessions/<atom>.md   append-only session atoms (per member)
 *   teams/<team>/handoffs/<atom>.md   append-only handoff atoms (per member)
 *   teams/<team>/brief.md             compiled boot brief (distiller fills; ~150 tok)
 *   teams/<team>/working.md           compiled working context (distiller fills)
 *
 * Same append-only, content-hashed atom contract as brain.ts (merges are
 * conflict-free by construction), so a member's write on their session branch
 * merges cleanly into the shared `main` regardless of which teammate/device
 * produced it. Per-member attribution is recorded BOTH in atom frontmatter
 * (author/userId/role) AND as the git commit author, so `git log --author` and
 * `teamContributors` answer "who on the team wrote what" from plain git.
 *
 * RBAC (ADR-013): reads require the `read` capability, writes and merges require
 * `work` — reusing the canonical role→capability matrix in rbac.ts. This is a
 * HARD gate (not shadow mode): the team brain is a NEW surface with no pre-RBAC
 * callers to protect, and a shared-memory boundary is data integrity, not a
 * soak-able REST route. A `viewer` can boot from the team brain but never
 * mutate it.
 *
 * Dependency-light (node builtins + brain.ts helpers + rbac matrix), env-
 * injectable for hermetic tests — same discipline as brain.ts / hosted-brain.ts.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  brainHost,
  isBrainRepo,
  resolveBrainDir,
  sha8,
  slugify,
  type CodeProvenance,
} from './brain.js';
import { AuthError, type CtxRole } from './tenant-context.js';
import { type Capability, effectiveRole, roleHasCapability } from './rbac.js';

// ── member attribution ────────────────────────────────────────────────────────

/**
 * The team member a write is attributed to (ADR-013 principal). Recorded in the
 * atom frontmatter AND mapped onto the git commit author so provenance survives
 * in plain `git log` with no separate index.
 */
export interface TeamMember {
  /** User.userId — the durable principal id (survives email changes). */
  userId?: string;
  /** Display name for the git author line + attribution rollups. */
  name?: string;
  /** Email for the git author line. */
  email?: string;
  /** RBAC role at write time (ADR-013), stamped for the audit trail. */
  role?: CtxRole;
}

export interface TeamAtomInput {
  team: string;
  kind: 'session' | 'handoff';
  slug: string;
  content: string;
  /** Who on the team is writing (per-member attribution). */
  author: TeamMember;
  /** Optional code↔memory provenance (BRAIN B5), same as brain.ts atoms. */
  code?: CodeProvenance;
}

export interface TeamAtomResult {
  path: string;
  sha8: string;
  created: boolean;
}

export interface TeamContributor {
  /** Git author identity `Name <email>` (the attribution key). */
  author: string;
  /** userId parsed from the atom frontmatter, when present. */
  userId?: string;
  atoms: number;
}

/**
 * One entry in the team activity feed — a shared-truth event on `main`: a
 * member's atom write or a session/idea merge. Derived purely from git history
 * (no separate index), newest-first. Read-only, team-scoped.
 */
export interface TeamActivityEvent {
  /** Short (8-char) commit sha of the event. */
  sha: string;
  /** ISO-8601 author date — when the member did the work. */
  at: string;
  /** Git author `Name <email>`. For a merge, the member whose branch was merged. */
  author: string;
  /** Event kind: an atom write (`session`/`handoff`) or a shared-truth `merge`. */
  type: 'session' | 'handoff' | 'merge';
  /** Atom slug for a write, or the merged branch name for a merge. */
  ref: string;
}

/** Per-member contribution rollup (atoms/sessions/handoffs/merges) — ADR-013 attribution. */
export interface MemberContribution {
  /** Git author identity `Name <email>` (the attribution key). */
  author: string;
  /** ADR-013 durable principal id, parsed from atom frontmatter when present. */
  userId?: string;
  sessions: number;
  handoffs: number;
  /** sessions + handoffs. */
  atoms: number;
  /** Session/idea branches this member merged into the shared `main`. */
  merges: number;
  /** ISO-8601 of the member's earliest contribution. */
  firstAt?: string;
  /** ISO-8601 of the member's most-recent contribution. */
  lastAt?: string;
}

export interface TeamContributionRollup {
  team: string;
  /** Members ranked by atoms desc, then merges desc. */
  members: MemberContribution[];
  totals: { sessions: number; handoffs: number; atoms: number; merges: number; members: number };
}

export interface TeamBrainRead {
  team: string;
  /** Compiled boot brief (distiller output; placeholder until first merge). */
  brief: string;
  /** Recent shared session atoms on main, newest first (raw content). */
  recentSessions: Array<{ path: string; content: string }>;
  /** Recent shared handoff atoms on main, newest first (raw content). */
  recentHandoffs: Array<{ path: string; content: string }>;
  atoms: { sessions: number; handoffs: number };
  contributors: TeamContributor[];
}

// ── git plumbing (local, mirrors brain.ts' private helpers) ──────────────────

function git(dir: string, ...args: string[]): string {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (res.error) throw new Error(`team-brain: git unavailable: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`team-brain: git ${args[0]} failed: ${(res.stderr || res.stdout || '').trim()}`);
  }
  return res.stdout.trim();
}

function gitOk(dir: string, ...args: string[]): boolean {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).status === 0;
}

/** utcStamp — MUST match brain.ts' atom filename contract (…-<sha8>.md ordering). */
function utcStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

const SESSION_BRANCH = /^session\//;
const IDEA_BRANCH = /^idea\//;

/** Unit separator for git `--format` field splitting (never appears in our subjects). */
const US = String.fromCharCode(0x1f);

function requireBrain(env: NodeJS.ProcessEnv): string {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) throw new Error(`team-brain: no brain repo at ${dir} — run 'myai brain init'`);
  return dir;
}

function safeTeam(team: string): string {
  const t = slugify(team);
  if (!t) throw new Error('team-brain: team name required');
  return t;
}

// ── RBAC gate (reuses the ADR-013 matrix; HARD, not shadow) ──────────────────

/**
 * Assert the caller's role holds `cap` for a team-brain action, else throw
 * 403 FORBIDDEN. Reuses rbac.ts' role→capability matrix (ADR-013 §3). Unlike the
 * gateway's shadow-mode `assertCapability`, this is unconditionally enforced —
 * the team brain has no pre-RBAC callers and a shared-memory write is a data
 * boundary. Absent role → `member` (rbac DEFAULT_ROLE), so existing local/system
 * callers keep working.
 */
export function assertTeamCapability(
  role: CtxRole | undefined,
  cap: Capability,
  action: string,
): void {
  const effective = effectiveRole({ role });
  if (!roleHasCapability(effective, cap)) {
    throw new AuthError(
      `role '${effective}' lacks capability '${cap}' for ${action}`,
      403,
      'FORBIDDEN',
    );
  }
}

// ── namespace ─────────────────────────────────────────────────────────────────

/**
 * Ensure `teams/<team>/` exists (sessions/, handoffs/, placeholder compiled
 * artifacts). Commits only on first creation. Returns the namespace abs path.
 * Not role-gated on its own — writeTeamAtom/teamBrainMerge gate the caller.
 */
export function ensureTeamNamespace(team: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = requireBrain(env);
  const t = safeTeam(team);
  const nsDir = join(dir, 'teams', t);
  if (!existsSync(nsDir)) {
    mkdirSync(join(nsDir, 'sessions'), { recursive: true });
    mkdirSync(join(nsDir, 'handoffs'), { recursive: true });
    writeFileSync(join(nsDir, 'sessions', '.gitkeep'), '');
    writeFileSync(join(nsDir, 'handoffs', '.gitkeep'), '');
    writeFileSync(
      join(nsDir, 'brief.md'),
      `# team ${t} — boot brief\n\n_Not compiled yet. The distiller (\`brain merge\`) fills this (~150 tokens)._\n`,
    );
    writeFileSync(
      join(nsDir, 'working.md'),
      `# team ${t} — working context\n\n_Not compiled yet. The distiller (\`brain merge\`) fills this._\n`,
    );
    git(dir, 'add', `teams/${t}`);
    git(dir, 'commit', '-q', '-m', `brain(team): add team namespace ${t}`);
  }
  return nsDir;
}

// ── write (role: work) ────────────────────────────────────────────────────────

/**
 * Append one immutable atom to the shared team namespace on the CURRENT branch,
 * attributed to `author` (frontmatter + git commit author). Role-gated: `work`.
 * Dedup: an identical <slug>-<sha8> in the target dir is a no-op (created:false).
 */
export function writeTeamAtom(
  input: TeamAtomInput,
  role: CtxRole | undefined,
  env: NodeJS.ProcessEnv = process.env,
): TeamAtomResult {
  assertTeamCapability(role, 'work', `team brain write (${input.kind})`);
  const dir = requireBrain(env);
  const t = safeTeam(input.team);
  const slug = slugify(input.slug);
  if (!slug) throw new Error('team-brain: atom slug required');
  if (!input.content || !input.content.trim()) throw new Error('team-brain: empty atom content');
  if (input.kind !== 'session' && input.kind !== 'handoff') {
    throw new Error(`team-brain: kind must be session|handoff (got '${input.kind}')`);
  }
  ensureTeamNamespace(t, env);

  const subdir = input.kind === 'session' ? 'sessions' : 'handoffs';
  const relDir = `teams/${t}/${subdir}`;
  const hash = sha8(input.content);
  const suffix = `-${slug}-${hash}.md`;
  const existing = readdirSync(join(dir, relDir)).find((f) => f.endsWith(suffix));
  if (existing) return { path: `${relDir}/${existing}`, sha8: hash, created: false };

  const ts = utcStamp();
  const host = brainHost(env);
  const rel = `${relDir}/${ts}-${host}-${slug}-${hash}.md`;
  const abs = join(dir, rel);

  const authorName = input.author.name?.trim() || input.author.userId || 'unknown';
  const authorEmail = input.author.email?.trim() || `${slugify(authorName) || 'member'}@team.local`;
  const fm = [
    '---',
    `kind: ${input.kind}`,
    `team: ${t}`,
    `slug: ${slug}`,
    `host: ${host}`,
    `written: ${ts}`,
    `author: ${authorName}`,
    ...(input.author.userId ? [`user-id: ${input.author.userId}`] : []),
    ...(input.author.role ? [`author-role: ${input.author.role}`] : []),
  ];
  const prov = input.code;
  if (prov?.repo) fm.push(`code-repo: ${slugify(prov.repo)}`);
  if (prov?.branch) fm.push(`code-branch: ${prov.branch.trim()}`);
  if (prov?.sha) fm.push(`code-sha: ${prov.sha.trim().toLowerCase()}`);
  if (prov?.commits?.length) fm.push(`code-commits: ${prov.commits.map((c) => c.trim().toLowerCase()).join(' ')}`);
  fm.push('---', '');
  writeFileSync(abs, `${fm.join('\n')}\n${input.content}\n`);
  git(dir, 'add', rel);
  // Per-member git provenance: the commit AUTHOR is the team member; the brain's
  // committer identity stays constant. `git log --author` now attributes cleanly.
  git(
    dir,
    '-c', `user.name=${authorName}`,
    '-c', `user.email=${authorEmail}`,
    'commit', '-q',
    '--author', `${authorName} <${authorEmail}>`,
    '-m', `brain(team ${t}/${input.kind}): ${slug}`,
  );
  return { path: rel, sha8: hash, created: true };
}

// ── merge (role: work) ────────────────────────────────────────────────────────

/**
 * Merge a member's session/idea branch into the shared `main` — the team's
 * consolidated truth every teammate boots from. Role-gated: `work`. Same
 * --no-ff + abort-on-conflict semantics as brain.ts sessionMerge; session
 * branches are deleted after merge, idea branches survive. Returns the merged
 * branch name.
 */
export function teamBrainMerge(
  branch: string | undefined,
  role: CtxRole | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  assertTeamCapability(role, 'work', 'team brain merge');
  const dir = requireBrain(env);
  const target = branch || git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (target === 'main') throw new Error('team-brain: already on main — nothing to merge');
  if (!SESSION_BRANCH.test(target) && !IDEA_BRANCH.test(target)) {
    throw new Error(`team-brain: refusing to merge non-session branch '${target}'`);
  }
  if (!gitOk(dir, 'show-ref', '--verify', '--quiet', `refs/heads/${target}`)) {
    throw new Error(`team-brain: no such branch '${target}'`);
  }
  if (git(dir, 'status', '--porcelain') !== '') {
    throw new Error('team-brain: working tree is dirty — refusing to merge');
  }
  git(dir, 'checkout', '-q', 'main');
  if (!gitOk(dir, 'merge', '-q', '--no-ff', '-m', `brain(team-merge): ${target}`, target)) {
    spawnSync('git', ['-C', dir, 'merge', '--abort'], { encoding: 'utf8' });
    git(dir, 'checkout', '-q', target);
    throw new Error(`team-brain: CONFLICT merging ${target} into main — left unmerged (atoms are append-only)`);
  }
  if (SESSION_BRANCH.test(target)) git(dir, 'branch', '-q', '-D', target);
  return target;
}

// ── read (role: read) ─────────────────────────────────────────────────────────

/** Read atom files from a team subdir on `main`, newest first, capped at `limit`. */
function readTeamAtoms(
  dir: string,
  team: string,
  subdir: 'sessions' | 'handoffs',
  limit: number,
): Array<{ path: string; content: string }> {
  const rel = `teams/${team}/${subdir}`;
  if (!gitOk(dir, 'rev-parse', '--verify', '--quiet', `main:${rel}`)) return [];
  const names = git(dir, 'ls-tree', '--name-only', 'main', `${rel}/`)
    .split('\n')
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, limit);
  return names.map((path) => ({ path, content: git(dir, 'show', `main:${path}`) }));
}

/** Count `.md` atoms under a team subdir on `main`. */
function countTeamAtoms(dir: string, team: string, subdir: 'sessions' | 'handoffs'): number {
  const rel = `teams/${team}/${subdir}`;
  if (!gitOk(dir, 'rev-parse', '--verify', '--quiet', `main:${rel}`)) return 0;
  return git(dir, 'ls-tree', '--name-only', 'main', `${rel}/`)
    .split('\n')
    .filter((f) => f.endsWith('.md')).length;
}

/**
 * Per-member attribution rollup from git provenance: who on the team authored
 * how many atoms under `teams/<team>/`. Pure `git log --author` — no index.
 */
export function teamContributors(team: string, env: NodeJS.ProcessEnv = process.env): TeamContributor[] {
  const dir = requireBrain(env);
  const t = safeTeam(team);
  const rel = `teams/${t}`;
  if (!gitOk(dir, 'rev-parse', '--verify', '--quiet', `main:${rel}`)) return [];
  // Attribute each real .md atom (never the .gitkeep/brief.md scaffolding) to the
  // author of the commit that added it — pure git provenance, no index.
  const atomPaths: string[] = [];
  for (const subdir of ['sessions', 'handoffs'] as const) {
    if (!gitOk(dir, 'rev-parse', '--verify', '--quiet', `main:${rel}/${subdir}`)) continue;
    for (const name of git(dir, 'ls-tree', '--name-only', 'main', `${rel}/${subdir}/`).split('\n')) {
      if (name.endsWith('.md')) atomPaths.push(name);
    }
  }
  const byAuthor = new Map<string, number>();
  for (const path of atomPaths) {
    const author = git(dir, 'log', 'main', '-1', '--diff-filter=A', '--format=%an <%ae>', '--', path);
    if (author) byAuthor.set(author, (byAuthor.get(author) || 0) + 1);
  }
  return [...byAuthor.entries()]
    .map(([author, atoms]) => ({ author, atoms }))
    .sort((a, b) => b.atoms - a.atoms);
}

/**
 * The shared team boot context every agent on the team reads. Role-gated:
 * `read` (a `viewer` can boot). Returns the compiled brief plus the most-recent
 * shared session/handoff atoms (so it is useful before the distiller runs) and
 * the per-member contributor rollup.
 */
export function teamBrainRead(
  team: string,
  role: CtxRole | undefined,
  opts: { limit?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): TeamBrainRead {
  assertTeamCapability(role, 'read', 'team brain read');
  const dir = requireBrain(env);
  const t = safeTeam(team);
  const limit = Math.min(Math.max(Math.trunc(opts.limit || 5), 1), 50);

  let brief = `# team ${t} — boot brief\n\n_Team namespace not created yet._\n`;
  if (gitOk(dir, 'rev-parse', '--verify', '--quiet', `main:teams/${t}/brief.md`)) {
    brief = git(dir, 'show', `main:teams/${t}/brief.md`);
  }
  return {
    team: t,
    brief,
    recentSessions: readTeamAtoms(dir, t, 'sessions', limit),
    recentHandoffs: readTeamAtoms(dir, t, 'handoffs', limit),
    atoms: {
      sessions: countTeamAtoms(dir, t, 'sessions'),
      handoffs: countTeamAtoms(dir, t, 'handoffs'),
    },
    contributors: teamContributors(t, env),
  };
}

// ── activity feed + contribution rollup (role: read) ────────────────────────

interface RawTeamMerge {
  sha: string;
  at: string;
  branch: string;
  /** The member whose session/idea branch was merged (2nd-parent author). */
  author: string;
}

/**
 * Team-scoped `--no-ff` merges on `main`. The brain's committer identity is
 * constant (`myai-brain`), so a merge is attributed to the member who authored
 * the merged work — the 2nd parent (session-branch tip). Each candidate merge is
 * scoped to the team by checking it introduced files under `teams/<t>/` versus
 * its first parent (a clean `--no-ff` merge has an empty combined diff, so we
 * diff against `^1` rather than `diff-tree`ing the merge alone).
 */
function teamMergeCommits(dir: string, t: string): RawTeamMerge[] {
  const rel = `teams/${t}`;
  if (!gitOk(dir, 'rev-parse', '--verify', '--quiet', `main:${rel}`)) return [];
  const raw = git(dir, 'log', 'main', '--merges', `--format=%H${US}%aI${US}%P${US}%s`);
  if (!raw) return [];
  const out: RawTeamMerge[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [sha, at, parents, subject] = line.split(US);
    const parts = parents.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue; // not a real merge
    const changed = git(dir, 'diff-tree', '--no-commit-id', '--name-only', '-r', `${sha}^1`, sha);
    if (!changed.split('\n').some((f) => f.startsWith(`${rel}/`))) continue; // other team / repos merge
    const m = subject.match(/brain\(team-merge\):\s*(.+)$/);
    const branch = m ? m[1].trim() : subject.trim();
    const author = git(dir, 'log', '-1', '--format=%an <%ae>', parts[1]) || 'unknown';
    out.push({ sha: sha.slice(0, 8), at, branch, author });
  }
  return out;
}

/**
 * The team activity feed — shared-truth events on `main`, newest first: each
 * member's session/handoff atom write plus every session/idea merge. Role-gated:
 * `read` (a viewer can watch the feed). Team-scoped and read-only — pure git
 * history, no index. `limit` caps the returned events (1–200, default 20).
 */
export function teamActivityFeed(
  team: string,
  role: CtxRole | undefined,
  opts: { limit?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): TeamActivityEvent[] {
  assertTeamCapability(role, 'read', 'team activity feed');
  const dir = requireBrain(env);
  const t = safeTeam(team);
  const rel = `teams/${t}`;
  if (!gitOk(dir, 'rev-parse', '--verify', '--quiet', `main:${rel}`)) return [];
  const limit = Math.min(Math.max(Math.trunc(opts.limit || 20), 1), 200);

  const events: TeamActivityEvent[] = [];
  // Atom writes: single-parent commits (preserved on main by --no-ff) that added
  // a session/handoff atom. The .gitkeep/brief scaffolding is skipped by the regex.
  const raw = git(
    dir, 'log', 'main', '--no-merges',
    `--format=%H${US}%aI${US}%an <%ae>${US}%s`,
    '--', `${rel}/sessions/`, `${rel}/handoffs/`,
  );
  for (const line of raw ? raw.split('\n') : []) {
    if (!line) continue;
    const [sha, at, author, subject] = line.split(US);
    const m = subject.match(/^brain\(team [^/]+\/(session|handoff)\):\s*(.+)$/);
    if (!m) continue;
    events.push({ sha: sha.slice(0, 8), at, author, type: m[1] as 'session' | 'handoff', ref: m[2].trim() });
  }
  // Merges: member work consolidated into the shared main.
  for (const mc of teamMergeCommits(dir, t)) {
    events.push({ sha: mc.sha, at: mc.at, author: mc.author, type: 'merge', ref: mc.branch });
  }
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events.slice(0, limit);
}

/**
 * Per-member contribution rollup (atoms / sessions / handoffs / merges) for the
 * team dashboard. Role-gated: `read`. Team-scoped, read-only, pure git
 * provenance — each atom is attributed to the author of the commit that ADDED it
 * (git-log `--diff-filter=A`), each merge to the merged branch's author.
 * `userId` is best-effort from the atom frontmatter (ADR-013 durable principal).
 * Members are ranked by atoms desc, then merges desc.
 */
export function teamContributionRollup(
  team: string,
  role: CtxRole | undefined,
  env: NodeJS.ProcessEnv = process.env,
): TeamContributionRollup {
  assertTeamCapability(role, 'read', 'team contribution rollup');
  const dir = requireBrain(env);
  const t = safeTeam(team);
  const rel = `teams/${t}`;

  const members = new Map<string, MemberContribution>();
  const forAuthor = (author: string): MemberContribution => {
    let m = members.get(author);
    if (!m) {
      m = { author, sessions: 0, handoffs: 0, atoms: 0, merges: 0 };
      members.set(author, m);
    }
    return m;
  };
  const stampSpan = (m: MemberContribution, at: string): void => {
    if (at && (!m.firstAt || at < m.firstAt)) m.firstAt = at;
    if (at && (!m.lastAt || at > m.lastAt)) m.lastAt = at;
  };

  if (gitOk(dir, 'rev-parse', '--verify', '--quiet', `main:${rel}`)) {
    for (const subdir of ['sessions', 'handoffs'] as const) {
      if (!gitOk(dir, 'rev-parse', '--verify', '--quiet', `main:${rel}/${subdir}`)) continue;
      for (const name of git(dir, 'ls-tree', '--name-only', 'main', `${rel}/${subdir}/`).split('\n')) {
        if (!name.endsWith('.md')) continue;
        const line = git(dir, 'log', 'main', '-1', '--diff-filter=A', `--format=%an <%ae>${US}%aI`, '--', name);
        const [author, at] = line.split(US);
        if (!author) continue;
        const m = forAuthor(author);
        if (subdir === 'sessions') m.sessions++;
        else m.handoffs++;
        m.atoms++;
        stampSpan(m, at);
        if (!m.userId) {
          const uid = git(dir, 'show', `main:${name}`).match(/^user-id:\s*(.+)$/m);
          if (uid) m.userId = uid[1].trim();
        }
      }
    }
    for (const mc of teamMergeCommits(dir, t)) {
      const m = forAuthor(mc.author);
      m.merges++;
      stampSpan(m, mc.at);
    }
  }

  const list = [...members.values()].sort((a, b) => b.atoms - a.atoms || b.merges - a.merges);
  const totals = list.reduce(
    (acc, m) => {
      acc.sessions += m.sessions;
      acc.handoffs += m.handoffs;
      acc.atoms += m.atoms;
      acc.merges += m.merges;
      return acc;
    },
    { sessions: 0, handoffs: 0, atoms: 0, merges: 0, members: 0 },
  );
  totals.members = list.length;
  return { team: t, members: list, totals };
}

// ── status ────────────────────────────────────────────────────────────────────

/** List team namespaces present in the brain (directory names under teams/). */
export function listTeams(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) return [];
  const teamsDir = join(dir, 'teams');
  if (!existsSync(teamsDir)) return [];
  return readdirSync(teamsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}
