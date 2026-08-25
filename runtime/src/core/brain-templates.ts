/**
 * brain-templates.ts — Starter-brain packs: seed a NEW tenant's brain from a
 * curated domain baseline instead of an empty store.
 *
 * Two halves, one module:
 *   1. PACK REGISTRY (operator-published, versioned, immutable) — operators
 *      publish curated packs of brain atoms (domain conventions, common
 *      patterns). One JSON document per published version, never re-published
 *      (same immutability rule as marketplace versions, ADR-028 §4).
 *   2. SEEDING — a tenant bootstraps its brain from a pack: atoms are written
 *      through the ordinary append-only writeAtom path (brain.ts), so seeded
 *      content is indistinguishable from organically written atoms to every
 *      downstream consumer (distiller, brain_delta, search). A marker memory
 *      atom records which pack@version seeded the store.
 *
 * DISTINCT from brain backup/restore (that round-trips a tenant's OWN data)
 * and from semantic search (retrieval over what's already there) — this is
 * seeding + templating for tenants that would otherwise start cold.
 *
 * Layout (global, operator-owned — NOT tenant-scoped; tenants only read it
 * through the seed path):
 *   <myai home>/brain-templates/<packId>/<version>.json
 *
 * Seeding targets whatever brain `resolveBrainDir(env)` names — the MCP
 * handlers pass `brainEnvFor(tenantId)` (ADR-010) so a tenant can only ever
 * seed its own confined store.
 *
 * Dependency-free (node builtins only), env-injectable for hermetic tests —
 * same discipline as brain.ts / hosted-brain.ts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  brainInit,
  isBrainRepo,
  myaiHome,
  normalizeTopic,
  resolveBrainDir,
  slugify,
  writeAtom,
  type AtomKind,
} from './brain.js';

/** Thrown for every refused registry/seed operation (mirrors HostedBrainError). */
export class StarterPackError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = 'BAD_PACK') {
    super(message);
    this.name = 'StarterPackError';
    this.status = status;
    this.code = code;
  }
}

/** One curated atom inside a pack — the writeAtom input shape, minus provenance. */
export interface StarterPackAtom {
  kind: AtomKind;
  /** Project namespace; omit for cross-repo memory atoms. */
  repo?: string;
  slug: string;
  /** ADR-020 topic tag — normalized at publish time (warn-only, never blocks). */
  topic?: string;
  content: string;
}

export interface StarterPackInput {
  /** Pack identity — a slug, stable across versions (e.g. 'nextjs-saas'). */
  id: string;
  /** Strict semver X.Y.Z. Published versions are immutable. */
  version: string;
  title: string;
  description?: string;
  atoms: StarterPackAtom[];
}

/** A published, immutable pack version (what <version>.json holds). */
export interface StarterPack extends StarterPackInput {
  publishedAt: string;
  publishedBy?: string;
}

export interface PublishResult {
  id: string;
  version: string;
  atomCount: number;
  /** Non-blocking ADR-020 topic nudges collected across the pack's atoms. */
  warnings: string[];
}

export interface StarterPackSummary {
  id: string;
  title: string;
  description?: string;
  latestVersion: string;
  versions: string[];
  publishedAt: string;
  atomCount: number;
}

export interface SeedOptions {
  /** Pack id to seed from. */
  pack: string;
  /** Specific version; defaults to the latest published. */
  version?: string;
  /**
   * Seeding is for a NEW tenant's brain: it is refused once the brain has any
   * real session history. force=true overrides (atoms still dedup, nothing is
   * ever overwritten — append-only by construction).
   */
  force?: boolean;
}

export interface SeedResult {
  packId: string;
  version: string;
  title: string;
  /** true when the brain repo itself was created by this seed. */
  initialized: boolean;
  /** true when this exact pack@version had already seeded this brain (no-op). */
  alreadySeeded: boolean;
  atomsWritten: number;
  /** Atoms whose identical content already existed (writeAtom dedup). */
  atomsDeduped: number;
  /** Repo namespaces the pack touched (created on demand). */
  namespaces: string[];
}

