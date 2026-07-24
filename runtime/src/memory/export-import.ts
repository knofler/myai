import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import { VectorModel, isConnected } from '../shared/db.js';
import type { IVector } from '../shared/db.js';
import { scopedFind, scopedFindOne, tenantScope } from '../shared/scoped-query.js';
import { storeBatch } from './vector-store.js';
import { getEmbeddingProvider } from './embeddings.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'memory-export-import' });

/**
 * Portable memory bundle — `myai memory export|import`.
 *
 * Export renders the tenant's vector corpus (the SOURCE TEXTS behind the
 * embeddings: state blocks, handoff notes, patterns, archived sessions, …) as
 * a JSON manifest + one markdown file per entry. Embeddings are deliberately
 * NOT exported: they are provider/dimension-specific, so the bundle stays
 * model-agnostic and import re-embeds on the target with whatever embedding
 * provider that gateway runs.
 *
 * Import parses the markdown files (frontmatter = provenance, body = source
 * text) and stores them through the normal vector-store path, which embeds
 * each entry and deduplicates by content hash — importing the same bundle
 * twice, or importing into a store that already holds some of the corpus, is
 * a no-op for the overlapping entries.
 *
 * Content is trim()-normalized at both ends. The indexer's chunker already
 * trims every chunk before storing, so hashes of exported entries survive the
 * markdown round-trip and re-import into the origin store dedups cleanly.
 */

export const MEMORY_BUNDLE_KIND = 'myai-memory-bundle';
export const MEMORY_BUNDLE_FORMAT_VERSION = 1;

export const VECTOR_SOURCES: IVector['source'][] = [
  'state', 'handoff', 'commit', 'pr', 'pattern', 'bug', 'code', 'feature', 'archive',
  // `external` = context ingested from a foreign source (ChatGPT/Claude export,
  // Obsidian vault, markdown/docs folder, raw vector store) via
  // `myai context import-external`. Tagged distinctly so imported context can be
  // filtered/attributed apart from this framework's own state/handoff/commit corpus.
  'external',
];

export interface MemoryBundleEntryMeta {
  path: string;
  repo: string;
  source: IVector['source'];
  contentHash: string;
  tags: string[];
  sessionId: string;
  createdAt: string;
}

export interface MemoryBundleManifest {
  kind: typeof MEMORY_BUNDLE_KIND;
  formatVersion: number;
  exportedAt: string;
  counts: {
    total: number;
    bySource: Record<string, number>;
    byRepo: Record<string, number>;
  };
  entries: MemoryBundleEntryMeta[];
}

export interface MemoryBundleFile {
  path: string;
  content: string;
}

export interface MemoryBundle {
  manifest: MemoryBundleManifest;
  files: MemoryBundleFile[];
}

export interface ParsedBundleEntry {
  repo: string;
  source: IVector['source'];
  content: string;
  contentHash: string;
  tags: string[];
  sessionId: string;
  metadata: Record<string, unknown>;
  /** Original creation time carried through import in metadata. */
  originalCreatedAt?: string;
  /** Set when the frontmatter hash disagrees with the recomputed one. */
  hashMismatch: boolean;
}

export interface ImportResult {
  filesTotal: number;
  parsed: number;
  invalid: Array<{ path: string; error: string }>;
  dedupedInBundle: number;
  hashMismatches: number;
  stored: number;
  skippedExisting: number;
  failed: number;
}

/** Same hash the vector store dedups on (sha256 hex, first 16 chars). */
export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** Filesystem-safe path for an entry inside the bundle. */
function entryPath(repo: string, source: string, hash: string): string {
  const safeRepo = repo.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'unknown';
  return `memory/${safeRepo}/${source}-${hash}.md`;
}

/** Render one corpus entry as a markdown file with provenance frontmatter. */
export function renderEntryMarkdown(entry: {
  repo: string;
  source: string;
  content: string;
  contentHash: string;
  tags?: string[];
  sessionId?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date | string;
}): string {
  const data: Record<string, unknown> = {
    repo: entry.repo,
    source: entry.source,
    contentHash: entry.contentHash,
    tags: entry.tags || [],
    sessionId: entry.sessionId || '',
    createdAt: entry.createdAt ? new Date(entry.createdAt).toISOString() : '',
  };
  if (entry.metadata && Object.keys(entry.metadata).length > 0) {
    // JSON-encode metadata: survives YAML round-trips for arbitrary shapes.
    data.metadataJson = JSON.stringify(entry.metadata);
  }
  return matter.stringify(entry.content.trim(), data);
}

