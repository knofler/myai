/**
 * Operator support-login-as-tenant (impersonation).
 *
 * A support capability, distinct from RBAC (what a role may do) and from
 * session management (a user's OWN devices): the operator opens a TIME-BOXED,
 * fully audited session INTO a tenant to debug an issue. Read-only by default
 * — the session is scoped down to the `viewer` role AND every mutating request
 * is hard-rejected by `impersonationGuard` below (defense in depth: the RBAC
 * lattice grants `read` to every role, so a role downgrade alone is not
 * read-only). Explicit elevation (`readOnly: false`) keeps the target user's
 * real role and is stamped as such in the audit trail.
 *
 * Trust chain:
 *  - START is gated by `requireAdmin` (x-admin-token == ADMIN_API_TOKEN) in
 *    server.ts — the same operator posture as every cross-tenant admin route.
 *  - The minted token is a NORMAL session JWT plus the server-only `imp`
 *    claims (user-auth.ts `issueImpersonationToken`), so it rides every
 *    existing choke point unchanged: `exp` auto-expiry, sessionRevocationGuard
 *    (a recorded UserSession row → the tenant can see and revoke it), and RBAC
 *    role resolution from the JWT claim.
 *  - EVERY request made under an impersonated session is stamped into the
 *    TARGET tenant's audit chain (`impersonation.action` /
 *    `impersonation.denied_write`) by the guard — the tenant's own trail shows
 *    exactly what support saw and did.
 */
import type { NextFunction, Request, Response } from 'express';
import { UserModel, TenantModel, type IUser, type UserRole } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { recordAuditEvent } from './audit-log.js';
import { AuthError, type CtxRole } from './tenant-context.js';
import { issueImpersonationToken, verifyJwt, type ImpersonationClaims, type JwtPayload } from './user-auth.js';
import { revokeSession } from './user-sessions.js';

const log = createChildLogger({ module: 'impersonation' });

/** Default support-session length when the operator doesn't say. */
export const IMPERSONATION_DEFAULT_MINUTES = 30;
/** Hard ceiling — a support session can never outlive this. */
export const IMPERSONATION_MAX_MINUTES = 120;
const MAX_REASON_LEN = 300;

export interface StartImpersonationInput {
  tenantId: string;
  /** Impersonate this member; omitted → the tenant's owner. */
  email?: string;
  /** Mandatory justification — lands on every audit line of the session. */
  reason: string;
  /** Session length, clamped to [1, IMPERSONATION_MAX_MINUTES]. */
  minutes?: number;
  /** Default true. `false` = explicit elevation: keeps the target's real role. */
  readOnly?: boolean;
  userAgent?: string;
  ip?: string;
}

export interface StartImpersonationResult {
  token: string;
  expiresAt: string;
  readOnly: boolean;
  minutes: number;
  user: { userId: string; email: string; role: UserRole };
  tenantId: string;
}

/**
 * Open a support session into a tenant. Caller (server.ts) has already passed
 * the operator gate — this validates the target, mints the time-boxed token,
 * and stamps `impersonation.start` into the target tenant's audit chain.
 */