export interface SeededPack {
  packId: string;
  version: string;
  /** UTC stamp of the marker atom (filename prefix, sortable). */
  seededAt: string;
}

// ── limits (operator-curated content, but still bounded) ─────────────────────
export const MAX_PACK_ATOMS = 200;
export const MAX_PACK_BYTES = 1024 * 1024; // 1 MB of curated content is plenty

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const ATOM_KINDS: ReadonlySet<string> = new Set(['session', 'handoff', 'memory']);
/** Marker-atom slug prefix — how seededStarterPacks finds what seeded a brain. */
const MARKER_PREFIX = 'seeded-';

// ── location resolution ───────────────────────────────────────────────────────

/** Root of the operator-published pack registry (global — never tenant-scoped). */
export function templatesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(myaiHome(env), 'brain-templates');
}

function safePackId(id: string): string {
  const p = slugify(id ?? '');
  if (!p) throw new StarterPackError(`invalid pack id '${id}'`, 400, 'BAD_PACK_ID');
  return p;
}

function packDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(templatesRoot(env), safePackId(id));
}

function versionPath(id: string, version: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(packDir(id, env), `${version}.json`);
}

// ── semver-ish ordering (strict X.Y.Z only — enforced at publish) ────────────

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// ── publish ───────────────────────────────────────────────────────────────────

function validateAtoms(atoms: StarterPackAtom[]): string[] {
  if (!Array.isArray(atoms) || atoms.length === 0) {
    throw new StarterPackError('a pack needs at least one atom', 400, 'EMPTY_PACK');
  }
  if (atoms.length > MAX_PACK_ATOMS) {
    throw new StarterPackError(`pack exceeds ${MAX_PACK_ATOMS} atoms (${atoms.length})`, 400, 'PACK_TOO_LARGE');
  }
  const warnings: string[] = [];
  let bytes = 0;
  atoms.forEach((atom, i) => {
    const at = `atoms[${i}]`;
    if (!ATOM_KINDS.has(atom?.kind)) {
      throw new StarterPackError(`${at}: kind must be session|handoff|memory (got '${atom?.kind}')`, 400, 'BAD_ATOM');
    }
    if (!atom.slug || !slugify(atom.slug)) {
      throw new StarterPackError(`${at}: slug required`, 400, 'BAD_ATOM');
    }
    if (typeof atom.content !== 'string' || !atom.content.trim()) {
      throw new StarterPackError(`${at}: empty content`, 400, 'BAD_ATOM');
    }
    if (atom.kind !== 'memory' && !(atom.repo && slugify(atom.repo))) {
      throw new StarterPackError(`${at}: kind '${atom.kind}' requires a repo namespace`, 400, 'BAD_ATOM');
    }
    // Reserved: marker atoms are how seeding records itself — a pack must not
    // be able to forge "already seeded" state on the tenant store.
    if (slugify(atom.slug).startsWith(MARKER_PREFIX)) {
      throw new StarterPackError(`${at}: slug prefix '${MARKER_PREFIX}' is reserved for seed markers`, 400, 'BAD_ATOM');
    }
    bytes += Buffer.byteLength(atom.content, 'utf8');
    const { warning } = normalizeTopic(atom.topic);
    if (warning) warnings.push(`${at} (${slugify(atom.slug)}): ${warning}`);
  });
  if (bytes > MAX_PACK_BYTES) {
    throw new StarterPackError(`pack content exceeds ${MAX_PACK_BYTES} bytes (${bytes})`, 400, 'PACK_TOO_LARGE');
  }
  return warnings;
}

/**
 * Publish one immutable pack version. Refuses a re-publish of an existing
 * version (fix forward — bump the version). Topics are normalized warn-only,
 * same ADR-020 posture as writeAtom.
 */
