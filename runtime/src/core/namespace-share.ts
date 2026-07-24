/**
 * namespace-share.ts — per-namespace brain sharing: an OWNER brain grants
 * another tenant scoped READ (or READ-WRITE) access to ONE `repos/<namespace>`
 * subtree, revocable, with an access list. Distinct from team-brain.ts (which
 * shares a WHOLE team namespace with every member of ONE team) — this is a
 * single owner→grantee grant on a single namespace, and the grantee is
 * typically a DIFFERENT tenant entirely (cross-tenant collaboration), not a
 * teammate inside the same tenant.
 *
 * Grants live INSIDE the owner's brain repo at `repos/<namespace>/grants.json`
 * — git-tracked (so `brain_log`/`brain_diff` show every grant/revoke as a
 * normal commit, and deleting/renaming the namespace takes its grants with it)
 * and colocated with the namespace it governs. One active grant per
 * (namespace, grantee) — re-granting an existing grantee updates the level and
 * clears any prior revocation; revoking sets `revokedAt` rather than deleting,
 * so the access list stays a full audit trail.
 *
 * Enforcement is layered at the gateway boundary (ADR-013 defense in depth):
 * the grantee's OWN tool-context role must hold the RBAC capability for the
 * verb (`read` to read, `work` to write — same matrix as team-brain.ts, hard
 * gate, not shadow mode) AND the per-namespace grant must be active and at
 * least the required level. Reads are served from the owner's `main` branch
 * only — the consolidated truth — so a grantee never sees another tenant's
 * uncommitted/in-progress session-branch work.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { brainHost, ensureNamespace, isBrainRepo, resolveBrainDir, sha8, slugify } from './brain.js';
import { AuthError, type CtxRole } from './tenant-context.js';
import { type Capability, effectiveRole, roleHasCapability } from './rbac.js';

export type NamespaceGrantLevel = 'read' | 'read-write';

export interface NamespaceGrant {
  granteeTenantId: string;
  level: NamespaceGrantLevel;
  grantedBy?: string;
  grantedAt: string;
  revokedAt?: string;
}

interface GrantsFile {
  grants: NamespaceGrant[];
}

export interface SharedNamespaceRead {
  namespace: string;
  brief: string;
  recentSessions: Array<{ path: string; content: string }>;
  recentHandoffs: Array<{ path: string; content: string }>;
  atoms: { sessions: number; handoffs: number };
}

export interface SharedAtomInput {
  kind: 'session' | 'handoff';
  slug: string;
  content: string;
}

export interface SharedAtomResult {
  path: string;
  sha8: string;
  created: boolean;
}

// ── git plumbing (local, mirrors brain.ts'/team-brain.ts' private helpers) ───

function git(dir: string, ...args: string[]): string {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (res.error) throw new Error(`namespace-share: git unavailable: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`namespace-share: git ${args[0]} failed: ${(res.stderr || res.stdout || '').trim()}`);
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

function requireBrain(env: NodeJS.ProcessEnv): string {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) throw new Error(`namespace-share: no brain repo at ${dir} — run 'myai brain init'`);
  return dir;
}

function safeNamespace(name: string): string {
  const ns = slugify(name);
  if (!ns) throw new Error('namespace-share: namespace name required');
  return ns;
}

// ── RBAC gate (reuses the ADR-013 matrix; HARD, not shadow — same posture as
// team-brain.ts: this is a new surface with no pre-RBAC callers to protect,
// and a cross-tenant access grant is a security boundary, not a soak-able
// REST route) ─────────────────────────────────────────────────────────────

export function assertNamespaceShareCapability(
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

// ── grants.json plumbing ──────────────────────────────────────────────────

function grantsRelPath(ns: string): string {
  return `repos/${ns}/grants.json`;
}

function readGrantsFile(dir: string, ns: string): GrantsFile {
  const abs = join(dir, grantsRelPath(ns));
  if (!existsSync(abs)) return { grants: [] };
  try {
    const parsed = JSON.parse(readFileSync(abs, 'utf8'));
    return { grants: Array.isArray(parsed?.grants) ? parsed.grants : [] };
  } catch {
    return { grants: [] };
  }
}

function writeGrantsFile(dir: string, ns: string, file: GrantsFile, message: string): void {
  const rel = grantsRelPath(ns);
  writeFileSync(join(dir, rel), `${JSON.stringify(file, null, 2)}\n`);
  git(dir, 'add', rel);
  git(dir, 'commit', '-q', '-m', message);
}

// ── grant / revoke / list (owner side, role: configure/read) ────────────────

/**
 * Grant `granteeTenantId` scoped access to `namespace` in the owner's brain.
 * Role-gated: `configure` (an access-control change, same rung as connector/
 * schedule config in rbac.ts's v2 resource matrix). Re-granting an existing
 * (possibly revoked) grantee updates the level and clears any revocation —
 * one active grant per (namespace, grantee).
 */