/** Parse a bundle markdown file back into a corpus entry. Throws on invalid input. */
export function parseEntryMarkdown(raw: string): ParsedBundleEntry {
  const parsed = matter(raw);
  const fm = parsed.data as Record<string, unknown>;

  const repo = typeof fm.repo === 'string' ? fm.repo.trim() : '';
  if (!repo) throw new Error('frontmatter missing "repo"');

  const source = typeof fm.source === 'string' ? fm.source.trim() : '';
  if (!VECTOR_SOURCES.includes(source as IVector['source'])) {
    throw new Error(`frontmatter "source" must be one of ${VECTOR_SOURCES.join('|')} (got "${source}")`);
  }

  const content = parsed.content.trim();
  if (!content) throw new Error('empty content body');

  // Content is authoritative: dedup on the RECOMPUTED hash, never the declared
  // one (hand-authored or edited bundles may carry stale/absent hashes).
  const hash = contentHash(content);
  const declared = typeof fm.contentHash === 'string' ? fm.contentHash : '';

  let metadata: Record<string, unknown> = {};
  if (typeof fm.metadataJson === 'string' && fm.metadataJson) {
    try {
      metadata = JSON.parse(fm.metadataJson) as Record<string, unknown>;
    } catch {
      throw new Error('frontmatter "metadataJson" is not valid JSON');
    }
  }

  return {
    repo,
    source: source as IVector['source'],
    content,
    contentHash: hash,
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
    sessionId: typeof fm.sessionId === 'string' ? fm.sessionId : '',
    metadata,
    originalCreatedAt: typeof fm.createdAt === 'string' && fm.createdAt ? fm.createdAt : undefined,
    hashMismatch: Boolean(declared) && declared !== hash,
  };
}

/**
 * Export the tenant's memory corpus as a portable bundle.
 * Optionally filtered by repo and/or source. Embeddings are never included.
 */
export async function exportMemoryBundle(tenantId: string, opts: {
  repo?: string;
  source?: IVector['source'];
} = {}): Promise<MemoryBundle> {
  if (!isConnected()) {
    throw new Error('MongoDB not connected — cannot export memory');
  }

  const filter: Record<string, unknown> = {};
  if (opts.repo) filter.repo = opts.repo;
  if (opts.source) filter.source = opts.source;

  const docs = await scopedFind(VectorModel, tenantId, filter)
    .select('-embedding')
    .sort({ createdAt: 1 })
    .lean<IVector[]>();

  const entries: MemoryBundleEntryMeta[] = [];
  const files: MemoryBundleFile[] = [];
  const bySource: Record<string, number> = {};
  const byRepo: Record<string, number> = {};

  for (const doc of docs) {
    const content = (doc.content || '').trim();
    if (!content) continue;
    // Recompute from the (trimmed) text so the manifest hash always matches
    // what a round-trip import will dedup on.
    const hash = contentHash(content);
    const path = entryPath(doc.repo, doc.source, hash);

    files.push({
      path,
      content: renderEntryMarkdown({
        repo: doc.repo,
        source: doc.source,
        content,
        contentHash: hash,
        tags: doc.tags,
        sessionId: doc.sessionId,
        metadata: doc.metadata,
        createdAt: doc.createdAt,
      }),
    });
    entries.push({
      path,
      repo: doc.repo,
      source: doc.source,
      contentHash: hash,
      tags: doc.tags || [],
      sessionId: doc.sessionId || '',
      createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : '',
    });
    bySource[doc.source] = (bySource[doc.source] || 0) + 1;
    byRepo[doc.repo] = (byRepo[doc.repo] || 0) + 1;
  }

  const manifest: MemoryBundleManifest = {
    kind: MEMORY_BUNDLE_KIND,
    formatVersion: MEMORY_BUNDLE_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    counts: { total: entries.length, bySource, byRepo },
    entries,
  };

  log.info({ total: entries.length, repo: opts.repo, source: opts.source }, 'Memory bundle exported');
  return { manifest, files };
}

/**
 * Import a memory bundle: parse each markdown file, dedup by content hash
 * (within the bundle, then against the store), and re-embed on this gateway.
 */