export function publishStarterPack(
  input: StarterPackInput,
  publishedBy?: string,
  env: NodeJS.ProcessEnv = process.env,
): PublishResult {
  const id = safePackId(input.id);
  if (!VERSION_RE.test(input.version ?? '')) {
    throw new StarterPackError(`version must be strict X.Y.Z semver (got '${input.version}')`, 400, 'BAD_VERSION');
  }
  if (!input.title || !input.title.trim()) {
    throw new StarterPackError('title required', 400, 'BAD_PACK');
  }
  const warnings = validateAtoms(input.atoms);

  const file = versionPath(id, input.version, env);
  if (existsSync(file)) {
    throw new StarterPackError(`pack '${id}' v${input.version} already published — versions are immutable`, 409, 'VERSION_EXISTS');
  }

  const pack: StarterPack = {
    id,
    version: input.version,
    title: input.title.trim(),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    atoms: input.atoms.map((a) => ({
      kind: a.kind,
      ...(a.repo ? { repo: slugify(a.repo) } : {}),
      slug: slugify(a.slug),
      topic: normalizeTopic(a.topic).topic,
      content: a.content,
    })),
    publishedAt: new Date().toISOString(),
    ...(publishedBy ? { publishedBy } : {}),
  };
  mkdirSync(packDir(id, env), { recursive: true });
  writeFileSync(file, `${JSON.stringify(pack, null, 2)}\n`);
  return { id, version: input.version, atomCount: pack.atoms.length, warnings };
}

// ── read / list ───────────────────────────────────────────────────────────────

function packVersions(id: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = packDir(id, env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && VERSION_RE.test(f.slice(0, -5)))
    .map((f) => f.slice(0, -5))
    .sort(compareVersions);
}

/** Load one published pack (latest version when `version` is omitted). */
export function getStarterPack(
  id: string,
  version?: string,
  env: NodeJS.ProcessEnv = process.env,
): StarterPack {
  const p = safePackId(id);
  const versions = packVersions(p, env);
  if (versions.length === 0) {
    throw new StarterPackError(`no starter pack '${p}'`, 404, 'PACK_NOT_FOUND');
  }
  const want = version ?? versions[versions.length - 1];
  if (!versions.includes(want)) {
    throw new StarterPackError(`no version ${want} of pack '${p}' (have: ${versions.join(', ')})`, 404, 'VERSION_NOT_FOUND');
  }
  try {
    return JSON.parse(readFileSync(versionPath(p, want, env), 'utf8')) as StarterPack;
  } catch {
    throw new StarterPackError(`pack '${p}' v${want} is unreadable`, 500, 'PACK_CORRUPT');
  }
}