export async function startImpersonation(input: StartImpersonationInput): Promise<StartImpersonationResult> {
  const tenantId = (input.tenantId ?? '').trim();
  if (!tenantId) throw new AuthError('tenantId required', 400, 'BAD_REQUEST');
  const reason = (input.reason ?? '').trim().slice(0, MAX_REASON_LEN);
  if (!reason) throw new AuthError('reason required — every support session must record why it was opened', 400, 'BAD_REQUEST');

  const readOnly = input.readOnly !== false; // read-only unless EXPLICITLY elevated
  const rawMinutes = typeof input.minutes === 'number' && Number.isFinite(input.minutes)
    ? Math.floor(input.minutes)
    : IMPERSONATION_DEFAULT_MINUTES;
  const minutes = Math.min(Math.max(rawMinutes, 1), IMPERSONATION_MAX_MINUTES);

  if (!TenantModel || !UserModel) throw new AuthError('database unavailable', 503, 'DB_UNAVAILABLE');
  const tenant = await TenantModel.findOne({ tenantId }).lean();
  if (!tenant) throw new AuthError('tenant not found', 404, 'NOT_FOUND');

  const user = input.email
    ? await UserModel.findOne({ tenantId, email: input.email.toLowerCase().trim() }).lean<IUser>()
    : await UserModel.findOne({ tenantId, role: 'owner' }).lean<IUser>();
  if (!user) throw new AuthError('no matching user in tenant to impersonate', 404, 'NOT_FOUND');

  const imp: ImpersonationClaims = { by: 'operator', reason, ro: readOnly };
  // Read-only sessions run as `viewer` (least privilege); elevation keeps the
  // target's real role — both enforced from the JWT claim by RBAC + the guard.
  const sessionRole: UserRole = readOnly ? ('viewer' as UserRole) : user.role;
  const token = await issueImpersonationToken({
    userId: user.userId,
    tenantId,
    email: user.email,
    role: sessionRole,
    expiresInSeconds: minutes * 60,
    imp,
    userAgent: input.userAgent,
    ip: input.ip,
  });
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();

  recordAuditEvent({
    tenantId,
    actor: { role: 'operator', via: 'operator' },
    action: 'impersonation.start',
    target: user.userId,
    detail: { email: user.email, reason, readOnly, minutes, expiresAt, ip: input.ip },
  });
  log.warn({ tenantId, target: user.userId, readOnly, minutes }, 'operator impersonation session opened');

  return { token, expiresAt, readOnly, minutes, user: { userId: user.userId, email: user.email, role: sessionRole }, tenantId };
}

/**
 * End a support session early: revoke its UserSession row (the
 * sessionRevocationGuard makes that effective on the next request — the token
 * itself is stateless) and stamp `impersonation.end`. Natural `exp` expiry
 * needs no call here — the JWT simply stops verifying.
 */
export async function endImpersonation(payload: JwtPayload): Promise<{ ok: true }> {
  if (!payload.imp) throw new AuthError('not an impersonation session', 400, 'NOT_IMPERSONATION');
  try {
    if (payload.sid) await revokeSession(payload.sub, payload.sid);
  } catch (err) {
    log.warn({ err, sid: payload.sid }, 'failed to revoke impersonation session row — token still expires naturally');
  }
  recordAuditEvent({
    tenantId: payload.tid,
    actor: { userId: payload.sub, role: 'operator', via: 'operator' },
    action: 'impersonation.end',
    target: payload.sub,
    detail: { sid: payload.sid, reason: payload.imp.reason },
  });
  return { ok: true };
}

// ── Guard middleware ─────────────────────────────────────────────────────────

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// The only mutations a READ-ONLY support session may perform: leaving it.
const READ_ONLY_WRITE_EXEMPT = new Set(['/api/auth/impersonation/end', '/api/auth/logout']);

/**
 * Global middleware (mounted right after sessionRevocationGuard): inert for
 * every request that doesn't carry an impersonation JWT. For requests that do:
 *  1. stamps the request into the target tenant's audit chain — the "every
 *     impersonated action is audited" guarantee lives HERE, not per-handler;
 *  2. hard-rejects mutating methods on read-only sessions (403
 *     IMPERSONATION_READ_ONLY), except ending the session itself.
 * Invalid/expired tokens pass through untouched — route-level verifyJwt is
 * what rejects them (same contract as sessionRevocationGuard).
 */
export function impersonationGuard(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.myai_token || req.header('authorization')?.replace('Bearer ', '');
  if (!token) { next(); return; }

  let payload: JwtPayload;
  try {
    payload = verifyJwt(token);
  } catch {
    next(); return;
  }
  if (!payload.imp) { next(); return; }

  const blocked = payload.imp.ro && !SAFE_METHODS.has(req.method) && !READ_ONLY_WRITE_EXEMPT.has(req.path);
  recordAuditEvent({
    tenantId: payload.tid,
    actor: { userId: payload.sub, role: payload.role as CtxRole, via: 'operator' },
    action: blocked ? 'impersonation.denied_write' : 'impersonation.action',
    target: `${req.method} ${req.path}`,
    detail: { sid: payload.sid, readOnly: payload.imp.ro, reason: payload.imp.reason },
  });

  if (blocked) {
    res.status(403).json({ error: 'impersonation session is read-only — writes are disabled', code: 'IMPERSONATION_READ_ONLY' });
    return;
  }
  next();
}
