/**
 * M2 — Password-based user authentication for the dashboard.
 *
 * Signup creates a tenant + user + API key in one atomic flow. Login returns a
 * signed JWT. The dashboard stores the JWT in an httpOnly cookie; every SSR
 * request includes it. The JWT carries tenantId + userId + role so the
 * dashboard can scope all queries without hitting the DB on every render.
 *
 * bcrypt for password hashing (constant work factor regardless of password
 * entropy — this defends against credential-stuffing on the public signup
 * surface). SHA-256 remains correct for API keys (see auth.ts header).
 */
import crypto from 'node:crypto';
import { UserModel, TenantModel, DEFAULT_TENANT_ID, type IUser, type UserRole, type TenantPlan } from '../shared/db.js';
import { checkEntitlement, EntitlementError } from './entitlements.js';
import { provisionTenant } from './tenant-keys.js';
import { redeemInvite, markInviteAccepted } from './invites.js';
import { AuthError } from './tenant-context.js';
import { createChildLogger } from '../shared/logger.js';
import { notifyLifecycleMilestone } from '../notifications/lifecycle-emails.js';
import { sendAccountLockedEmail } from './account-unlock.js';
import { recordSession, type DeviceInfo } from './user-sessions.js';

const log = createChildLogger({ module: 'user-auth' });

// ── Lockout (auto-unlock-via-email is the recovery path — account-unlock.ts) ──
// After LOCKOUT_THRESHOLD consecutive failed logins, the account locks for
// LOCKOUT_DURATION_MINUTES (hard-wait fallback) AND an unlock email fires
// immediately so the user can self-serve recover without waiting it out.
const LOCKOUT_THRESHOLD = Number(process.env.AUTH_LOCKOUT_THRESHOLD) || 5;
const LOCKOUT_DURATION_MINUTES = Number(process.env.AUTH_LOCKOUT_DURATION_MIN) || 30;

// ── bcrypt (pure-JS fallback to avoid native addon dependency) ──

const BCRYPT_ROUNDS = 12;

export const MIN_PASSWORD_LENGTH = 8;

let bcryptHash: (pw: string, rounds: number) => Promise<string>;
let bcryptCompare: (pw: string, hash: string) => Promise<boolean>;

try {
  // bcryptjs is CommonJS. Under `node` ESM (compiled dist) `await import()`
  // exposes the module only on `.default` (named exports are NOT synthesized),
  // so `mod.hash` is undefined and would crash on first use. Under vitest/tsx
  // the named exports ARE synthesized. Resolve `.default` first so both the
  // test runner and the production `node dist` runtime get a real `hash`/`compare`.
  const mod = (await import('bcryptjs')) as unknown as {
    default?: { hash: typeof bcryptHash; compare: typeof bcryptCompare };
    hash?: typeof bcryptHash;
    compare?: typeof bcryptCompare;
  };
  const lib = mod.default ?? mod;
  if (typeof lib.hash !== 'function' || typeof lib.compare !== 'function') {
    throw new Error('bcryptjs missing hash/compare');
  }
  bcryptHash = (pw, rounds) => lib.hash!(pw, rounds);
  bcryptCompare = (pw, hash) => lib.compare!(pw, hash);
} catch {
  // Deferred: if bcryptjs is not installed/resolvable, these throw on first use.
  bcryptHash = async () => { throw new Error('bcryptjs not installed — run npm i bcryptjs'); };
  bcryptCompare = async () => { throw new Error('bcryptjs not installed'); };
}

/** Canonical password hasher — signup, bootstrap admin, and password reset all use it. */
export async function hashPassword(password: string): Promise<string> {
  return bcryptHash(password, BCRYPT_ROUNDS);
}

// ── JWT (HS256 — symmetric, single-issuer gateway) ──

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  // Ephemeral secret: every gateway restart invalidates all sessions, and two
  // instances sign with different keys (tokens won't validate cross-instance).
  // Fine for local dev; MUST be set for any hosted/multi-instance deployment.
  log.warn(
    'JWT_SECRET is not set — using an ephemeral per-process secret. Sessions will ' +
      'not survive a restart and are not valid across instances. Set JWT_SECRET in production.',
  );
}
const JWT_EXPIRES_SECONDS = Number(process.env.JWT_EXPIRES_SECONDS) || 86400; // 24h

export interface JwtPayload {
  sub: string;        // userId
  tid: string;        // tenantId
  email: string;
  role: UserRole;
  sid: string;         // session id — UserSession row this token maps to (device mgmt / revocation)
  iat: number;
  exp: number;
}

function base64url(input: string | Buffer): string {
  const b = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return b.toString('base64url');
}

