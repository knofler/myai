/**
 * Atlas Vector Search index provisioning (self-healing, boot-time).
 *
 * Root cause of the PR #390 incident: the Atlas cluster had NO search index on
 * `vectors`, so every `$vectorSearch` returned `[]` WITHOUT throwing and recall
 * silently died (the fallback in vector-store.ts now self-heals to local ANN,
 * but the Atlas path stayed dark). This module makes the index a property of
 * the CODE, not the cluster: `ensureAtlasVectorSearchIndex()` runs on gateway
 * boot (core/index.ts) whenever the backend is Atlas, and creates/repairs the
 * index so it survives cluster rebuilds, migrations and new deployments.
 *
 * The desired definition mirrors `buildAtlasVectorSearchPipeline` exactly:
 * `embedding` as the ANN vector (cosine — embeddings are normalized MiniLM),
 * dims from config (384 for all-MiniLM-L6-v2), and every field the pipeline
 * pins in `$vectorSearch.filter` registered as a `filter` field — above all
 * `tenantId` (ADR-010 §1.5 #3): an index without it makes every tenant-scoped
 * query return zero rows.
 */
import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';
import { VectorModel, isConnected } from '../shared/db.js';
import { atlasVectorIndexName, detectVectorBackend } from './vector-index.js';

const log = createChildLogger({ module: 'atlas-search-index' });

/** Every path `buildAtlasVectorSearchPipeline` may pin in the pre-filter. */
export const VECTOR_INDEX_FILTER_PATHS = ['tenantId', 'repo', 'source', 'tags', 'createdAt'] as const;

export interface VectorSearchIndexField {
  type: 'vector' | 'filter';
  path: string;
  numDimensions?: number;
  similarity?: 'cosine' | 'euclidean' | 'dotProduct';
}

export interface VectorSearchIndexDefinition {
  fields: VectorSearchIndexField[];
}

/** The canonical index definition for the `vectors` collection. */
export function buildVectorSearchIndexDefinition(dims?: number): VectorSearchIndexDefinition {
  const numDimensions = dims ?? getConfig().memory.embedding.dimensions;
  return {
    fields: [
      { type: 'vector', path: 'embedding', numDimensions, similarity: 'cosine' },
      ...VECTOR_INDEX_FILTER_PATHS.map(path => ({ type: 'filter' as const, path })),
    ],
  };
}

/**
 * Compare an existing index definition against the desired one. Returns a list
 * of human-readable problems — empty means the index is correct as-is.
 */
export function diffVectorSearchIndex(
  existing: { fields?: VectorSearchIndexField[] } | undefined,
  desired: VectorSearchIndexDefinition,
): string[] {
  const problems: string[] = [];
  const fields = existing?.fields ?? [];

  const vector = fields.find(f => f.type === 'vector' && f.path === 'embedding');
  const wantVector = desired.fields.find(f => f.type === 'vector')!;
  if (!vector) {
    problems.push('no vector field on path "embedding"');
  } else {
    if (vector.numDimensions !== wantVector.numDimensions) {
      problems.push(`dims mismatch: index has ${vector.numDimensions}, embeddings are ${wantVector.numDimensions}`);
    }
    if (vector.similarity !== wantVector.similarity) {
      problems.push(`similarity mismatch: index has ${vector.similarity}, want ${wantVector.similarity}`);
    }
  }

  const filterPaths = new Set(fields.filter(f => f.type === 'filter').map(f => f.path));
  for (const path of VECTOR_INDEX_FILTER_PATHS) {
    if (!filterPaths.has(path)) problems.push(`missing filter field "${path}"`);
  }
  return problems;
}

export interface EnsureVectorIndexResult {
  action: 'created' | 'updated' | 'recreated' | 'ok' | 'skipped' | 'failed';
  index: string;
  /** Problems found on an existing index (what an update/recreate fixed). */
  problems?: string[];
  /** Whether Atlas reports the index queryable yet (false right after create). */
  queryable?: boolean;
  reason?: string;
}

/**
 * Minimal slice of the driver `Collection` search-index surface we use —
 * injectable so tests can exercise every branch without an Atlas cluster.
 */
export interface SearchIndexCollection {
  listSearchIndexes(): { toArray(): Promise<Array<Record<string, unknown>>> };
  createSearchIndex(model: { name: string; type: string; definition: VectorSearchIndexDefinition }): Promise<string>;
  updateSearchIndex(name: string, definition: VectorSearchIndexDefinition): Promise<void>;
  dropSearchIndex(name: string): Promise<void>;
}

/**
 * Idempotently create or repair the Atlas Vector Search index. Never throws —
 * on a non-Atlas backend (or local `mongo:7`, where the search-index commands
 * don't exist) it reports `skipped`/`failed` and the embedded-ANN fallback in
 * vector-store.ts keeps recall alive.
 *
 * NOTE: a freshly created/updated index takes ~1 min to become queryable;
 * until then `$vectorSearch` still returns `[]` and the PR #390 fallback
 * covers the window.
 */
export async function ensureAtlasVectorSearchIndex(
  coll?: SearchIndexCollection,
): Promise<EnsureVectorIndexResult> {
  const name = atlasVectorIndexName();
  if (!coll) {
    if (!isConnected() || detectVectorBackend() !== 'atlas') {
      return { action: 'skipped', index: name, reason: 'backend is not Atlas (or Mongo not connected)' };
    }
    coll = VectorModel.collection as unknown as SearchIndexCollection;
  }

  const desired = buildVectorSearchIndexDefinition();
  try {
    const existing = (await coll.listSearchIndexes().toArray())
      .find(ix => ix.name === name);

    if (!existing) {
      await coll.createSearchIndex({ name, type: 'vectorSearch', definition: desired });
      log.info({ index: name, dims: desired.fields[0].numDimensions }, 'Atlas vector search index CREATED (queryable in ~1 min; local-ANN fallback covers until then)');
      return { action: 'created', index: name, queryable: false };
    }

    // The driver reports the live definition under `latestDefinition`.
    const liveDef = (existing.latestDefinition ?? existing.definition) as
      | { fields?: VectorSearchIndexField[] }
      | undefined;
    const queryable = existing.queryable === true;

    // A same-named index of type `search` can't serve `$vectorSearch` and
    // can't be converted in place — drop and recreate.
    if (existing.type !== 'vectorSearch') {
      await coll.dropSearchIndex(name);
      await coll.createSearchIndex({ name, type: 'vectorSearch', definition: desired });
      log.warn({ index: name, wrongType: existing.type }, 'Atlas index had wrong type — dropped and recreated as vectorSearch');
      return { action: 'recreated', index: name, problems: [`wrong index type "${existing.type}"`], queryable: false };
    }

    const problems = diffVectorSearchIndex(liveDef, desired);
    if (problems.length === 0) {
      return { action: 'ok', index: name, queryable };
    }

    await coll.updateSearchIndex(name, desired);
    log.warn({ index: name, problems }, 'Atlas vector search index definition repaired (update takes ~1 min to apply)');
    return { action: 'updated', index: name, problems, queryable: false };
  } catch (err) {
    // Non-fatal by contract: local mongo lacks the search-index commands, an
    // M0 cluster may hit its 3-index cap, permissions may be missing, etc.
    log.warn({ err, index: name }, 'Could not ensure Atlas vector search index — recall stays on the embedded-ANN fallback');
    return { action: 'failed', index: name, reason: (err as Error).message };
  }
}