/** Catalog of every published pack, latest-version summary each. */
export function listStarterPacks(env: NodeJS.ProcessEnv = process.env): StarterPackSummary[] {
  const root = templatesRoot(env);
  if (!existsSync(root)) return [];
  const out: StarterPackSummary[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const versions = packVersions(entry.name, env);
    if (versions.length === 0) continue;
    try {
      const latest = getStarterPack(entry.name, versions[versions.length - 1], env);
      out.push({
        id: latest.id,
        title: latest.title,
        ...(latest.description ? { description: latest.description } : {}),
        latestVersion: latest.version,
        versions,
        publishedAt: latest.publishedAt,
        atomCount: latest.atoms.length,
      });
    } catch {
      // an unreadable latest version hides the pack from the catalog rather
      // than failing the whole listing — surfaced via getStarterPack's 500
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ── seeded-state inspection ───────────────────────────────────────────────────

const MARKER_LINE_RE = /^pack: ([a-z0-9-]+)@(\d+\.\d+\.\d+)$/m;

/**
 * Which packs already seeded the brain `env` resolves to — parsed from the
 * marker memory atoms seedBrainFromPack writes. Empty for a missing brain.
 */
export function seededStarterPacks(env: NodeJS.ProcessEnv = process.env): SeededPack[] {
  const dir = resolveBrainDir(env);
  const memDir = join(dir, 'memory');
  if (!isBrainRepo(dir) || !existsSync(memDir)) return [];
  const out: SeededPack[] = [];
  for (const f of readdirSync(memDir)) {
    if (!f.endsWith('.md') || !f.includes(`-${MARKER_PREFIX}`)) continue;
    const m = readFileSync(join(memDir, f), 'utf8').match(MARKER_LINE_RE);
    if (!m) continue;
    out.push({ packId: m[1], version: m[2], seededAt: f.split('-')[0] });
  }
  return out.sort((a, b) => a.seededAt.localeCompare(b.seededAt));
}

/** Any real session history? (the "this is no longer a NEW brain" signal) */
function hasSessionHistory(dir: string): boolean {
  const reposDir = join(dir, 'repos');
  if (!existsSync(reposDir)) return false;
  for (const ns of readdirSync(reposDir, { withFileTypes: true })) {
    if (!ns.isDirectory()) continue;
    const sessions = join(reposDir, ns.name, 'sessions');
    if (existsSync(sessions) && readdirSync(sessions).some((f) => f.endsWith('.md'))) return true;
  }
  return false;
}

// ── seed ──────────────────────────────────────────────────────────────────────

/**
 * Seed the brain `env` resolves to from a published pack. Creates the brain
 * repo if missing (pointer:false — a tenant store must never redirect the
 * operator's machine-wide brain.path pointer, ADR-010). Atoms go through
 * writeAtom — append-only, content-hash dedup, one commit each — then a marker
 * memory atom records pack@version so re-seeding the same version is an
 * idempotent no-op and operators can audit provenance later.
 *
 * Refused once the brain has real session history (seeding is a NEW-tenant
 * bootstrap, not a merge tool) unless force=true. Layering multiple DIFFERENT
 * packs onto a still-fresh brain is allowed by construction.
 */
export function seedBrainFromPack(opts: SeedOptions, env: NodeJS.ProcessEnv = process.env): SeedResult {
  const pack = getStarterPack(opts.pack, opts.version, env);

  const dir = resolveBrainDir(env);
  let initialized = false;
  if (!isBrainRepo(dir)) {
    brainInit({ dir, pointer: false }, env);
    initialized = true;
  }

  if (seededStarterPacks(env).some((s) => s.packId === pack.id && s.version === pack.version)) {
    return {
      packId: pack.id,
      version: pack.version,
      title: pack.title,
      initialized,
      alreadySeeded: true,
      atomsWritten: 0,
      atomsDeduped: 0,
      namespaces: [],
    };
  }

  if (!opts.force && hasSessionHistory(dir)) {
    throw new StarterPackError(
      `brain already has session history — seeding is a new-tenant bootstrap (pass force:true to seed anyway; atoms dedup, nothing is overwritten)`,
      409,
      'NOT_A_FRESH_BRAIN',
    );
  }

  let written = 0;
  let deduped = 0;
  const namespaces = new Set<string>();
  for (const atom of pack.atoms) {
    const res = writeAtom(
      { kind: atom.kind, repo: atom.repo ?? null, slug: atom.slug, topic: atom.topic, content: atom.content },
      env,
    );
    if (res.created) written += 1;
    else deduped += 1;
    if (atom.repo) namespaces.add(slugify(atom.repo));
  }

  writeAtom(
    {
      kind: 'memory',
      slug: `${MARKER_PREFIX}${pack.id}`,
      topic: 'brain',
      content: [
        `pack: ${pack.id}@${pack.version}`,
        `title: ${pack.title}`,
        '',
        `Seeded from starter brain pack '${pack.id}' v${pack.version} — ${pack.atoms.length} curated atoms (${written} written, ${deduped} already present).`,
      ].join('\n'),
    },
    env,
  );

  return {
    packId: pack.id,
    version: pack.version,
    title: pack.title,
    initialized,
    alreadySeeded: false,
    atomsWritten: written,
    atomsDeduped: deduped,
    namespaces: [...namespaces].sort(),
  };
}
