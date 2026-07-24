import { HandoffModel, isConnected } from '../shared/db.js';
import type { IHandoff, HandoffStatus } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { scopedFind, scopedFindOne, scopedFindOneAndUpdate, scopedCountDocuments, tenantScope } from '../shared/scoped-query.js';

const log = createChildLogger({ module: 'handoff-store' });

/**
 * First-class handoff store (betaC). Replaces the git-synced
 * AI_AGENT_HANDOFF.md with a tenant-scoped, queryable gateway primitive.
 *
 * Writes are append-only: every session close adds a new entry per repo, so the
 * handoff trail is auditable across sessions and machines. `readHandoff` returns
 * the most recent entry for a repo (the "what's next" the next agent needs),
 * with optional history.
 */

export interface WriteHandoffInput {
  repo: string;
  content: string;
  summary?: string;
  author?: string;
  branch?: string;
  machine?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface HandoffView {
  id: string;
  repo: string;
  content: string;
  summary?: string;
  author?: string;
  branch?: string;
  machine?: string;
  sessionId?: string;
  status: HandoffStatus;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

function toView(doc: IHandoff): HandoffView {
  return {
    id: String(doc._id),
    repo: doc.repo,
    content: doc.content,
    summary: doc.summary,
    author: doc.author,
    branch: doc.branch,
    machine: doc.machine,
    sessionId: doc.sessionId,
    status: doc.status,
    metadata: doc.metadata ?? {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Append a new handoff entry for a repo. Returns the stored view, or null if the
 * DB is unavailable (callers can then fall back to writing the file directly).
 */
export async function writeHandoff(tenantId: string, input: WriteHandoffInput): Promise<HandoffView | null> {
  if (!isConnected() || !HandoffModel) {
    log.warn('DB not connected — cannot write handoff');
    return null;
  }
  if (!input.repo) throw new Error('repo is required');
  if (!input.content || !input.content.trim()) throw new Error('content is required');

  const doc = await HandoffModel.create({
    ...tenantScope(tenantId),
    repo: input.repo,
    content: input.content,
    summary: input.summary,
    author: input.author,
    branch: input.branch,
    machine: input.machine,
    sessionId: input.sessionId,
    status: 'active',
    metadata: input.metadata ?? {},
  });
  log.info({ repo: input.repo, author: input.author }, 'handoff written');
  return toView(doc as IHandoff);
}

export interface ReadHandoffResult {
  repo: string;
  latest: HandoffView | null;
  history: HandoffView[];
  total: number;
}

/**
 * Read the most recent handoff for a repo. When `historyLimit` > 0, also returns
 * up to that many recent entries (newest first, including the latest).
 */
export async function readHandoff(
  tenantId: string,
  repo: string,
  opts: { historyLimit?: number } = {},
): Promise<ReadHandoffResult> {
  if (!isConnected() || !HandoffModel) {
    return { repo, latest: null, history: [], total: 0 };
  }
  if (!repo) throw new Error('repo is required');

  const historyLimit = Math.max(0, opts.historyLimit ?? 0);
  const fetchN = Math.max(1, historyLimit);

  const docs = await scopedFind(HandoffModel, tenantId, { repo })
    .sort({ createdAt: -1 })
    .limit(fetchN)
    .lean<IHandoff[]>();

  const total = await scopedCountDocuments(HandoffModel, tenantId, { repo });
  const views = docs.map(toView);

  return {
    repo,
    latest: views[0] ?? null,
    history: historyLimit > 0 ? views.slice(0, historyLimit) : [],
    total,
  };
}

/**
 * List the latest handoff for every repo a tenant has handoffs for. Powers the
 * dashboard/REST overview. One entry per repo (the most recent).
 */
export async function listLatestHandoffs(tenantId: string, limit = 100): Promise<HandoffView[]> {
  if (!isConnected() || !HandoffModel) return [];
  const docs = await scopedFind(HandoffModel, tenantId, {})
    .sort({ createdAt: -1 })
    .lean<IHandoff[]>();

  const seen = new Set<string>();
  const latest: HandoffView[] = [];
  for (const d of docs) {
    if (seen.has(d.repo)) continue;
    seen.add(d.repo);
    latest.push(toView(d));
    if (latest.length >= limit) break;
  }
  return latest;
}

/** Mark a single handoff entry archived (kept for audit, hidden from "active"). */
export async function archiveHandoff(tenantId: string, id: string): Promise<boolean> {
  if (!isConnected() || !HandoffModel) return false;
  const doc = await scopedFindOneAndUpdate(HandoffModel, tenantId, { _id: id }, { $set: { status: 'archived' } }, { new: true });
  return !!doc;
}

/** Fetch a single handoff entry by id (tenant-scoped). */
export async function getHandoff(tenantId: string, id: string): Promise<HandoffView | null> {
  if (!isConnected() || !HandoffModel) return null;
  const doc = await scopedFindOne(HandoffModel, tenantId, { _id: id }).lean<IHandoff | null>();
  return doc ? toView(doc) : null;
}