function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + JWT_EXPIRES_SECONDS,
  };
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(fullPayload));
  const signature = base64url(
    crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest(),
  );
  return `${header}.${body}.${signature}`;
}

/**
 * Mint a session JWT for an already-authenticated principal. Password login,
 * signup, and the SSO path (core/sso.ts) all issue the IDENTICAL token via this
 * one helper, so the session shape/expiry can never diverge by auth method.
 * Records a UserSession row (device mgmt / revocation) and embeds its id as `sid`.
 */
export async function issueSessionToken(claims: {
  userId: string;
  tenantId: string;
  email: string;
  role: UserRole;
} & DeviceInfo): Promise<string> {
  const sid = await recordSession({ userId: claims.userId, tenantId: claims.tenantId, role: claims.role, userAgent: claims.userAgent, ip: claims.ip });
  return signJwt({ sub: claims.userId, tid: claims.tenantId, email: claims.email, role: claims.role, sid });
}

// ── TOTP MFA pending token (short-lived, distinct from the session JWT) ──
// Issued when password verification succeeds but the account has TOTP
// enabled — the caller must then present this token + a valid code to
// /api/auth/totp/verify to get a real session token. Domain-separated from
// the session JWT (`typ: 'mfa'`) and far shorter-lived (5 min) so a leaked
// pending token is far less useful than a leaked session token, and
// `verifyJwt` will never accept one as a real session (different typ).

const MFA_PENDING_EXPIRES_SECONDS = 5 * 60;

export interface MfaPendingPayload {
  sub: string; // userId
  tid: string; // tenantId
  typ: 'mfa';
  iat: number;
  exp: number;
}

export function issueMfaPendingToken(claims: { userId: string; tenantId: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: MfaPendingPayload = {
    sub: claims.userId,
    tid: claims.tenantId,
    typ: 'mfa',
    iat: now,
    exp: now + MFA_PENDING_EXPIRES_SECONDS,
  };
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'MFA' }));
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${signature}`;
}

export function verifyMfaPendingToken(token: string): MfaPendingPayload {
  const parts = (token || '').split('.');
  if (parts.length !== 3) throw new AuthError('invalid or expired MFA session — please log in again', 401);

  const [header, body, sig] = parts;
  const expected = base64url(crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest());
  const sigBuf = Buffer.from(sig, 'base64url');
  const expBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new AuthError('invalid or expired MFA session — please log in again', 401);
  }

  let payload: MfaPendingPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as MfaPendingPayload;
  } catch {
    throw new AuthError('invalid or expired MFA session — please log in again', 401);
  }
  if (payload.typ !== 'mfa') throw new AuthError('invalid or expired MFA session — please log in again', 401);
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new AuthError('MFA session expired — please log in again', 401);
  }
  return payload;
}

export function verifyJwt(token: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('invalid token');

  const [header, body, sig] = parts;
  const expected = base64url(
    crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest(),
  );

  const sigBuf = Buffer.from(sig, 'base64url');
  const expBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new AuthError('invalid token');
  }

  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JwtPayload & { typ?: string };
  // A pending-MFA token is signed with the SAME secret (domain separation is
  // by claim shape, not key), so without this check it would verify here as
  // if it were a real session — reachable via any route that only calls
  // verifyJwt()/jwtFromReq() and never checks role, e.g. GET /totp/status.
  if (payload.typ === 'mfa') throw new AuthError('invalid token');
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new AuthError('token expired');
  }
  return payload;
}

// ── Signup ──

export interface SignupInput {
  email: string;
  password: string;
  displayName?: string;
  tenantName?: string;
  /** Team tier: redeem an invite and join the inviter's tenant instead of
   *  provisioning a new one. Role comes from the invite (default member). */
  inviteToken?: string;
}

export interface SignupResult {
  token: string;
  /** Absent on invite-joins — the tenant's key already exists and is never re-exposed. */
  apiKey?: string;
  tenantId: string;
  userId: string;
  tenantName?: string;
  plan?: TenantPlan;
  role: UserRole;
}

export async function signup(input: SignupInput, device: DeviceInfo = {}): Promise<SignupResult> {
  const email = input.email.toLowerCase().trim();
  if (!email || !email.includes('@')) throw new AuthError('invalid email', 400, 'BAD_REQUEST');
  if (!input.password || input.password.length < 8) {
    throw new AuthError('password must be at least 8 characters', 400, 'BAD_REQUEST');
  }

  const existingUser = await UserModel.findOne({ email }).lean();
  if (existingUser) {
    throw new AuthError('email already registered', 409, 'CONFLICT');
  }

  const userId = `u_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

  // ── Invite path: join the inviter's existing tenant ──
  if (input.inviteToken) {
    const invite = await redeemInvite(input.inviteToken, email);
    const tenant = await TenantModel.findOne({ tenantId: invite.tenantId }).lean();
    // Hard seat cap at the point of materialization — the definitive backstop.
    // createInvite's pre-check counts reserved seats but can still be raced by
    // invites created concurrently; this gate runs when the seat is actually
    // claimed, so a plan can never exceed teamSeats. It runs BEFORE the user is
    // created and the invite is burned, so a rejected join leaves the invite
    // reusable once a seat frees up (+1 = the member about to exist).
    const seatVerdict = await checkEntitlement('seats', invite.tenantId, tenant?.plan ?? 'free', { extra: 1 });
    if (!seatVerdict.allowed) throw new EntitlementError(seatVerdict);
    const passwordHash = await bcryptHash(input.password, BCRYPT_ROUNDS);
    await UserModel.create({
      userId,
      tenantId: invite.tenantId,
      email,
      passwordHash,
      displayName: input.displayName || email.split('@')[0],
      role: invite.role,
    });
    // Only after the user exists — a failed create must not burn the invite.
    await markInviteAccepted(invite.inviteId, userId);

    log.info({ tenantId: invite.tenantId, userId, email, role: invite.role }, 'user joined tenant via invite');

    const sid = await recordSession({ userId, tenantId: invite.tenantId, role: invite.role, userAgent: device.userAgent, ip: device.ip });
    const token = signJwt({ sub: userId, tid: invite.tenantId, email, role: invite.role, sid });
    return { token, tenantId: invite.tenantId, userId, tenantName: tenant?.name, plan: tenant?.plan, role: invite.role };
  }

  // ── Default path: provision a fresh tenant + owner + API key ──
  const tenantId = `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const tenantName = input.tenantName || `${email}'s workspace`;

  const { rawKey } = await provisionTenant({
    tenantId,
    name: tenantName,
    plan: 'free',
    ownerEmail: email,
    env: 'live',
  });

  const passwordHash = await bcryptHash(input.password, BCRYPT_ROUNDS);
  await UserModel.create({
    userId,
    tenantId,
    email,
    passwordHash,
    displayName: input.displayName || email.split('@')[0],
    role: 'owner' as UserRole,
  });

  log.info({ tenantId, userId, email }, 'user signup');

  // Activation funnel + lifecycle welcome email: a fresh tenant = the first
  // milestone. Fire-and-forget + idempotent (ADR-014 posture) — never block
  // signup on the meter or the email. Only the default fresh-tenant path
  // stamps 'signup'; invite joins reuse an existing (already-activated)
  // tenant, so they are not new funnel entries or welcome-email sends.
  void notifyLifecycleMilestone(tenantId, 'signup', { tenantName, source: 'signup' });

  const sid = await recordSession({ userId, tenantId, role: 'owner', userAgent: device.userAgent, ip: device.ip });
  const token = signJwt({ sub: userId, tid: tenantId, email, role: 'owner', sid });
  return { token, apiKey: rawKey, tenantId, userId, tenantName, plan: 'free', role: 'owner' };
}

