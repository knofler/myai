import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { getConfig } from '../shared/config.js';
import { storeBatch, deleteVectors, getVectorCount } from './vector-store.js';
import { chunkStateFile, chunkHandoffFile, chunkArchiveFile } from './chunker.js';
import { createChildLogger } from '../shared/logger.js';
import { listRepoPaths } from '../repos/repo-registry.js';
import { DEFAULT_TENANT_ID, type IVector } from '../shared/db.js';

const log = createChildLogger({ module: 'indexer' });

export interface IndexResult {
  repo: string;
  source: IVector['source'];
  stored: number;
  skipped: number;
  failed: number;
}

/**
 * Index a repo's STATE.md into vectors.
 * Deletes existing state vectors for the repo first (full re-index).
 */
export async function indexStateFile(tenantId: string, repoPath: string, repoName?: string): Promise<IndexResult> {
  const name = repoName || basename(repoPath);
  const stateFile = resolve(repoPath, 'AI', 'state', 'STATE.md');

  // Master repo: state/ is at root level, not under AI/
  const masterStateFile = resolve(repoPath, 'state', 'STATE.md');
  const filePath = existsSync(stateFile) ? stateFile : existsSync(masterStateFile) ? masterStateFile : null;

  if (!filePath) {
    log.debug({ repo: name }, 'No STATE.md found — skipping');
    return { repo: name, source: 'state', stored: 0, skipped: 0, failed: 0 };
  }

  const content = readFileSync(filePath, 'utf-8');
  const chunks = chunkStateFile(content);

  if (chunks.length === 0) {
    return { repo: name, source: 'state', stored: 0, skipped: 0, failed: 0 };
  }

  // Delete existing state vectors for this repo (re-index)
  await deleteVectors(tenantId, name, 'state');

  const result = await storeBatch(tenantId,
    chunks.map(c => ({
      repo: name,
      source: c.source,
      content: c.content,
      tags: c.tags,
      metadata: c.metadata,
    })),
  );

  log.info({ repo: name, ...result }, 'STATE.md indexed');
  return { repo: name, source: 'state', ...result };
}

/**
 * Index a repo's AI_AGENT_HANDOFF.md into vectors.
 */
export async function indexHandoffFile(tenantId: string, repoPath: string, repoName?: string): Promise<IndexResult> {
  const name = repoName || basename(repoPath);
  const handoffFile = resolve(repoPath, 'AI', 'state', 'AI_AGENT_HANDOFF.md');
  const masterHandoffFile = resolve(repoPath, 'state', 'AI_AGENT_HANDOFF.md');
  const filePath = existsSync(handoffFile) ? handoffFile : existsSync(masterHandoffFile) ? masterHandoffFile : null;

  if (!filePath) {
    log.debug({ repo: name }, 'No AI_AGENT_HANDOFF.md found — skipping');
    return { repo: name, source: 'handoff', stored: 0, skipped: 0, failed: 0 };
  }

  const content = readFileSync(filePath, 'utf-8');
  const chunks = chunkHandoffFile(content);

  if (chunks.length === 0) {
    return { repo: name, source: 'handoff', stored: 0, skipped: 0, failed: 0 };
  }

  // Delete existing handoff vectors (re-index)
  await deleteVectors(tenantId, name, 'handoff');

  const result = await storeBatch(tenantId,
    chunks.map(c => ({
      repo: name,
      source: c.source,
      content: c.content,
      tags: c.tags,
      metadata: c.metadata,
    })),
  );

  log.info({ repo: name, ...result }, 'Handoff indexed');
  return { repo: name, source: 'handoff', ...result };
}

/**
 * Index all rotated session archives under state/archive/*.md.
 * Each file is chunked per `### Session:` block. Idempotent via content-hash dedup.
 * Skips the handoff archive (`handoff-pre-*.md`) since it doesn't use the Session header pattern.
 */
