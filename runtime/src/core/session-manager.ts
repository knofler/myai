import { v4 as uuid } from 'uuid';
import { GatewaySessionModel, isConnected } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { getConfig } from '../shared/config.js';
import { scopedUpdateOne, scopedFind, scopedFindOne, scopedFindOneAndUpdate, tenantScope } from '../shared/scoped-query.js';
import type { Session, GatewayMessage, SessionStatus } from '../shared/types.js';

const log = createChildLogger({ module: 'session-manager' });

// In-memory session cache (source of truth is MongoDB, this is for fast access)
const sessions = new Map<string, Session>();

export async function createSession(tenantId: string, agentName: string, metadata: Record<string, unknown> = {}): Promise<Session> {
  const config = getConfig();

  if (sessions.size >= config.sessions.maxConcurrentSessions) {
    throw new Error(`Max concurrent sessions (${config.sessions.maxConcurrentSessions}) reached`);
  }

  const session: Session = {
    id: uuid(),
    tenantId,
    agentName,
    status: 'active',
    messages: [],
    workspace: '',
    createdAt: new Date(),
    lastActivity: new Date(),
    metadata,
  };

  sessions.set(session.id, session);

  // Persist to MongoDB — stamp the tenant so the row is owned + scoped.
  if (isConnected()) {
    await GatewaySessionModel.create({
      ...tenantScope(tenantId),
      sessionId: session.id,
      agentName: session.agentName,
      status: session.status,
      messages: [],
      workspace: session.workspace,
      metadata: session.metadata,
    });
  }

  log.info({ sessionId: session.id, agentName }, 'Session created');
  return session;
}

export async function addMessage(sessionId: string, message: GatewayMessage): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  session.messages.push(message);
  session.lastActivity = new Date();
  session.status = 'active';

  // Check if compaction needed
  const config = getConfig();
  if (session.messages.length >= config.sessions.compactionThreshold) {
    await compactSession(sessionId);
  }

  // Persist message to MongoDB (scoped to the session's owning tenant)
  if (isConnected()) {
    await scopedUpdateOne(
      GatewaySessionModel, session.tenantId,
      { sessionId },
      {
        $push: { messages: { id: message.id, role: message.role, content: message.content, agentName: message.agentName, channelType: message.channelType, channelId: message.channelId, metadata: message.metadata, timestamp: message.timestamp } },
        $set: { status: 'active', updatedAt: new Date() },
      },
    );
  }
}

export async function compactSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;

  const config = getConfig();
  const keep = config.sessions.compactionKeepRecent;
  const total = session.messages.length;

  if (total <= keep) return;

  session.status = 'compacting';
  log.info({ sessionId, total, keep }, 'Compacting session');

  // Summarize old messages into a single context message
  const oldMessages = session.messages.slice(0, total - keep);
  const summary = oldMessages
    .map(m => `[${m.role}] ${m.content.slice(0, 200)}`)
    .join('\n');

  const compactionMessage: GatewayMessage = {
    id: uuid(),
    sessionId,
    role: 'system',
    content: `[Session compaction — ${oldMessages.length} messages summarized]\n${summary}`,
    metadata: { compaction: true, compactedCount: oldMessages.length },
    timestamp: new Date(),
  };

  // Replace messages: compaction summary + recent messages
  session.messages = [compactionMessage, ...session.messages.slice(total - keep)];
  session.status = 'active';

  // Update MongoDB (scoped to the session's owning tenant)
  if (isConnected()) {
    await scopedUpdateOne(
      GatewaySessionModel, session.tenantId,
      { sessionId },
      {
        $set: {
          messages: session.messages.map(m => ({
            id: m.id, role: m.role, content: m.content, agentName: m.agentName,
            channelType: m.channelType, channelId: m.channelId, metadata: m.metadata, timestamp: m.timestamp,
          })),
          status: 'active',
          compactionCount: (session.metadata.compactionCount as number || 0) + 1,
        },
      },
    );
  }

  log.info({ sessionId, before: total, after: session.messages.length }, 'Session compacted');
}

export async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.status = 'closed';

  if (isConnected()) {
    await scopedUpdateOne(
      GatewaySessionModel, session.tenantId,
      { sessionId },
      { $set: { status: 'closed', closedAt: new Date() } },
    );
  }

  sessions.delete(sessionId);
  log.info({ sessionId }, 'Session closed');
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

/**
 * List in-memory sessions, optionally filtered by status and/or owning tenant.
 * `tenantId` filters the process-local cache so the session monitor never shows
 * one tenant another's live sessions (ADR-010 §3.5). Omitting it returns all
 * tenants (system/admin view) — non-breaking for single-tenant callers.
 */
export function listSessions(status?: SessionStatus, tenantId?: string): Session[] {
  let all = Array.from(sessions.values());
  if (tenantId !== undefined) all = all.filter(s => s.tenantId === tenantId);
  if (!status) return all;
  return all.filter(s => s.status === status);
}

export function getSessionCount(): number {
  return sessions.size;
}

export function getActiveSessionCount(): number {
  return Array.from(sessions.values()).filter(s => s.status === 'active').length;
}