export async function importMemoryBundle(tenantId: string, bundle: {
  manifest?: Partial<MemoryBundleManifest>;
  files: MemoryBundleFile[];
}): Promise<ImportResult> {
  if (!isConnected()) {
    throw new Error('MongoDB not connected — cannot import memory');
  }
  if (!Array.isArray(bundle.files)) {
    throw new Error('bundle.files must be an array of { path, content }');
  }
  if (bundle.manifest) {
    if (bundle.manifest.kind && bundle.manifest.kind !== MEMORY_BUNDLE_KIND) {
      throw new Error(`manifest.kind must be "${MEMORY_BUNDLE_KIND}" (got "${bundle.manifest.kind}")`);
    }
    const v = bundle.manifest.formatVersion;
    if (v !== undefined && v > MEMORY_BUNDLE_FORMAT_VERSION) {
      throw new Error(`bundle formatVersion ${v} is newer than supported ${MEMORY_BUNDLE_FORMAT_VERSION}`);
    }
  }

  const invalid: ImportResult['invalid'] = [];
  const seen = new Set<string>();
  let dedupedInBundle = 0;
  let hashMismatches = 0;
  const importedAt = new Date().toISOString();

  const chunks: Array<{
    repo: string;
    source: IVector['source'];
    content: string;
    tags: string[];
    sessionId: string;
    metadata: Record<string, unknown>;
  }> = [];

  for (const file of bundle.files) {
    if (!file || typeof file.content !== 'string') {
      invalid.push({ path: file?.path || '(unknown)', error: 'missing content' });
      continue;
    }
    let entry: ParsedBundleEntry;
    try {
      entry = parseEntryMarkdown(file.content);
    } catch (err) {
      invalid.push({ path: file.path || '(unknown)', error: (err as Error).message });
      continue;
    }
    if (entry.hashMismatch) hashMismatches++;

    const key = `${entry.repo}|${entry.source}|${entry.contentHash}`;
    if (seen.has(key)) {
      dedupedInBundle++;
      continue;
    }
    seen.add(key);

    chunks.push({
      repo: entry.repo,
      source: entry.source,
      content: entry.content,
      tags: entry.tags,
      sessionId: entry.sessionId,
      metadata: {
        ...entry.metadata,
        importedAt,
        ...(entry.originalCreatedAt ? { originalCreatedAt: entry.originalCreatedAt } : {}),
      },
    });
  }

  // storeBatch embeds each chunk on THIS gateway's provider and skips entries
  // whose (repo, source, contentHash) already exist for the tenant.
  const result = chunks.length > 0
    ? await storeBatch(tenantId, chunks)
    : { stored: 0, skipped: 0, failed: 0 };

  const summary: ImportResult = {
    filesTotal: bundle.files.length,
    parsed: chunks.length + dedupedInBundle,
    invalid,
    dedupedInBundle,
    hashMismatches,
    stored: result.stored,
    skippedExisting: result.skipped,
    failed: result.failed,
  };
  log.info(summary, 'Memory bundle import complete');
  return summary;
}

// ── Full vector corpus (WITH embeddings) — `myai context export|import` ────────
//
// The portable MEMORY bundle above is deliberately embedding-free (model-
// agnostic; import re-embeds). The CONTEXT bundle (`myai context …`) wants the
// operator to OWN and download the whole corpus, embeddings included, so it can
// be restored LOSSLESSLY onto a gateway running the same embedding model — no
// re-embed pass, byte-for-byte vectors preserved. When the target gateway runs
// a different-dimension model, import falls back to re-embedding (the source
// text is always present), so the bundle stays universally importable.

export const VECTOR_CORPUS_KIND = 'myai-vector-corpus';
export const VECTOR_CORPUS_FORMAT_VERSION = 1;

export interface VectorCorpusEntry {
  repo: string;
  source: IVector['source'];
  content: string;
  contentHash: string;
  tags: string[];
  sessionId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  embedding: number[];
}

export interface VectorCorpus {
  kind: typeof VECTOR_CORPUS_KIND;
  formatVersion: number;
  exportedAt: string;
  embedding: { dimensions: number };
  count: number;
  entries: VectorCorpusEntry[];
}

export interface VectorCorpusImportResult {
  entriesTotal: number;
  insertedWithEmbedding: number;
  reEmbedded: number;
  skippedExisting: number;
  invalid: number;
  failed: number;
  dimensionMismatch: boolean;
}

/**
 * Export the tenant's vector corpus WITH embeddings — the lossless dump behind
 * `myai context export`. Optionally filtered by repo/source.
 */
