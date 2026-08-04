// repo-store.ts — tenant-scoped CRUD for the fleet ROSTER (ADR-021).
// The DB source of truth for which repos a tenant tracks, replacing the flat
// config/managed_repos.txt. Self-registered via `myai init` / `myai scan`.
// Mirrors app-card-store.ts (RepoCard = display metadata; Repo = roster).
import { RepoModel, isConnected } from '../shared/db.js';
import type { IRepo } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { scopedFind, scopedFindOne, scopedFindOneAndUpdate, scopedDeleteOne, tenantScope } from '../shared/scoped-query.js';

const log = createChildLogger({ module: 'repo-store' });

export type RepoSource = 'seed' | 'myai-init' | 'scan' | 'manual' | 'repocard' | 'headless-new-app';

export interface UpsertRepoInput {
  name: string;
  path: string;
  gitRemote?: string;
  brainNamespace?: string;
  stack?: string[];
  group?: string;
  source?: RepoSource;
  enabled?: boolean;
  lastSeenAt?: Date;
}

export interface RepoView {
  name: string;
  path: string;
  gitRemote?: string;
  brainNamespace?: string;
  stack: string[];
  group?: string;
  source: RepoSource;
  enabled: boolean;
  lastSeenAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

function toView(doc: IRepo): RepoView {
  return {
    name: doc.name,
    path: doc.path,
    gitRemote: doc.gitRemote,
    brainNamespace: doc.brainNamespace,
    stack: doc.stack ?? [],
    group: doc.group,
    source: doc.source,
    enabled: doc.enabled,
    lastSeenAt: doc.lastSeenAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Create or update a roster entry keyed by (tenantId, name). Only provided
 * fields are written, so a re-scan that passes {name, path} refreshes the path
 * without clobbering a brainNamespace an earlier `myai init` set. `path` and a
 * default `source` are stamped on insert.
 */
export async function upsertRepo(tenantId: string, input: UpsertRepoInput): Promise<RepoView | null> {
  if (!isConnected() || !RepoModel) {
    log.warn('DB not connected — cannot upsert repo');
    return null;
  }
  if (!input.name) throw new Error('name is required');
  if (!input.path) throw new Error('path is required');

  // NB: `source` is insert-time provenance — it lives in $setOnInsert ONLY. Do
  // NOT add it here, or Mongo rejects the update ("would create a conflict at
  // 'source'") because the same path can't be in both $set and $setOnInsert.
  const set: Record<string, unknown> = {};
  for (const k of ['path', 'gitRemote', 'brainNamespace', 'stack', 'group', 'enabled', 'lastSeenAt'] as const) {
    if (input[k] !== undefined) set[k] = input[k];
  }

  const doc = await scopedFindOneAndUpdate(
    RepoModel, tenantId,
    { name: input.name },
    { $set: set, $setOnInsert: { ...tenantScope(tenantId), name: input.name, source: input.source ?? 'manual' } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  log.info({ repo: input.name, source: input.source }, 'repo roster entry upserted');
  return toView(doc as IRepo);
}

/** List a tenant's roster. `enabledOnly` (default true) hides disabled entries. */
export async function listRepos(tenantId: string, opts: { enabledOnly?: boolean } = {}): Promise<RepoView[]> {
  if (!isConnected() || !RepoModel) return [];
  const filter = opts.enabledOnly === false ? {} : { enabled: true };
  const docs = await scopedFind(RepoModel, tenantId, filter).sort({ group: 1, name: 1 }).lean<IRepo[]>();
  return docs.map(toView);
}

export async function getRepo(tenantId: string, name: string): Promise<RepoView | null> {
  if (!isConnected() || !RepoModel) return null;
  const doc = await scopedFindOne(RepoModel, tenantId, { name }).lean<IRepo | null>();
  return doc ? toView(doc) : null;
}

export async function deleteRepo(tenantId: string, name: string): Promise<boolean> {
  if (!isConnected() || !RepoModel) return false;
  const res = await scopedDeleteOne(RepoModel, tenantId, { name });
  return res.deletedCount > 0;
}