// ── Login ──

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  // Discriminant against MfaRequiredResult below — always absent/false here.
  mfaRequired?: false;
  token: string;
  tenantId: string;
  userId: string;
  displayName?: string;
  role: UserRole;
  // Per-tenant require2fa policy (core/totp.ts) but this account hasn't
  // enrolled yet — a full session IS issued (there's no secret to challenge
  // against), but the dashboard must force the user to /totp/enroll before
  // letting them past the wall.
  totpEnrollmentRequired?: boolean;
}

/** Returned instead of LoginResult when the account has TOTP enabled — the
 *  caller must complete /api/auth/totp/verify with `pendingToken` + a code
 *  before a real session is issued. No cookie is set for this response. */
export interface MfaRequiredResult {
  mfaRequired: true;
  pendingToken: string;
}

export async function login(input: LoginInput, device: DeviceInfo = {}): Promise<LoginResult | MfaRequiredResult> {
  const email = input.email.toLowerCase().trim();
  if (!email || !input.password) {
    throw new AuthError('email and password required', 400, 'BAD_REQUEST');
  }

  const user = await UserModel.findOne({ email })
    .select('+passwordHash')
    .lean<IUser>();

  if (!user) {
    // Constant-time: always hash even if user doesn't exist
    await bcryptHash(input.password, BCRYPT_ROUNDS);
    throw new AuthError('invalid credentials');
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw new AuthError(
      'account locked after too many failed login attempts — check your email for an unlock link',
      423,
      'ACCOUNT_LOCKED',
    );
  }

  const valid = await bcryptCompare(input.password, user.passwordHash);
  if (!valid) {
    const attempts = (user.failedLoginAttempts ?? 0) + 1;
    if (attempts >= LOCKOUT_THRESHOLD) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60_000);
      await UserModel.updateOne(
        { userId: user.userId },
        { $set: { failedLoginAttempts: 0, lockedUntil } },
      );
      // Fire the self-serve unlock email immediately — don't make the user
      // wait out LOCKOUT_DURATION_MINUTES or file a support ticket.
      await sendAccountLockedEmail({ userId: user.userId, tenantId: user.tenantId, email: user.email });
      throw new AuthError(
        'account locked after too many failed login attempts — check your email for an unlock link',
        423,
        'ACCOUNT_LOCKED',
      );
    }
    await UserModel.updateOne({ userId: user.userId }, { $set: { failedLoginAttempts: attempts } });
    throw new AuthError('invalid credentials');
  }

  await UserModel.updateOne(
    { userId: user.userId },
    { $set: { lastLoginAt: new Date(), failedLoginAttempts: 0 } },
  );

  // TOTP MFA (core/totp-mfa.ts): a password match alone isn't a session yet —
  // hand back a short-lived pending token and make the caller complete
  // /api/auth/totp/verify with a code before minting the real JWT.
  if (user.totpEnabled) {
    log.info({ tenantId: user.tenantId, userId: user.userId }, 'password verified — awaiting TOTP code');
    return { mfaRequired: true, pendingToken: issueMfaPendingToken({ userId: user.userId, tenantId: user.tenantId }) };
  }

  log.info({ tenantId: user.tenantId, userId: user.userId }, 'user login');

  const sid = await recordSession({ userId: user.userId, tenantId: user.tenantId, role: user.role, userAgent: device.userAgent, ip: device.ip });
  const token = signJwt({
    sub: user.userId,
    tid: user.tenantId,
    email: user.email,
    role: user.role,
    sid,
  });

  const tenant = await TenantModel.findOne({ tenantId: user.tenantId }).select('require2fa').lean();

  return {
    token,
    tenantId: user.tenantId,
    userId: user.userId,
    displayName: user.displayName,
    role: user.role,
    totpEnrollmentRequired: !!tenant?.require2fa,
  };
}

