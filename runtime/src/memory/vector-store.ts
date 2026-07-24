import { createHash } from 'node:crypto';
import { VectorModel, isConnected } from '../shared/db.js';
import { getEmbeddingProvider } from './embeddings.js';
import { createChildLogger } from '../shared/logger.js';
import { getBrainObfuscation } from '../shared/config.js';
import { obfuscateText, deobfuscateText, OBFUSCATION_MAP_METADATA_KEY } from './obfuscate.js';
import { obfMapKey, saveObfMap, loadObfMap } from './obf-map-store.js';
import type { IVector } from '../shared/db.js';
import { scopedFind, scopedFindOne, scopedCountDocuments, scopedDeleteMany, tenantScope } from '../shared/scoped-query.js';
import {
  AnnIndex,
  detectVectorBackend,
  buildAtlasVectorSearchPipeline,
} from './vector-index.js';

const log = createChildLogger({ module: 'vector-store' });

// ── Embedded-ANN cache (local backend) ──────────────────
// One AnnIndex per (tenant + filter) signature, rebuilt when stale. Building
// fetches the tenant-scoped candidate pool once; subsequent queries with the
// same filter (e.g. recall firing across sources, or many queries in a burst)
// reuse the index and run sublinear — no per-query O(n·d) cosine scan.
const VECTOR_LOCAL_TTL_MS = Number(process.env.VECTOR_LOCAL_TTL_MS) || 60_000;
const VECTOR_LOCAL_MAX_CANDIDATES = Number(process.env.VECTOR_LOCAL_MAX_CANDIDATES) || 5000;

// contentHash rides internally alongside the base fields (never returned to
// callers — see deobfuscateResult) so a B-9-obfuscated row's local reverse
// map can be looked up by the same key it was saved under at store time.
type VectorBase = Omit<VectorSearchResult, 'score'> & { contentHash: string };
interface CachedAnnIndex { index: AnnIndex<VectorBase>; builtAt: number; }
const localIndexCache = new Map<string, CachedAnnIndex>();

/** Test/maintenance hook — drop all cached local indexes. */
export function __resetVectorSearchCache(): void {
  localIndexCache.clear();
}

function toBase(doc: IVector): VectorBase {
  return {
    repo: doc.repo,
    source: doc.source,
    content: doc.content,
    tags: doc.tags,
    sessionId: doc.sessionId,
    metadata: doc.metadata,
    createdAt: doc.createdAt,
    contentHash: doc.contentHash,
  };
}

export interface StoreResult {
  stored: number;
  skipped: number;
  failed: number;
}