// ── Session export / import + cross-session recall (betaC context-SHARING) ──
//
// These let a session's context follow the user between devices. `exportSession`
// produces a portable, tenant-owned bundle (durable DB copy preferred over the
// in-memory cache so the full message history travels). `importSession` rehydrates
// that bundle on another machine — stamped with the IMPORTING tenant so a bundle
// can never smuggle a foreign tenant id (ADR-010 §3.5). `recallSessionContext`
// stitches the tenant's recent sessions into a ready-to-inject digest so a fresh
// session on a new device can pick up where the last one left off.

/** Bump when the export bundle shape changes incompatibly. */
export const SESSION_EXPORT_VERSION = 1 as const;

/** A portable, self-describing snapshot of a single session. Tenant-agnostic on
 *  purpose: the importing tenant is stamped at import time, not carried in the file. */
export interface SessionExport {
  version: number;
  exportedAt: Date;
  session: {
    id: string;
    agentName: string;
    status: SessionStatus;
    messages: GatewayMessage[];
    workspace: string;
    createdAt: Date;
    lastActivity: Date;
    metadata: Record<string, unknown>;
  };
}

/** Rehydrate persisted DB message sub-docs into full GatewayMessages for a session. */
function dbMessagesToGateway(sessionId: string, raw: unknown): GatewayMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((m: Record<string, unknown>) => ({
    id: String(m.id),
    sessionId,
    role: m.role as GatewayMessage['role'],
    content: String(m.content ?? ''),
    agentName: m.agentName as string | undefined,
    channelType: m.channelType as string | undefined,
    channelId: m.channelId as string | undefined,
    metadata: (m.metadata as Record<string, unknown>) ?? {},
    timestamp: m.timestamp ? new Date(m.timestamp as string | Date) : new Date(),
  }));
}

/**
 * Export a session as a portable bundle, tenant-scoped. Prefers the durable DB
 * copy (full history, survives process restarts and is reachable from any device
 * on the shared Atlas) and falls back to the in-memory cache when the DB is down.
 * Returns null when the session does not exist or is not owned by this tenant.
 */
export async function exportSession(tenantId: string, sessionId: string): Promise<SessionExport | null> {
  if (!sessionId) throw new Error('sessionId is required');

  // Durable copy first — the DB row is tenant-scoped, so a cross-tenant id misses.
  if (isConnected() && GatewaySessionModel) {
    const doc = await scopedFindOne(GatewaySessionModel, tenantId, { sessionId }).lean<Record<string, unknown> | null>();
    if (doc) {
      return {
        version: SESSION_EXPORT_VERSION,
        exportedAt: new Date(),
        session: {
          id: sessionId,
          agentName: String(doc.agentName ?? ''),
          status: (doc.status as SessionStatus) ?? 'active',
          messages: dbMessagesToGateway(sessionId, doc.messages),
          workspace: String(doc.workspace ?? ''),
          createdAt: doc.createdAt ? new Date(doc.createdAt as string | Date) : new Date(),
          lastActivity: doc.updatedAt ? new Date(doc.updatedAt as string | Date) : new Date(),
          metadata: (doc.metadata as Record<string, unknown>) ?? {},
        },
      };
    }
  }

  // Fall back to the process-local cache — only if THIS tenant owns it.
  const cached = sessions.get(sessionId);
  if (!cached || cached.tenantId !== tenantId) return null;
  return {
    version: SESSION_EXPORT_VERSION,
    exportedAt: new Date(),
    session: {
      id: cached.id,
      agentName: cached.agentName,
      status: cached.status,
      messages: cached.messages,
      workspace: cached.workspace,
      createdAt: cached.createdAt,
      lastActivity: cached.lastActivity,
      metadata: cached.metadata,
    },
  };
}

export interface ImportSessionOptions {
  /** Keep the bundle's original session id instead of minting a fresh one. When the
   *  id already exists (same device re-import), the existing session is updated in
   *  place (idempotent). Default false → always a new id, so cross-device imports
   *  never collide. */
  preserveId?: boolean;
}

/**
 * Import a session bundle for a tenant. The session is stamped with the IMPORTING
 * tenant (never the bundle's origin), every message's sessionId is rewritten to the
 * target id, and the result is loaded into the cache + persisted. Honors the
 * concurrent-session ceiling when adding a genuinely new cache entry.
 */
