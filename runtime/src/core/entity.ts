/**
 * entity.ts — lightweight entity/temporal layer over the brain (BRAIN B10).
 *
 * The deep-research verdict (plan/CONTEXT_ARCHITECTURE_RESEARCH.md) validated
 * our verbatim-atoms + git + brief + RAG core and recommended exactly ONE
 * addition: a lightweight temporal/entity layer (à la Zep/Graphiti) for
 * cross-session "what changed about X / when did I last touch Y" recall.
 *
 * This is that layer — and ONLY that. It is an AUGMENTING INDEX, not a new
 * substrate: the append-only verbatim atoms stay the source of truth, git
 * stays the warehouse, the compiled brief/working stay the boot path. Nothing
 * here is persisted; the index is computed on read by a single deterministic
 * scan of the atoms already on disk (the same read path brainExplore uses).
 *
 * DETERMINISTIC + CHEAP BY CONTRACT — no per-write LLM, no embeddings, no new
 * files. Entities are extracted with plain regex/heuristics so the same atoms
 * always yield the same index; "touched" edges are timestamped from each
 * atom's frontmatter `written` stamp. That is the whole Graphiti borrow:
 * entities + time-stamped edges, kept extractive.
 *
 * Two MCP tools sit on top (mcp/tools.ts):
 *   brain_entity   — entity-centric: "what changed about X" (touches + snippets)
 *   brain_timeline — time-ordered feed: "when did I last touch Y" / recent activity
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBrainRepo, resolveBrainDir, slugify } from './brain.js';

export type EntityKind = 'repo' | 'file' | 'feature' | 'person' | 'decision';

/** One extracted entity reference (before it is grouped into a record). */
export interface EntityMention {
  kind: EntityKind;
  /** Display name (original case for files/decisions/people; slug for repo/feature). */
  name: string;
}

/** A single timestamped "touched" edge: an atom that mentions an entity. */
export interface EntityTouch {
  atomPath: string;
  /** Namespace the atom lives under ('' for cross-repo memory atoms). */
  repo: string;
  atomKind: 'session' | 'handoff' | 'memory';
  /** Raw UTC stamp from the atom (YYYYMMDDTHHMMSSZ) — sortable. */
  written: string;
  /** ISO-8601 rendering of `written` ('' when unparseable). */
  date: string;
  sha8: string;
  slug: string;
  /** The line/sentence in the atom that mentions the entity (tightened). */
  snippet: string;
}

/** An entity plus every atom that touched it — the temporal record. */
export interface EntityRecord {
  name: string;
  kind: EntityKind;
  /** Total touches (may exceed touches.length when capped). */
  count: number;
  /** ISO of the oldest touch. */
  firstTouched: string;
  /** ISO of the newest touch — answers "when did I last touch Y". */
  lastTouched: string;
  /** Namespaces the entity appears in. */
  repos: string[];
  /** Touches, newest first, capped. */
  touches: EntityTouch[];
}

export interface EntityIndex {
  dir: string;
  initialized: boolean;
  /** How many atoms the scan read. */
  atomsScanned: number;
  /** True when the atom cap was hit (older atoms not scanned). */
  truncated: boolean;
  /** Entity records, newest-touched first. */
  entities: EntityRecord[];
  totals: Record<EntityKind, number>;
}

// ── budgets ────────────────────────────────────────────────────────────────

/** Newest N atoms scanned per index build (bounds cost on a large brain). */
const DEFAULT_ATOM_SCAN = 800;
/** Per-entity touch cap in a record. */
const DEFAULT_TOUCH_LIMIT = 25;
/** Snippet length (chars). */
const SNIPPET_CHARS = 180;

// ── extraction (deterministic, no LLM) ───────────────────────────────────────

/** File-path-like tokens ending in a known source/config extension. */
const FILE_RE =
  /(?:[\w@][\w./-]*\/)?[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|mdx|sh|ya?ml|css|scss|s?html?|py|go|rs|sql|env|toml|txt|lock|ini|conf|dockerfile)\b/gi;
/** ADR / decision references. */
const DECISION_RE = /\bADR-\d{1,4}\b/gi;
/** @mentions — a person/handle. Guard against email domains and code paths. */
const PERSON_RE = /(?<![\w/.])@([a-z][\w.-]{1,30})\b/gi;
/** Uppercase "tag"-style feature/project names, optionally multi-token. */
const FEATURE_TAG_RE = /\b[A-Z][A-Z0-9]{2,}(?:[ -][A-Z0-9]{1,}){0,3}\b/g;