export function grantNamespaceAccess(
  namespace: string,
  granteeTenantId: string,
  level: NamespaceGrantLevel,
  role: CtxRole | undefined,
  opts: { grantedBy?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): NamespaceGrant {
  assertNamespaceShareCapability(role, 'configure', 'namespace grant');
  if (level !== 'read' && level !== 'read-write') {
    throw new Error(`namespace-share: level must be read|read-write (got '${level}')`);
  }
  const grantee = (granteeTenantId || '').trim();
  if (!grantee) throw new Error('namespace-share: granteeTenantId required');

  const dir = requireBrain(env);
  const ns = safeNamespace(namespace);
  ensureNamespace(ns, env);

  const file = readGrantsFile(dir, ns);
  const now = utcStamp();
  let grant = file.grants.find((g) => g.granteeTenantId === grantee);
  if (grant) {
    grant.level = level;
    grant.grantedBy = opts.grantedBy;
    grant.grantedAt = now;
    delete grant.revokedAt;
  } else {
    grant = { granteeTenantId: grantee, level, grantedBy: opts.grantedBy, grantedAt: now };
    file.grants.push(grant);
  }
  writeGrantsFile(dir, ns, file, `brain(share): grant ${grantee} ${level} on ${ns}`);
  return grant;
}

/**
 * Revoke a grantee's access to `namespace`. Role-gated: `configure`. Throws if
 * the grantee never held a grant on this namespace; a no-op (no empty commit)
 * if already revoked.
 */
export function revokeNamespaceAccess(
  namespace: string,
  granteeTenantId: string,
  role: CtxRole | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  assertNamespaceShareCapability(role, 'configure', 'namespace revoke');
  const dir = requireBrain(env);
  const ns = safeNamespace(namespace);
  const file = readGrantsFile(dir, ns);
  const grant = file.grants.find((g) => g.granteeTenantId === granteeTenantId);
  if (!grant) throw new Error(`namespace-share: no grant for '${granteeTenantId}' on '${ns}'`);
  if (grant.revokedAt) return;
  grant.revokedAt = utcStamp();
  writeGrantsFile(dir, ns, file, `brain(share): revoke ${granteeTenantId} on ${ns}`);
}

/**
 * The owner's access list for `namespace` — every grant ever issued, newest
 * first. Role-gated: `read`. Pass `activeOnly` to filter out revoked grants.
 */
export function listNamespaceGrants(
  namespace: string,
  role: CtxRole | undefined,
  opts: { activeOnly?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): NamespaceGrant[] {
  assertNamespaceShareCapability(role, 'read', 'namespace grants list');
  const dir = requireBrain(env);
  const ns = safeNamespace(namespace);
  const file = readGrantsFile(dir, ns);
  const list = [...file.grants].sort((a, b) => (a.grantedAt < b.grantedAt ? 1 : -1));
  return opts.activeOnly ? list.filter((g) => !g.revokedAt) : list;
}

const LEVEL_RANK: Record<NamespaceGrantLevel, number> = { read: 1, 'read-write': 2 };

/**
 * Enforcement chokepoint: does `granteeTenantId` currently hold an ACTIVE grant
 * on `namespace` at least `requiredLevel`? Throws 403 FORBIDDEN when missing,
 * revoked, or under-leveled. Purely the cross-tenant ACL check — callers also
 * gate the grantee's own RBAC capability (see readSharedNamespace/
 * writeSharedNamespaceAtom below) for defense in depth.
 */
export function assertNamespaceGrant(
  namespace: string,
  granteeTenantId: string,
  requiredLevel: NamespaceGrantLevel,
  env: NodeJS.ProcessEnv = process.env,
): NamespaceGrant {
  const dir = requireBrain(env);
  const ns = safeNamespace(namespace);
  const file = readGrantsFile(dir, ns);
  const grant = file.grants.find((g) => g.granteeTenantId === granteeTenantId);
  if (!grant || grant.revokedAt) {
    throw new AuthError(`no active grant for '${granteeTenantId}' on namespace '${ns}'`, 403, 'FORBIDDEN');
  }
  if (LEVEL_RANK[grant.level] < LEVEL_RANK[requiredLevel]) {
    throw new AuthError(
      `grant for '${granteeTenantId}' on '${ns}' is '${grant.level}', '${requiredLevel}' required`,
      403,
      'FORBIDDEN',
    );
  }
  return grant;
}

// ── read (grantee side, role: read + an active grant) ───────────────────────

function readNamespaceAtomsOnMain(
  dir: string,
  ns: string,
  subdir: 'sessions' | 'handoffs',
  limit: number,
): Array<{ path: string; content: string }> {
  const rel = `repos/${ns}/${subdir}`;
  if (!gitOk(dir, 'rev-parse', '--verify', '--quiet', `main:${rel}`)) return [];
  const names = git(dir, 'ls-tree', '--name-only', 'main', `${rel}/`)
    .split('\n')
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, limit);
  return names.map((path) => ({ path, content: git(dir, 'show', `main:${path}`) }));
}

function countNamespaceAtomsOnMain(dir: string, ns: string, subdir: 'sessions' | 'handoffs'): number {
  const rel = `repos/${ns}/${subdir}`;
  if (!gitOk(dir, 'rev-parse', '--verify', '--quiet', `main:${rel}`)) return 0;
  return git(dir, 'ls-tree', '--name-only', 'main', `${rel}/`).split('\n').filter((f) => f.endsWith('.md')).length;
}

/**
 * Read a namespace shared TO `granteeTenantId` by the owner brain at `env`.
 * Enforces BOTH the grantee's own RBAC `read` capability and the per-namespace
 * grant (a `read-write` grant also satisfies a `read` requirement). Reads from
 * `main` only — the owner's consolidated truth, never an in-progress session
 * branch — so a grantee never sees another tenant's unmerged WIP.
 */
export function readSharedNamespace(
  namespace: string,
  granteeTenantId: string,
  granteeRole: CtxRole | undefined,
  opts: { limit?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): SharedNamespaceRead {
  assertNamespaceShareCapability(granteeRole, 'read', 'shared namespace read');
  assertNamespaceGrant(namespace, granteeTenantId, 'read', env);
  const dir = requireBrain(env);
  const ns = safeNamespace(namespace);
  const limit = Math.min(Math.max(Math.trunc(opts.limit || 5), 1), 50);

  let brief = `# ${ns} — boot brief\n\n_Namespace not created yet._\n`;
  if (gitOk(dir, 'rev-parse', '--verify', '--quiet', `main:repos/${ns}/brief.md`)) {
    brief = git(dir, 'show', `main:repos/${ns}/brief.md`);
  }
  return {
    namespace: ns,
    brief,
    recentSessions: readNamespaceAtomsOnMain(dir, ns, 'sessions', limit),
    recentHandoffs: readNamespaceAtomsOnMain(dir, ns, 'handoffs', limit),
    atoms: {
      sessions: countNamespaceAtomsOnMain(dir, ns, 'sessions'),
      handoffs: countNamespaceAtomsOnMain(dir, ns, 'handoffs'),
    },
  };
}

// ── write (grantee side, role: work + an active read-write grant) ──────────

/**
 * Write an atom into a namespace shared TO `granteeTenantId` at `read-write`
 * level. Enforces the grantee's own RBAC `work` capability AND the
 * per-namespace grant (`read-write` required — a `read` grant cannot write).
 * Attributed to the grantee tenant in both the atom frontmatter and the git
 * commit author (mirrors team-brain.ts's per-member attribution), so
 * `git log --author` on the owner's brain shows exactly which tenant wrote
 * what. Dedup: an identical <slug>-<sha8> already in the target dir is a no-op.
 */
export function writeSharedNamespaceAtom(
  namespace: string,
  granteeTenantId: string,
  granteeRole: CtxRole | undefined,
  input: SharedAtomInput,
  env: NodeJS.ProcessEnv = process.env,
): SharedAtomResult {
  assertNamespaceShareCapability(granteeRole, 'work', 'shared namespace write');
  assertNamespaceGrant(namespace, granteeTenantId, 'read-write', env);
  const dir = requireBrain(env);
  const ns = safeNamespace(namespace);
  const slug = slugify(input.slug);
  if (!slug) throw new Error('namespace-share: atom slug required');
  if (!input.content || !input.content.trim()) throw new Error('namespace-share: empty atom content');
  if (input.kind !== 'session' && input.kind !== 'handoff') {
    throw new Error(`namespace-share: kind must be session|handoff (got '${input.kind}')`);
  }
  ensureNamespace(ns, env);

  const subdir = input.kind === 'session' ? 'sessions' : 'handoffs';
  const relDir = `repos/${ns}/${subdir}`;
  const hash = sha8(input.content);
  const suffix = `-${slug}-${hash}.md`;
  const existing = readdirSync(join(dir, relDir)).find((f) => f.endsWith(suffix));
  if (existing) return { path: `${relDir}/${existing}`, sha8: hash, created: false };

  const ts = utcStamp();
  const host = brainHost(env);
  const rel = `${relDir}/${ts}-${host}-${slug}-${hash}.md`;
  const fm = [
    '---',
    `kind: ${input.kind}`,
    `repo: ${ns}`,
    `slug: ${slug}`,
    `host: ${host}`,
    `written: ${ts}`,
    `shared-write-by: ${granteeTenantId}`,
    '---', '',
  ];
  writeFileSync(join(dir, rel), `${fm.join('\n')}\n${input.content}\n`);
  git(dir, 'add', rel);
  const authorName = granteeTenantId;
  const authorEmail = `${slugify(granteeTenantId) || 'grantee'}@shared.local`;
  git(
    dir,
    '-c', `user.name=${authorName}`,
    '-c', `user.email=${authorEmail}`,
    'commit', '-q',
    '--author', `${authorName} <${authorEmail}>`,
    '-m', `brain(shared ${ns}/${input.kind}): ${slug}`,
  );
  return { path: rel, sha8: hash, created: true };
}
