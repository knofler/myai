/**
 * Active session / device management (M2 gap close).
 *
 * Every login method (password, magic-link, SSO, TOTP-verify) records one
 * UserSession row via `recordSession()` and embeds the returned id as the
 * JWT's `sid` claim (see core/user-auth.ts). This lets the dashboard list a
 * user's active devices (UA/IP/last-seen), revoke one or all, and lets
 * password-reset force-revoke every outstanding session — the gap the old
 * password-reset.ts docstring called out ("HS256 without a token denylist
 * can't revoke them").
 *
 * Best-effort by design: a DB hiccup while recording/touching a session must
 * never block login. `isSessionRevoked` treats an untracked sessionId (no
 * matching row — e.g. recorded before this feature shipped, or the write
 * above failed) as NOT revoked, so it can only ever narrow access, never
 * accidentally lock everyone out.
 */
import crypto from 'node:crypto';
import { UserSessionModel } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { recordAuditEvent } from './audit-log.js';
import type { CtxRole } from './tenant-context.js';

const log = createChildLogger({ module: 'user-sessions' });

export interface DeviceInfo {
  userAgent?: string;
  ip?: string;
}

export interface SessionSummary {
  sessionId: string;
  userAgent?: string;
  ip?: string;
  createdAt: Date;
  lastSeenAt: Date;
  current: boolean;
}

const MAX_UA_LEN = 300;

/** Record a new session row at token-mint time. Always returns a sessionId
 *  (for the JWT's `sid`) even if the DB write fails — revocation for that
 *  particular session just won't be possible, login itself is never blocked. */
export async function recordSession(
  params: { userId: string; tenantId: string; role?: CtxRole } & DeviceInfo,
): Promise<string> {
  const sessionId = crypto.randomUUID();

  // Audit trail line for the security-anomaly-alerter's impossible-travel
  // detector (needs a per-login ip). Independent of the UserSessionModel
  // write below — file-backed, so it still fires when Mongo isn't connected —
  // and best-effort by contract (recordAuditEvent never throws).
  recordAuditEvent({
    tenantId: params.tenantId,
    actor: { userId: params.userId, role: params.role ?? 'member', via: 'jwt' },
    action: 'session.login',
    target: params.userId,
    detail: { ip: params.ip, userAgent: params.userAgent?.slice(0, MAX_UA_LEN) },
  });

  if (!UserSessionModel) return sessionId;
  try {
    await UserSessionModel.create({
      sessionId,
      userId: params.userId,
      tenantId: params.tenantId,
      userAgent: params.userAgent?.slice(0, MAX_UA_LEN),
      ip: params.ip,
      lastSeenAt: new Date(),
    });
  } catch (err) {
    log.warn({ err, userId: params.userId }, 'failed to record session — login proceeds without one');
  }
  return sessionId;
}

/** True only when the session was recorded AND explicitly revoked. */
export async function isSessionRevoked(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId || !UserSessionModel) return false;
  try {
    const doc = await UserSessionModel.findOne({ sessionId }).lean<{ revokedAt?: Date | null } | null>();
    return !!doc?.revokedAt;
  } catch (err) {
    log.warn({ err, sessionId }, 'session revocation check failed — allowing request through');
    return false;
  }
}

// Throttle lastSeenAt writes — one DB write per session per window, not per request.
const TOUCH_THROTTLE_MS = 60_000;
const lastTouchAt = new Map<string, number>();

/** Fire-and-forget: bump lastSeenAt (and refresh UA/IP) for an active session. */
export function touchSession(sessionId: string | undefined, device: DeviceInfo): void {
  if (!sessionId || !UserSessionModel) return;
  const now = Date.now();
  const prev = lastTouchAt.get(sessionId) ?? 0;
  if (now - prev < TOUCH_THROTTLE_MS) return;
  lastTouchAt.set(sessionId, now);

  const set: Record<string, unknown> = { lastSeenAt: new Date() };
  if (device.ip) set.ip = device.ip;
  if (device.userAgent) set.userAgent = device.userAgent.slice(0, MAX_UA_LEN);

  void UserSessionModel.updateOne({ sessionId }, { $set: set }).catch((err: unknown) => {
    log.warn({ err, sessionId }, 'failed to touch session lastSeenAt');
  });
}

/** List a user's active (non-revoked) sessions, newest activity first. */
export async function listUserSessions(userId: string, currentSessionId?: string): Promise<SessionSummary[]> {
  if (!UserSessionModel) return [];
  const docs = await UserSessionModel.find({ userId, revokedAt: null })
    .sort({ lastSeenAt: -1 })
    .lean<Array<{ sessionId: string; userAgent?: string; ip?: string; createdAt: Date; lastSeenAt: Date }>>();
  return docs.map((d) => ({
    sessionId: d.sessionId,
    userAgent: d.userAgent,
    ip: d.ip,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    current: d.sessionId === currentSessionId,
  }));
}

/** Revoke one session — scoped to the caller's own userId so no one can revoke
 *  another account's session by guessing a sessionId. */
export async function revokeSession(userId: string, sessionId: string): Promise<{ revoked: boolean }> {
  if (!UserSessionModel || !sessionId) return { revoked: false };
  const res = await UserSessionModel.updateOne(
    { userId, sessionId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  return { revoked: (res.matchedCount ?? 0) > 0 };
}

/** Revoke every active session for a user — used by "revoke all" in the UI and
 *  by password-reset (fires for every session, there's no "current" to keep). */
export async function revokeAllSessions(
  userId: string,
  opts: { exceptSessionId?: string } = {},
): Promise<{ revokedCount: number }> {
  if (!UserSessionModel) return { revokedCount: 0 };
  const filter: Record<string, unknown> = { userId, revokedAt: null };
  if (opts.exceptSessionId) filter.sessionId = { $ne: opts.exceptSessionId };
  const res = await UserSessionModel.updateMany(filter, { $set: { revokedAt: new Date() } });
  return { revokedCount: res.modifiedCount ?? 0 };
}