export async function importSession(
  tenantId: string,
  bundle: SessionExport,
  opts: ImportSessionOptions = {},
): Promise<Session> {
  if (!bundle || typeof bundle !== 'object' || !bundle.session) {
    throw new Error('Invalid session bundle');
  }
  if (bundle.version !== SESSION_EXPORT_VERSION) {
    throw new Error(`Unsupported session bundle version ${bundle.version} (expected ${SESSION_EXPORT_VERSION})`);
  }

  const targetId = opts.preserveId && bundle.session.id ? bundle.session.id : uuid();
  const isReplacingCached = sessions.has(targetId);

  // Only the ceiling for brand-new cache entries — re-importing an existing id replaces.
  const config = getConfig();
  if (!isReplacingCached && sessions.size >= config.sessions.maxConcurrentSessions) {
    throw new Error(`Max concurrent sessions (${config.sessions.maxConcurrentSessions}) reached`);
  }

  const messages: GatewayMessage[] = (bundle.session.messages ?? []).map(m => ({ ...m, sessionId: targetId }));

  const session: Session = {
    id: targetId,
    tenantId,
    agentName: bundle.session.agentName,
    status: bundle.session.status === 'closed' ? 'active' : bundle.session.status,
    messages,
    workspace: bundle.session.workspace ?? '',
    createdAt: bundle.session.createdAt ? new Date(bundle.session.createdAt) : new Date(),
    lastActivity: new Date(),
    metadata: {
      ...(bundle.session.metadata ?? {}),
      importedFrom: bundle.session.id,
      importedAt: new Date().toISOString(),
    },
  };

  sessions.set(targetId, session);

  if (isConnected() && GatewaySessionModel) {
    const messageDocs = messages.map(m => ({
      id: m.id, role: m.role, content: m.content, agentName: m.agentName,
      channelType: m.channelType, channelId: m.channelId, metadata: m.metadata, timestamp: m.timestamp,
    }));
    // Upsert so a preserveId re-import is idempotent; tenant-scoped on the filter.
    await scopedFindOneAndUpdate(
      GatewaySessionModel, tenantId,
      { sessionId: targetId },
      {
        ...tenantScope(tenantId),
        $set: {
          sessionId: targetId,
          agentName: session.agentName,
          status: session.status,
          messages: messageDocs,
          workspace: session.workspace,
          metadata: session.metadata,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  log.info({ sessionId: targetId, from: bundle.session.id, agentName: session.agentName, messages: messages.length }, 'Session imported');
  return session;
}

export interface RecalledSession {
  id: string;
  agentName: string;
  status: SessionStatus;
  lastActivity: Date;
  messageCount: number;
  recentMessages: Array<{ role: string; content: string; timestamp: Date }>;
}

export interface RecallContextResult {
  tenantId: string;
  sessionCount: number;
  sessions: RecalledSession[];
  /** Ready-to-inject markdown summary of recent cross-session activity. */
  digest: string;
}

export interface RecallContextOptions {
  /** Only recall sessions for this agent (optional). */
  agentName?: string;
  /** Max sessions to recall (default 5). */
  limit?: number;
  /** Recent messages to include per session (default 4, newest last). */
  perSessionMessages?: number;
}

/**
 * Recall the tenant's recent sessions into a single context block so a fresh
 * session — typically on another device — can resume with continuity. Prefers the
 * durable DB (cross-device) and falls back to the in-memory cache. The `digest`
 * is a markdown block ready to seed a new session's system context.
 */
export async function recallSessionContext(
  tenantId: string,
  opts: RecallContextOptions = {},
): Promise<RecallContextResult> {
  const limit = Math.max(1, opts.limit ?? 5);
  const perSession = Math.max(0, opts.perSessionMessages ?? 4);

  let recalled: RecalledSession[] = [];

  if (isConnected() && GatewaySessionModel) {
    const filter: Record<string, unknown> = {};
    if (opts.agentName) filter.agentName = opts.agentName;
    const docs = await scopedFind(GatewaySessionModel, tenantId, filter)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean<Array<Record<string, unknown>>>();
    recalled = docs.map(d => {
      const msgs = dbMessagesToGateway(String(d.sessionId), d.messages);
      return {
        id: String(d.sessionId),
        agentName: String(d.agentName ?? ''),
        status: (d.status as SessionStatus) ?? 'active',
        lastActivity: d.updatedAt ? new Date(d.updatedAt as string | Date) : new Date(),
        messageCount: msgs.length,
        recentMessages: msgs.slice(-perSession).map(m => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
      };
    });
  } else {
    // Cache fallback — this tenant's sessions, newest activity first.
    recalled = Array.from(sessions.values())
      .filter(s => s.tenantId === tenantId && (!opts.agentName || s.agentName === opts.agentName))
      .sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime())
      .slice(0, limit)
      .map(s => ({
        id: s.id,
        agentName: s.agentName,
        status: s.status,
        lastActivity: s.lastActivity,
        messageCount: s.messages.length,
        recentMessages: s.messages.slice(-perSession).map(m => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
      }));
  }

  const digest = buildRecallDigest(recalled);
  return { tenantId, sessionCount: recalled.length, sessions: recalled, digest };
}

/** Render recalled sessions as a compact markdown context block. */
function buildRecallDigest(recalled: RecalledSession[]): string {
  if (recalled.length === 0) return '_No prior sessions to recall._';
  const lines: string[] = ['# Cross-session context', ''];
  for (const s of recalled) {
    lines.push(`## ${s.agentName} — ${s.status} (${s.messageCount} msg, last ${s.lastActivity.toISOString()})`);
    for (const m of s.recentMessages) {
      const snippet = m.content.length > 240 ? `${m.content.slice(0, 240)}…` : m.content;
      lines.push(`- **${m.role}**: ${snippet}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