export async function indexArchiveFiles(tenantId: string, repoPath: string, repoName?: string): Promise<IndexResult> {
  const name = repoName || basename(repoPath);
  // Master repo: state/archive/. Managed repos: AI/state/archive/.
  const dirCandidates = [
    resolve(repoPath, 'state', 'archive'),
    resolve(repoPath, 'AI', 'state', 'archive'),
  ];
  const archiveDir = dirCandidates.find(p => existsSync(p));

  if (!archiveDir) {
    log.debug({ repo: name }, 'No state/archive directory — skipping');
    return { repo: name, source: 'archive', stored: 0, skipped: 0, failed: 0 };
  }

  const files = readdirSync(archiveDir)
    .filter(f => f.endsWith('.md') && /^\d{4}-\d{2}\.md$/.test(f));

  if (files.length === 0) {
    log.debug({ repo: name }, 'No month archive files (YYYY-MM.md) — skipping');
    return { repo: name, source: 'archive', stored: 0, skipped: 0, failed: 0 };
  }

  // Per-file streaming flush. Avoids accumulating every archive chunk in
  // memory before persistence — corpus grows linearly with project age, so
  // a single-batch call had memory pressure visible at 500+ chunks. Content-
  // hash dedup in storeBatch keeps the call idempotent across files.
  const totals = { stored: 0, skipped: 0, failed: 0 };

  for (const file of files) {
    const filePath = resolve(archiveDir, file);
    const content = readFileSync(filePath, 'utf-8');
    const chunks = chunkArchiveFile(content, file);
    if (chunks.length === 0) continue;

    const batch = chunks.map(c => ({
      repo: name,
      source: 'archive' as IVector['source'],
      content: c.content,
      tags: c.tags,
      metadata: c.metadata,
    }));

    const result = await storeBatch(tenantId, batch);
    totals.stored += result.stored;
    totals.skipped += result.skipped;
    totals.failed += result.failed;
  }

  log.info({ repo: name, files: files.length, ...totals }, 'Archives indexed');
  return { repo: name, source: 'archive', ...totals };
}

/**
 * Index the master repo (this repo). Called on bootstrap and on demand.
 */
export async function indexMasterRepo(tenantId: string = DEFAULT_TENANT_ID): Promise<IndexResult[]> {
  const config = getConfig();
  const repoPath = config.aiRoot;
  const results: IndexResult[] = [];

  results.push(await indexStateFile(tenantId, repoPath, 'ai_management'));
  results.push(await indexHandoffFile(tenantId, repoPath, 'ai_management'));
  results.push(await indexArchiveFiles(tenantId, repoPath, 'ai_management'));

  const totalStored = results.reduce((s, r) => s + r.stored, 0);
  const totalVectors = await getVectorCount(tenantId);
  log.info({ totalStored, totalVectors }, 'Master repo indexing complete');

  return results;
}

/**
 * Index all managed repos. Delegates managed_repos.txt parsing + path
 * resolution to `listRepoPaths()` so the indexer and the repo registry
 * share semantics (honors `REPOS_BASE=/repos` Docker mapping; inline-comment
 * stripping; tilde expansion). Master repo is indexed first.
 */
export async function indexAllRepos(tenantId: string = DEFAULT_TENANT_ID): Promise<IndexResult[]> {
  const results: IndexResult[] = [];

  // Index master repo first
  results.push(...await indexMasterRepo(tenantId));

  const managed = listRepoPaths();

  // Index each managed repo
  for (const repo of managed) {
    if (!repo.exists) {
      log.warn({ repo: repo.name, path: repo.path }, 'Managed repo path missing — skipping');
      continue;
    }
    try {
      results.push(await indexStateFile(tenantId, repo.path, repo.name));
      results.push(await indexHandoffFile(tenantId, repo.path, repo.name));
      results.push(await indexArchiveFiles(tenantId, repo.path, repo.name));
    } catch (err) {
      log.error({ repo: repo.name, err }, 'Failed to index repo');
    }
  }

  const totalStored = results.reduce((s, r) => s + r.stored, 0);
  const totalVectors = await getVectorCount(tenantId);
  log.info({ repos: managed.length + 1, totalStored, totalVectors }, 'All repos indexed');

  return results;
}