export interface VectorSearchResult {
  repo: string;
  source: string;
  content: string;
  tags: string[];
  score: number;
  sessionId: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * B-9: restore real names in a search result whose content was obfuscated at
 * store time. The reverse map is looked up LOCALLY (obf-map-store, keyed off
 * the row's own contentHash) so it never has to ride in remote row metadata —
 * that would ship the real identifiers right back to the same Atlas index B-9
 * exists to keep them out of. `metadata[OBFUSCATION_MAP_METADATA_KEY]` is only
 * read here as a legacy fallback for rows written before this local-store
 * follow-up landed; new writes never set it (see storeVector). Strips
 * `contentHash` and any legacy map key so callers never see either. A no-op
 * for rows stored without obfuscation — safe to apply on every result
 * regardless of whether the flag is currently on.
 */
function deobfuscateResult(tenantId: string, r: VectorBase & { score: number }): VectorSearchResult {
  const { contentHash, ...rest } = r;
  const legacyMap = rest.metadata?.[OBFUSCATION_MAP_METADATA_KEY] as Record<string, string> | undefined;
  const map = legacyMap ?? (contentHash ? loadObfMap(obfMapKey(tenantId, rest.repo, rest.source, contentHash)) : undefined);
  if (!map) return rest;
  const cleanMeta: Record<string, unknown> = { ...rest.metadata };
  delete cleanMeta[OBFUSCATION_MAP_METADATA_KEY];
  return { ...rest, content: deobfuscateText(rest.content, map), metadata: cleanMeta };
}

/**
 * Store a single text chunk as a vector. Deduplicates by content hash.
 */
export async function storeVector(tenantId: string, opts: {
  repo: string;
  source: IVector['source'];
  content: string;
  tags?: string[];
  sessionId?: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  if (!isConnected()) {
    log.warn('MongoDB not connected — cannot store vector');
    return false;
  }

  const hash = contentHash(opts.content);

  // Check for existing identical content in this tenant's repo+source.
  const existing = await scopedFindOne(VectorModel, tenantId, {
    repo: opts.repo,
    source: opts.source,
    contentHash: hash,
  });

  if (existing) {
    log.debug({ repo: opts.repo, source: opts.source }, 'Vector already exists — skipping');
    return false;
  }

  // B-9 (plan §4): when enabled, pseudonymise identifiers in the descriptor
  // BEFORE it is embedded and stored, so the REMOTE index only ever sees
  // obfuscated content + embeddings computed from obfuscated text. The reverse
  // map is saved to the LOCAL obf-map-store (keyed by this row's contentHash,
  // computed over the REAL content above) — never to remote row metadata, or
  // the same Atlas operator B-9 hides identifiers from would read them
  // straight back out of the map. `searchVectors` loads it back by the same
  // key. DEFAULT OFF → `content`/`embedding` are byte-identical to pre-B-9.
  const { obfuscateRemote, salt } = getBrainObfuscation();
  let embedInput = opts.content;
  let storedContent = opts.content;
  const metadata = opts.metadata || {};
  if (obfuscateRemote) {
    const { text, map } = obfuscateText(opts.content, salt);
    embedInput = text;
    storedContent = text;
    saveObfMap(obfMapKey(tenantId, opts.repo, opts.source, hash), map);
  }

  const provider = getEmbeddingProvider();
  const embedding = await provider.embed(embedInput);

  await VectorModel.create({
    ...tenantScope(tenantId),
    repo: opts.repo,
    source: opts.source,
    content: storedContent,
    embedding,
    tags: opts.tags || [],
    sessionId: opts.sessionId || '',
    metadata,
    contentHash: hash,
  });

  log.debug({ repo: opts.repo, source: opts.source, hash }, 'Vector stored');
  return true;
}

/**
 * Store multiple chunks as vectors in batch.
 */
export async function storeBatch(tenantId: string, chunks: Array<{
  repo: string;
  source: IVector['source'];
  content: string;
  tags?: string[];
  sessionId?: string;
  metadata?: Record<string, unknown>;
}>): Promise<StoreResult> {
  let stored = 0, skipped = 0, failed = 0;

  for (const chunk of chunks) {
    try {
      const wasStored = await storeVector(tenantId, chunk);
      if (wasStored) stored++;
      else skipped++;
    } catch (err) {
      log.error({ err, repo: chunk.repo, source: chunk.source }, 'Failed to store vector');
      failed++;
    }
  }

  log.info({ stored, skipped, failed, total: chunks.length }, 'Batch store complete');
  return { stored, skipped, failed };
}

/**
 * Search vectors by semantic similarity. Indexed (no brute-force cosine loop):
 *
 *  - **Atlas** → server-side `$vectorSearch` ANN over the whole collection.
 *  - **Local** → in-process embedded ANN index (random-projection LSH), cached
 *    per filter signature so repeated queries are sublinear.
 *
 * Tenant isolation stays in the PRE-filter on both paths (ADR-010 §1.5 #3): the
 * Atlas stage pins `tenantId` in `$vectorSearch.filter`, and the local index is
 * only ever built from `scoped-query` candidates — so retrieval can never rank
 * another tenant's vectors. Signature unchanged from the original implementation.
 */
export async function searchVectors(tenantId: string, opts: {
  query: string;
  repo?: string;
  source?: IVector['source'];
  tags?: string[];
  since?: Date;
  limit?: number;
}): Promise<VectorSearchResult[]> {
  if (!isConnected()) {
    log.warn('MongoDB not connected — cannot search vectors');
    return [];
  }

  const limit = opts.limit || 10;
  const provider = getEmbeddingProvider();
  // B-9: obfuscate the query with the same salt as the corpus so identifier
  // tokens line up in the same embedding space (recall preserved). DEFAULT OFF
  // → query is embedded verbatim, exactly as before.
  const { obfuscateRemote, salt } = getBrainObfuscation();
  const queryText = obfuscateRemote ? obfuscateText(opts.query, salt).text : opts.query;
  const queryEmbedding = await provider.embed(queryText);

  // ── Atlas: push ANN ranking into the database ──────────
  if (detectVectorBackend() === 'atlas') {
    try {
      const pipeline = buildAtlasVectorSearchPipeline(tenantId, queryEmbedding, limit, {
        repo: opts.repo,
        source: opts.source,
        tags: opts.tags,
        since: opts.since,
      });
      // $vectorSearch is an Atlas-only stage absent from mongoose's PipelineStage
      // union, so cast through unknown.
      const docs = await VectorModel.aggregate(pipeline as unknown as Parameters<typeof VectorModel.aggregate>[0]);
      return docs.map((d: Record<string, unknown>) => deobfuscateResult(tenantId, {
        repo: d.repo as string,
        source: d.source as IVector['source'],
        content: d.content as string,
        tags: (d.tags as string[]) || [],
        score: d.score as number,
        sessionId: (d.sessionId as string) || '',
        metadata: (d.metadata as Record<string, unknown>) || {},
        createdAt: d.createdAt as Date,
        contentHash: d.contentHash as string,
      }));
    } catch (err) {
      // Index missing / not yet provisioned → degrade to the local path rather
      // than fail the query. Logged once so the Atlas index gets created.
      log.warn({ err }, 'Atlas $vectorSearch failed — falling back to embedded ANN');
    }
  }

  // ── Local: embedded ANN over tenant-scoped candidates ──
  const index = await getLocalIndex(tenantId, opts);
  if (index.size === 0) return [];

  return index.query(queryEmbedding, limit).map(hit => deobfuscateResult(tenantId, { ...hit.item, score: hit.score }));
}

/**
 * Build (or reuse) the cached embedded ANN index for a filter signature. The
 * candidate pool is fetched tenant-scoped through `scoped-query` exactly once
 * per (re)build; cache entries expire after VECTOR_LOCAL_TTL_MS so recall stays
 * near-real-time without rescanning on every call.
 */
async function getLocalIndex(tenantId: string, opts: {
  repo?: string;
  source?: IVector['source'];
  tags?: string[];
  since?: Date;
}): Promise<AnnIndex<VectorBase>> {
  const tagsKey = (opts.tags || []).slice().sort().join(',');
  const sig = `${tenantId}|${opts.repo || '*'}|${opts.source || '*'}|${tagsKey}|${opts.since ? +opts.since : ''}`;

  const cached = localIndexCache.get(sig);
  if (cached && Date.now() - cached.builtAt <= VECTOR_LOCAL_TTL_MS) return cached.index;

  // Build filter — same scoping the brute-force path used (ADR-010 §1.5 #3).
  const filter: Record<string, unknown> = {};
  if (opts.repo) filter.repo = opts.repo;
  if (opts.source) filter.source = opts.source;
  if (opts.tags && opts.tags.length > 0) filter.tags = { $in: opts.tags };
  if (opts.since) filter.createdAt = { $gte: opts.since };

  const candidates = await scopedFind(VectorModel, tenantId, filter)
    .sort({ updatedAt: -1 })
    .limit(VECTOR_LOCAL_MAX_CANDIDATES)
    .lean<IVector[]>();

  const dims = candidates[0]?.embedding.length || 0;
  const index = AnnIndex.build<VectorBase>(
    dims,
    candidates.map(doc => ({ item: toBase(doc), vector: doc.embedding })),
  );
  localIndexCache.set(sig, { index, builtAt: Date.now() });
  return index;
}

export interface RecallResult {
  block: string;
  score: number;
  date: Date;
  source: string;
  repo: string;
  sessionId: string;
}

/**
 * Session sources that make up the recall corpus: current state blocks,
 * handoff notes, and archived (rotated) session history.
 */
export const SESSION_SOURCES: IVector['source'][] = ['state', 'handoff', 'archive'];

/**
 * Recall past work sessions by semantic similarity. Searches the session
 * corpus (STATE.md blocks, handoff notes, archived sessions) across all
 * session sources, merges, and returns the top-k blocks ranked by similarity.
 *
 * This is the retrieval primitive behind the `recall_session` MCP tool — it
 * answers "what did we do for PR #99?" without grepping the archive. Runs on
 * application-level cosine over the local store; no Atlas dependency.
 */
export async function recallSession(tenantId: string, opts: {
  query: string;
  k?: number;
  since?: Date;
  repo?: string;
}): Promise<RecallResult[]> {
  if (!isConnected()) {
    log.warn('MongoDB not connected — cannot recall sessions');
    return [];
  }

  const k = opts.k && opts.k > 0 ? opts.k : 5;
  // Pull a few extra candidates per source so cross-source merge ranks well.
  const perSource = Math.max(k, 5);

  const batches = await Promise.all(
    SESSION_SOURCES.map(source =>
      searchVectors(tenantId, {
        query: opts.query,
        repo: opts.repo,
        source,
        since: opts.since,
        limit: perSource,
      }),
    ),
  );

  const merged = batches.flat();
  merged.sort((a, b) => b.score - a.score);

  return merged.slice(0, k).map(r => ({
    block: r.content,
    score: Math.round(r.score * 1000) / 1000,
    date: r.createdAt,
    source: r.source,
    repo: r.repo,
    sessionId: r.sessionId,
  }));
}

/**
 * Delete all vectors for a repo+source combination (used before re-indexing).
 */
export async function deleteVectors(tenantId: string, repo: string, source?: IVector['source']): Promise<number> {
  if (!isConnected()) return 0;

  const filter: Record<string, unknown> = { repo };
  if (source) filter.source = source;

  const result = await scopedDeleteMany(VectorModel, tenantId, filter);
  log.info({ repo, source, deleted: result.deletedCount }, 'Vectors deleted');
  return result.deletedCount;
}

/**
 * Get vector count by repo and/or source, scoped to a tenant.
 */
export async function getVectorCount(tenantId: string, repo?: string, source?: IVector['source']): Promise<number> {
  if (!isConnected()) return 0;

  const filter: Record<string, unknown> = {};
  if (repo) filter.repo = repo;
  if (source) filter.source = source;

  return scopedCountDocuments(VectorModel, tenantId, filter);
}