export async function exportVectorCorpus(tenantId: string, opts: {
  repo?: string;
  source?: IVector['source'];
} = {}): Promise<VectorCorpus> {
  if (!isConnected()) {
    throw new Error('MongoDB not connected — cannot export vector corpus');
  }

  const filter: Record<string, unknown> = {};
  if (opts.repo) filter.repo = opts.repo;
  if (opts.source) filter.source = opts.source;

  // embedding is `select: false` on the schema — opt it back in explicitly.
  const docs = await scopedFind(VectorModel, tenantId, filter)
    .select('+embedding')
    .sort({ createdAt: 1 })
    .lean<IVector[]>();

  const entries: VectorCorpusEntry[] = [];
  for (const doc of docs) {
    const content = (doc.content || '').trim();
    if (!content) continue;
    entries.push({
      repo: doc.repo,
      source: doc.source,
      content,
      contentHash: contentHash(content),
      tags: doc.tags || [],
      sessionId: doc.sessionId || '',
      metadata: doc.metadata || {},
      createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : '',
      embedding: Array.isArray(doc.embedding) ? doc.embedding : [],
    });
  }

  const dimensions = getEmbeddingProvider().dimensions;
  log.info({ count: entries.length, dimensions, repo: opts.repo }, 'Vector corpus exported');
  return {
    kind: VECTOR_CORPUS_KIND,
    formatVersion: VECTOR_CORPUS_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    embedding: { dimensions },
    count: entries.length,
    entries,
  };
}

/**
 * Import a vector corpus. Entries whose stored embedding matches THIS gateway's
 * embedding dimensions are inserted verbatim (lossless, deduped by
 * repo+source+contentHash); the rest are re-embedded through the normal store
 * path so the corpus still lands.
 */
export async function importVectorCorpus(tenantId: string, corpus: {
  kind?: string;
  formatVersion?: number;
  embedding?: { dimensions?: number };
  entries?: Partial<VectorCorpusEntry>[];
}): Promise<VectorCorpusImportResult> {
  if (!isConnected()) {
    throw new Error('MongoDB not connected — cannot import vector corpus');
  }
  if (corpus.kind && corpus.kind !== VECTOR_CORPUS_KIND) {
    throw new Error(`corpus.kind must be "${VECTOR_CORPUS_KIND}" (got "${corpus.kind}")`);
  }
  if (corpus.formatVersion !== undefined && corpus.formatVersion > VECTOR_CORPUS_FORMAT_VERSION) {
    throw new Error(`corpus formatVersion ${corpus.formatVersion} is newer than supported ${VECTOR_CORPUS_FORMAT_VERSION}`);
  }
  const entries = Array.isArray(corpus.entries) ? corpus.entries : [];

  const localDims = getEmbeddingProvider().dimensions;
  const sourceDims = corpus.embedding?.dimensions;
  const dimensionMismatch = typeof sourceDims === 'number' && sourceDims !== localDims;

  let insertedWithEmbedding = 0, skippedExisting = 0, invalid = 0, failed = 0;
  const toReEmbed: Array<{
    repo: string; source: IVector['source']; content: string;
    tags: string[]; sessionId: string; metadata: Record<string, unknown>;
  }> = [];

  for (const e of entries) {
    const content = typeof e.content === 'string' ? e.content.trim() : '';
    const source = e.source;
    if (!content || !source || !VECTOR_SOURCES.includes(source)) { invalid++; continue; }
    const repo = typeof e.repo === 'string' && e.repo ? e.repo : 'unknown';
    const hash = contentHash(content);
    const tags = Array.isArray(e.tags) ? e.tags.map(String) : [];
    const sessionId = typeof e.sessionId === 'string' ? e.sessionId : '';
    const metadata = (e.metadata && typeof e.metadata === 'object') ? e.metadata : {};
    const embedding = Array.isArray(e.embedding) ? e.embedding : [];

    // Lossless path: embedding present AND same dimensions as this gateway.
    if (embedding.length === localDims && localDims > 0) {
      try {
        const dup = await scopedFindOne(VectorModel, tenantId, { repo, source, contentHash: hash });
        if (dup) { skippedExisting++; continue; }
        await VectorModel.create({
          ...tenantScope(tenantId),
          repo, source, content, embedding, tags, sessionId,
          metadata: { ...metadata, importedAt: new Date().toISOString() },
          contentHash: hash,
        });
        insertedWithEmbedding++;
      } catch (err) {
        log.error({ err, repo, source }, 'Vector corpus insert failed');
        failed++;
      }
      continue;
    }
    // Fallback: re-embed on this gateway (dimension mismatch or missing vector).
    toReEmbed.push({ repo, source, content, tags, sessionId, metadata });
  }

  const batch = toReEmbed.length > 0 ? await storeBatch(tenantId, toReEmbed) : { stored: 0, skipped: 0, failed: 0 };

  const summary: VectorCorpusImportResult = {
    entriesTotal: entries.length,
    insertedWithEmbedding,
    reEmbedded: batch.stored,
    skippedExisting: skippedExisting + batch.skipped,
    invalid,
    failed: failed + batch.failed,
    dimensionMismatch,
  };
  log.info(summary, 'Vector corpus import complete');
  return summary;
}
