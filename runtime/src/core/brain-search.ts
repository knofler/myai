/**
 * brain-search.ts — federated cross-repo-brain recall (BRAIN federation).
 *
 * A tenant's brain holds atoms (sessions/handoffs/memory facts) namespaced
 * per repo, and the RAG memory holds session-corpus vectors (STATE.md /
 * handoff / archive) also namespaced per `repo` — both already scoped to
 * ONE tenant, never across tenants (that's the separate per-namespace
 * sharing/read-only-grant path). Until now each side only searched within
 * one query surface at a time. This module runs both in one call and merges
 * them into a single ranked list, so "what have we done about X" doesn't
 * require knowing which repo-brain holds the answer.
 */
import { isBrainRepo, resolveBrainDir } from './brain.js';
import { scanAtoms, type ScannedAtom } from './entity.js';
import { recallSession } from '../memory/vector-store.js';

const DEFAULT_ATOM_SCAN = 500;
const SNIPPET_CHARS = 220;

export interface BrainSearchHit {
  kind: 'atom' | 'session';
  repo: string;
  score: number;
  snippet: string;
  written: string;
  /** Atom hits only: session | handoff | memory. */
  atomKind?: 'session' | 'handoff' | 'memory';
  /** Atom hits only: repo-relative path in the brain store. */
  path?: string;
  /** Session hits only: the vector's source (state | handoff | archive). */
  source?: string;
  sessionId?: string;
}

export interface AtomSearchResult {
  hits: BrainSearchHit[];
  atomsScanned: number;
  atomsTruncated: boolean;
}

export interface FederatedBrainSearchResult {
  query: string;
  count: number;
  atomsScanned: number;
  atomsTruncated: boolean;
  hits: BrainSearchHit[];
}

function collapse(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** The line mentioning a query term, tightened; else the head of the body. */
function snippetFor(body: string, terms: string[]): string {
  for (const line of body.split('\n')) {
    const lower = line.toLowerCase();
    if (line.trim() && terms.some((t) => lower.includes(t))) return collapse(line, SNIPPET_CHARS);
  }
  return collapse(body, SNIPPET_CHARS);
}

function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean);
}

/** Case-insensitive term-frequency count over an atom's slug + body. */
function scoreAtom(atom: ScannedAtom, terms: string[]): number {
  const haystack = `${atom.slug} ${atom.body}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    let idx = haystack.indexOf(term);
    while (idx !== -1) {
      score += 1;
      idx = haystack.indexOf(term, idx + term.length);
    }
  }
  return score;
}

/**
 * Keyword-ranked search over the brain's atoms — sessions, handoffs, and
 * cross-repo memory facts — across EVERY repo namespace in one pass (unless
 * `opts.repo` narrows it). No embeddings: term-frequency over slug + body.
 * This is the git-brain half of federation; `recallSession` (vector-store.ts)
 * is the Mongo-vector half already searching all `repo` values when its own
 * `repo` filter is omitted.
 */
export function searchAtoms(
  query: string,
  opts: { repo?: string; limit?: number; atomLimit?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): AtomSearchResult {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) return { hits: [], atomsScanned: 0, atomsTruncated: false };

  const terms = tokenize(query);
  if (terms.length === 0) return { hits: [], atomsScanned: 0, atomsTruncated: false };

  const atomLimit = Math.min(Math.max(Math.trunc(opts.atomLimit || DEFAULT_ATOM_SCAN), 1), 5000);
  const { atoms, truncated } = scanAtoms(dir, { repo: opts.repo, atomLimit });

  const scored = atoms
    .map((atom) => ({ atom, score: scoreAtom(atom, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.atom.written.localeCompare(a.atom.written));

  const limit = Math.min(Math.max(Math.trunc(opts.limit || 10), 1), 100);
  const hits: BrainSearchHit[] = scored.slice(0, limit).map(({ atom, score }) => ({
    kind: 'atom',
    repo: atom.repo,
    score,
    snippet: snippetFor(atom.body, terms),
    written: atom.written,
    atomKind: atom.atomKind,
    path: atom.path,
  }));

  return { hits, atomsScanned: atoms.length, atomsTruncated: truncated };
}

/**
 * Min-max normalize scores to [0, 1] within a list so two rankers on
 * different scales (keyword term-count vs. cosine similarity) merge sanely —
 * neither side's raw magnitude dominates just because its scorer runs hotter.
 */
function normalize<T>(items: T[], score: (item: T) => number): number[] {
  if (items.length === 0) return [];
  const scores = items.map(score);
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const range = max - min;
  return scores.map((s) => (range > 0 ? (s - min) / range : 1));
}

/**
 * Federated recall: one ranked query across a tenant's brain atoms (git
 * store, every repo namespace) AND the RAG session corpus (Mongo vectors,
 * every `repo`) — the "search across all my repo-brains" surface (CLI +
 * dashboard). Narrow to one repo with `opts.repo`; omit it to federate.
 */
export async function federatedBrainSearch(
  tenantId: string,
  opts: { query: string; repo?: string; k?: number; since?: Date; atomLimit?: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<FederatedBrainSearchResult> {
  const k = Math.min(Math.max(Math.trunc(opts.k || 10), 1), 100);

  const atomResult = searchAtoms(opts.query, { repo: opts.repo, limit: k, atomLimit: opts.atomLimit }, env);
  const sessionResults = await recallSession(tenantId, {
    query: opts.query,
    k,
    since: opts.since,
    repo: opts.repo,
  });

  const atomScores = normalize(atomResult.hits, (h) => h.score);
  const sessionScores = normalize(sessionResults, (r) => r.score);

  const merged: BrainSearchHit[] = [
    ...atomResult.hits.map((h, i) => ({ ...h, score: atomScores[i] })),
    ...sessionResults.map((r, i) => ({
      kind: 'session' as const,
      repo: r.repo,
      score: sessionScores[i],
      snippet: collapse(r.block, SNIPPET_CHARS),
      written: r.date instanceof Date ? r.date.toISOString() : String(r.date),
      source: r.source,
      sessionId: r.sessionId,
    })),
  ];

  merged.sort((a, b) => b.score - a.score);

  return {
    query: opts.query,
    count: merged.length,
    atomsScanned: atomResult.atomsScanned,
    atomsTruncated: atomResult.atomsTruncated,
    hits: merged.slice(0, k),
  };
}
