import { RepoCardModel, isConnected } from '../shared/db.js';
import type { IRepoCard } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { scopedFind, scopedFindOne, scopedFindOneAndUpdate, scopedDeleteOne, tenantScope } from '../shared/scoped-query.js';

const log = createChildLogger({ module: 'app-card-store' });

export type RepoCardLevel = 'ok' | 'warn' | 'error' | 'unknown';

export interface UpsertRepoCardInput {
  repoName: string;
  description?: string;
  group?: string;
  localhostUrl?: string;
  appUrl?: string;
  apiUrl?: string;
  mongo?: string;
  vercelUrl?: string;
  dnsUrl?: string;
  lastStatus?: string;
  lastStatusLevel?: RepoCardLevel;
  reportedBy?: string;
  commitsAhead?: number;
}

export interface RepoCardView {
  repoName: string;
  description: string;
  group?: string;
  localhostUrl?: string;
  appUrl?: string;
  apiUrl?: string;
  mongo?: string;
  vercelUrl?: string;
  dnsUrl?: string;
  lastStatus?: string;
  lastStatusLevel: RepoCardLevel;
  reportedBy?: string;
  commitsAhead?: number;
  createdAt: Date;
  updatedAt: Date;
}

function toView(doc: IRepoCard): RepoCardView {
  return {
    repoName: doc.repoName,
    description: doc.description,
    group: doc.group,
    localhostUrl: doc.localhostUrl,
    appUrl: doc.appUrl,
    apiUrl: doc.apiUrl,
    mongo: doc.mongo,
    vercelUrl: doc.vercelUrl,
    dnsUrl: doc.dnsUrl,
    lastStatus: doc.lastStatus,
    lastStatusLevel: doc.lastStatusLevel,
    reportedBy: doc.reportedBy,
    commitsAhead: doc.commitsAhead,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Create or update a repo card keyed by repoName. Only provided fields are
 * written, so a `wrap up` that passes just {repoName, lastStatus} refreshes the
 * status without clobbering the static URLs a previous call set.
 */
export async function upsertRepoCard(tenantId: string, input: UpsertRepoCardInput): Promise<RepoCardView | null> {
  if (!isConnected() || !RepoCardModel) {
    log.warn('DB not connected — cannot upsert repo card');
    return null;
  }
  if (!input.repoName) throw new Error('repoName is required');

  const set: Record<string, unknown> = {};
  for (const k of ['description', 'group', 'localhostUrl', 'appUrl', 'apiUrl', 'mongo', 'vercelUrl', 'dnsUrl', 'lastStatus', 'lastStatusLevel', 'reportedBy'] as const) {
    if (input[k] !== undefined && input[k] !== '') set[k] = input[k];
  }
  // Numeric field: 0 is a meaningful value (test caught up to main), so only
  // undefined is skipped — unlike the string fields above, '' isn't a concern here.
  if (input.commitsAhead !== undefined) set.commitsAhead = input.commitsAhead;

  const doc = await scopedFindOneAndUpdate(
    RepoCardModel, tenantId,
    { repoName: input.repoName },
    { $set: set, $setOnInsert: { ...tenantScope(tenantId), repoName: input.repoName } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  log.info({ repo: input.repoName }, 'repo card upserted');
  return toView(doc as IRepoCard);
}

export async function listRepoCards(tenantId: string): Promise<RepoCardView[]> {
  if (!isConnected() || !RepoCardModel) return [];
  const docs = await scopedFind(RepoCardModel, tenantId, {}).sort({ group: 1, repoName: 1 }).lean<IRepoCard[]>();
  return docs.map(toView);
}

export async function getRepoCard(tenantId: string, repoName: string): Promise<RepoCardView | null> {
  if (!isConnected() || !RepoCardModel) return null;
  const doc = await scopedFindOne(RepoCardModel, tenantId, { repoName }).lean<IRepoCard | null>();
  return doc ? toView(doc) : null;
}

export async function deleteRepoCard(tenantId: string, repoName: string): Promise<boolean> {
  if (!isConnected() || !RepoCardModel) return false;
  const res = await scopedDeleteOne(RepoCardModel, tenantId, { repoName });
  return res.deletedCount > 0;
}