// ── Get current user (from JWT) ──

export async function getCurrentUser(payload: JwtPayload): Promise<{
  userId: string;
  tenantId: string;
  email: string;
  displayName?: string;
  role: UserRole;
  tenantName?: string;
}> {
  const user = await UserModel.findOne({ userId: payload.sub }).lean<IUser>();
  if (!user) throw new AuthError('user not found', 404, 'NOT_FOUND');

  const tenant = await TenantModel.findOne({ tenantId: user.tenantId }).lean();
  return {
    userId: user.userId,
    tenantId: user.tenantId,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    tenantName: tenant?.name,
  };
}

// ── Bootstrap admin (anti-lockout) ──
//
// So the operator is NEVER locked out of a hosted/login-walled deployment when
// they don't already have an account: when ADMIN_EMAIL + ADMIN_PASSWORD are set,
// seed (or re-sync) an `owner` user on the DEFAULT tenant on every boot. The
// .env is the single source of truth — the password ALWAYS matches ADMIN_PASSWORD,
// so reading it back (`grep ADMIN_PASSWORD .env`) is enough to log in. Unset →
// no-op (local dev relies on loopback trust instead). Idempotent: never creates
// duplicates; only ever updates the password hash to match the env.
export async function ensureBootstrapAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return; // not configured — skip silently
  if (password.length < 8) {
    log.warn('ADMIN_PASSWORD is shorter than 8 chars — skipping bootstrap admin seed');
    return;
  }

  const passwordHash = await bcryptHash(password, BCRYPT_ROUNDS);
  const existing = await UserModel.findOne({ email }).lean<IUser>();
  if (existing) {
    // Keep the password in sync with .env (the source of truth) so a forgotten
    // password is recoverable just by reading ADMIN_PASSWORD — never locked out.
    await UserModel.updateOne({ userId: existing.userId }, { $set: { passwordHash } });
    log.info({ email, tenantId: existing.tenantId }, 'bootstrap admin password synced from ADMIN_PASSWORD');
    return;
  }

  const userId = `u_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await UserModel.create({
    userId,
    tenantId: DEFAULT_TENANT_ID,
    email,
    passwordHash,
    displayName: email.split('@')[0],
    role: 'owner' as UserRole,
  });
  log.warn(
    { email, tenantId: DEFAULT_TENANT_ID },
    'bootstrap admin SEEDED from ADMIN_EMAIL/ADMIN_PASSWORD — sign in with these to reach the default tenant',
  );
}

export { JWT_EXPIRES_SECONDS };