/** Single-word uppercase tokens that are prose/labels, not features. */
const FEATURE_STOP = new Set([
  'DONE', 'NEXT', 'TODO', 'WIP', 'FIXME', 'NOTE', 'BLOCKER', 'BLOCKERS', 'DELTA',
  'AND', 'THE', 'FOR', 'WITH', 'FROM', 'THIS', 'THAT', 'NULL', 'TRUE', 'FALSE',
  'HTTP', 'HTTPS', 'JSON', 'YAML', 'HTML', 'CSS', 'SHA', 'URL', 'URLS', 'ISO',
  'UTC', 'CLI', 'MCP', 'RAM', 'CPU', 'ENV', 'PR', 'PRS', 'CI', 'ETA', 'FYI',
]);

/** Trim a matched file token: drop a leading `./`, collapse `../` noise. */
function normalizeFile(raw: string): string {
  return raw.replace(/^\.\//, '').trim();
}

/**
 * Extract entities from a single atom, deterministically. `slug` and `repo`
 * come from the atom's frontmatter; both are strong first-class signals (a
 * session atom's slug IS the feature it is about; its namespace IS the repo).
 */
export function extractEntities(body: string, slug: string, repo: string): EntityMention[] {
  const out: EntityMention[] = [];
  const seen = new Set<string>();
  const add = (kind: EntityKind, name: string) => {
    const clean = name.trim();
    if (!clean) return;
    const key = `${kind}::${clean.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, name: clean });
  };

  if (repo) add('repo', repo);
  if (slug) add('feature', slug);

  for (const m of body.match(FILE_RE) ?? []) add('file', normalizeFile(m));
  for (const m of body.match(DECISION_RE) ?? []) add('decision', m.toUpperCase());
  for (const m of body.matchAll(PERSON_RE)) add('person', `@${m[1]}`);

  for (const m of body.match(FEATURE_TAG_RE) ?? []) {
    const tag = m.replace(/\s+/g, ' ').trim();
    // A bare single-word acronym is only a feature if it is not prose noise.
    if (!/[ -]/.test(tag) && FEATURE_STOP.has(tag)) continue;
    if (DECISION_RE.test(tag)) { DECISION_RE.lastIndex = 0; continue; } // ADR-* is a decision
    DECISION_RE.lastIndex = 0;
    add('feature', tag);
  }

  return out;
}

// ── atom scan ────────────────────────────────────────────────────────────────

export interface ScannedAtom {
  path: string;
  repo: string;
  atomKind: 'session' | 'handoff' | 'memory';
  written: string;
  sha8: string;
  slug: string;
  body: string;
}

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

/** `20260706T234100Z` → `2026-07-06T23:41:00Z` (best effort; '' if not that shape). */
export function stampToIso(stamp: string): string {
  const m = stamp.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return '';
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

function collapse(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** The line/sentence of `body` that mentions `name`, tightened; else the head. */
function snippetFor(body: string, name: string): string {
  const needle = name.toLowerCase();
  for (const line of body.split('\n')) {
    if (line.toLowerCase().includes(needle) && line.trim()) return collapse(line, SNIPPET_CHARS);
  }
  return collapse(body, SNIPPET_CHARS);
}

/** List atom files under a dir as repo-relative paths. */
function listAtoms(dir: string, relDir: string): string[] {
  const abs = join(dir, relDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter((f) => f.endsWith('.md')).map((f) => `${relDir}/${f}`);
}

/**
 * One read-only pass over the brain worktree collecting atom bodies + stamps,
 * newest first, capped. Mirrors brainExplore's read path (no server, no git
 * checkout) so it works on the offline/degraded path too.
 */
export function scanAtoms(dir: string, opts: { repo?: string; atomLimit: number }): { atoms: ScannedAtom[]; truncated: boolean } {
  const nsFilter = opts.repo ? slugify(opts.repo) : undefined;
  const reposDir = join(dir, 'repos');
  const nsNames = existsSync(reposDir)
    ? readdirSync(reposDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];

  const rels: Array<{ rel: string; kind: 'session' | 'handoff' | 'memory'; repo: string }> = [];
  for (const ns of nsNames) {
    if (nsFilter && ns !== nsFilter) continue;
    for (const rel of listAtoms(dir, `repos/${ns}/sessions`)) rels.push({ rel, kind: 'session', repo: ns });
    for (const rel of listAtoms(dir, `repos/${ns}/handoffs`)) rels.push({ rel, kind: 'handoff', repo: ns });
  }
  // Cross-repo memory atoms are always in scope (they are not namespaced).
  for (const rel of listAtoms(dir, 'memory')) rels.push({ rel, kind: 'memory', repo: '' });

  // Newest first by the sortable UTC stamp embedded in the filename prefix.
  rels.sort((a, b) => b.rel.slice(b.rel.lastIndexOf('/') + 1).localeCompare(a.rel.slice(a.rel.lastIndexOf('/') + 1)));
  const truncated = rels.length > opts.atomLimit;
  const kept = rels.slice(0, opts.atomLimit);

  const atoms: ScannedAtom[] = [];
  for (const { rel, kind, repo } of kept) {
    let raw = '';
    try {
      raw = readFileSync(join(dir, rel), 'utf8');
    } catch {
      continue; // unreadable atom (raced write) — skip, never fail the scan
    }
    const { meta, body } = parseFrontmatter(raw);
    const file = rel.slice(rel.lastIndexOf('/') + 1);
    const shaMatch = file.match(/-([0-9a-f]{8})\.md$/);
    atoms.push({
      path: rel,
      repo: meta.repo && meta.repo !== '—' ? meta.repo : repo,
      atomKind: kind,
      written: meta.written || file.slice(0, 16),
      sha8: shaMatch ? shaMatch[1] : '',
      slug: meta.slug || file.replace(/\.md$/, ''),
      body,
    });
  }
  return { atoms, truncated };
}

// ── index build ──────────────────────────────────────────────────────────────

const EMPTY_TOTALS = (): Record<EntityKind, number> => ({ repo: 0, file: 0, feature: 0, person: 0, decision: 0 });

/**
 * Build the entity/temporal index from a single deterministic scan of the
 * atoms. Cheap + repeatable: same atoms → same index, no LLM, no persistence.
 */
export function buildEntityIndex(
  opts: { repo?: string; atomLimit?: number; touchLimit?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): EntityIndex {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) {
    return { dir, initialized: false, atomsScanned: 0, truncated: false, entities: [], totals: EMPTY_TOTALS() };
  }
  const atomLimit = Math.min(Math.max(Math.trunc(opts.atomLimit || DEFAULT_ATOM_SCAN), 1), 5000);
  const touchLimit = Math.min(Math.max(Math.trunc(opts.touchLimit || DEFAULT_TOUCH_LIMIT), 1), 200);
  const { atoms, truncated } = scanAtoms(dir, { repo: opts.repo, atomLimit });

  interface Acc {
    name: string;
    kind: EntityKind;
    count: number;
    repos: Set<string>;
    touches: EntityTouch[];
  }
  const map = new Map<string, Acc>();

  for (const atom of atoms) {
    const iso = stampToIso(atom.written);
    for (const { kind, name } of extractEntities(atom.body, atom.slug, atom.repo)) {
      const key = `${kind}::${name.toLowerCase()}`;
      let acc = map.get(key);
      if (!acc) {
        acc = { name, kind, count: 0, repos: new Set(), touches: [] };
        map.set(key, acc);
      }
      acc.count += 1;
      if (atom.repo) acc.repos.add(atom.repo);
      acc.touches.push({
        atomPath: atom.path,
        repo: atom.repo,
        atomKind: atom.atomKind,
        written: atom.written,
        date: iso,
        sha8: atom.sha8,
        slug: atom.slug,
        snippet: snippetFor(atom.body, name),
      });
    }
  }

  const totals = EMPTY_TOTALS();
  const entities: EntityRecord[] = [];
  for (const acc of map.values()) {
    // Touches accumulate newest-first (atoms were scanned newest-first).
    const sorted = acc.touches.slice().sort((a, b) => b.written.localeCompare(a.written));
    totals[acc.kind] += 1;
    entities.push({
      name: acc.name,
      kind: acc.kind,
      count: acc.count,
      firstTouched: stampToIso(sorted[sorted.length - 1]?.written ?? ''),
      lastTouched: stampToIso(sorted[0]?.written ?? ''),
      repos: [...acc.repos].sort(),
      touches: sorted.slice(0, touchLimit),
    });
  }
  // Newest-touched first — the most recently active entities lead.
  entities.sort((a, b) => (b.lastTouched || '').localeCompare(a.lastTouched || ''));

  return { dir, initialized: true, atomsScanned: atoms.length, truncated, entities, totals };
}

// ── query surface (the two MCP tools sit on these) ───────────────────────────

/** Case-insensitive substring match against an entity name. */
function matches(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.toLowerCase());
}

export interface BrainEntityResult {
  initialized: boolean;
  query?: string;
  kind?: EntityKind;
  repo?: string;
  atomsScanned: number;
  truncated: boolean;
  matched: number;
  entities: EntityRecord[];
}

/**
 * "What changed about X" — entity-centric recall. With `query`, returns the
 * entity records whose name matches (substring, case-insensitive), each with
 * its timestamped touches + snippets so you can read what changed each time.
 * Without `query`, returns the most-recently-touched entities (optionally
 * filtered by `kind`/`repo`) — a map of what the brain knows about.
 */
export function brainEntity(
  opts: { query?: string; kind?: EntityKind; repo?: string; limit?: number; atomLimit?: number; touchLimit?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): BrainEntityResult {
  const index = buildEntityIndex({ repo: opts.repo, atomLimit: opts.atomLimit, touchLimit: opts.touchLimit }, env);
  const limit = Math.min(Math.max(Math.trunc(opts.limit || 20), 1), 200);
  const q = opts.query?.trim();

  let hits = index.entities;
  if (opts.kind) hits = hits.filter((e) => e.kind === opts.kind);
  if (q) hits = hits.filter((e) => matches(e.name, q));

  return {
    initialized: index.initialized,
    query: q || undefined,
    kind: opts.kind,
    repo: opts.repo,
    atomsScanned: index.atomsScanned,
    truncated: index.truncated,
    matched: hits.length,
    entities: hits.slice(0, limit),
  };
}

export interface TimelineEvent {
  written: string;
  date: string;
  entity: string;
  kind: EntityKind;
  repo: string;
  atomKind: 'session' | 'handoff' | 'memory';
  atomPath: string;
  sha8: string;
  slug: string;
  snippet: string;
}

export interface BrainTimelineResult {
  initialized: boolean;
  entity?: string;
  kind?: EntityKind;
  repo?: string;
  atomsScanned: number;
  truncated: boolean;
  /** ISO of the most recent matching touch — answers "when did I last touch Y". */
  lastTouched?: string;
  firstTouched?: string;
  count: number;
  events: TimelineEvent[];
}

/**
 * "When did I last touch Y" / recent activity — the time-ordered feed. With
 * `entity`, returns that entity's touches newest-first plus its first/last
 * touched stamps. Without `entity`, returns the recent cross-entity activity
 * (optionally scoped by `kind`/`repo`) — a temporal overview of what has been
 * worked on lately.
 */
export function brainTimeline(
  opts: { entity?: string; kind?: EntityKind; repo?: string; since?: string; limit?: number; atomLimit?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): BrainTimelineResult {
  const index = buildEntityIndex({ repo: opts.repo, atomLimit: opts.atomLimit, touchLimit: 200 }, env);
  const limit = Math.min(Math.max(Math.trunc(opts.limit || 40), 1), 500);
  const entity = opts.entity?.trim();
  const since = opts.since?.trim();

  // Flatten (entity, touch) pairs into one event stream, dedup-free (a touch
  // legitimately appears once per entity it mentions — that IS the edge set).
  const events: TimelineEvent[] = [];
  for (const rec of index.entities) {
    if (opts.kind && rec.kind !== opts.kind) continue;
    if (entity && !matches(rec.name, entity)) continue;
    for (const t of rec.touches) {
      if (since && t.written <= since) continue;
      events.push({
        written: t.written,
        date: t.date,
        entity: rec.name,
        kind: rec.kind,
        repo: t.repo,
        atomKind: t.atomKind,
        atomPath: t.atomPath,
        sha8: t.sha8,
        slug: t.slug,
        snippet: t.snippet,
      });
    }
  }
  events.sort((a, b) => b.written.localeCompare(a.written));

  return {
    initialized: index.initialized,
    entity: entity || undefined,
    kind: opts.kind,
    repo: opts.repo,
    atomsScanned: index.atomsScanned,
    truncated: index.truncated,
    lastTouched: events[0]?.date || undefined,
    firstTouched: events[events.length - 1]?.date || undefined,
    count: events.length,
    events: events.slice(0, limit),
  };
}
