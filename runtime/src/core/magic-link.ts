/**
 * Magic-link (passwordless) email login for the dashboard — a PRIMARY auth
 * path alongside password sign-in, distinct from password-reset.ts (which
 * changes a password) and email-verification. A user requests a one-time
 * signed link; clicking it logs them in directly, no password involved.
 *
 * requestMagicLink() mints a CSPRNG token (sha256 stored, raw token only ever
 * in the login email), short-TTL (default 15 min) and single-use;
 * re-requesting supersedes any prior pending link. The response is identical
 * whether or not the address has an account — no user enumeration.
 *
 * consumeMagicLink() burns the token and mints the SAME session JWT
 * issueSessionToken() gives password login/signup/SSO, so downstream
 * RBAC/scoping is auth-method-agnostic.
 *
 * The link targets the dashboard: `${DASHBOARD_BASE_URL}/login?magic=…`. The
 * base URL is server-configured ONLY — a caller-supplied URL would let an
 * attacker send victims a real token pointing at a phishing host.
 */
import crypto from 'node:crypto';
import { MagicLinkModel, UserModel, type IMagicLink, type IUser, type UserRole } from '../shared/db.js';
import { sendMail } from '../shared/mailer.js';
import { AuthError } from './tenant-context.js';
import { issueSessionToken } from './user-auth.js';
import type { DeviceInfo } from './user-sessions.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'magic-link' });

// Short TTL by design — a passwordless login link is a bearer credential for
// the account; minutes, not hours, bounds the window an intercepted email
// stays exploitable.
const MAGIC_LINK_EXPIRES_MINUTES = Number(process.env.MAGIC_LINK_EXPIRES_MINUTES) || 15;
const DASHBOARD_BASE_URL = (process.env.DASHBOARD_BASE_URL || 'http://localhost:3210').replace(/\/$/, '');

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ── Request ──

/**
 * Always resolves `{ ok: true }` — the caller (and therefore the HTTP client)
 * learns nothing about whether the address exists.
 */
export async function requestMagicLink(rawEmail: string): Promise<{ ok: true }> {
  const email = rawEmail?.toLowerCase().trim();
  if (!email || !email.includes('@')) throw new AuthError('invalid email', 400, 'BAD_REQUEST');

  const user = await UserModel.findOne({ email }).lean<IUser>();
  if (!user) {
    log.info({ email }, 'magic link requested for unknown email — no-op');
    return { ok: true };
  }

  // Re-requesting supersedes the previous pending link (its token dies).
  await MagicLinkModel.updateMany(
    { email, status: 'pending' },
    { $set: { status: 'superseded' } },
  );

  const token = `myai_mlk_${crypto.randomBytes(24).toString('base64url')}`;
  await MagicLinkModel.create({
    magicLinkId: `mlk_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    userId: user.userId,
    tenantId: user.tenantId,
    email,
    tokenHash: sha256Hex(token),
    status: 'pending',
    expiresAt: new Date(Date.now() + MAGIC_LINK_EXPIRES_MINUTES * 60_000),
  });

  const link = `${DASHBOARD_BASE_URL}/login?magic=${encodeURIComponent(token)}`;
  await sendMail({
    to: email,
    subject: 'Your myAI sign-in link',
    text:
      `Someone (hopefully you) asked to sign in to myAI as ${email}.\n\n` +
      `Sign in here (link expires in ${MAGIC_LINK_EXPIRES_MINUTES} minutes and works once):\n\n` +
      `${link}\n\n` +
      `If you didn't ask for this, ignore this email — no one can sign in without clicking it.\n`,
  });

  log.info({ email, userId: user.userId }, 'magic link email sent');
  return { ok: true };
}

// ── Consume ──

export interface MagicLinkLoginResult {
  token: string;
  tenantId: string;
  userId: string;
  displayName?: string;
  role: UserRole;
}

export async function consumeMagicLink(token: string, device: DeviceInfo = {}): Promise<MagicLinkLoginResult> {
  if (!token) throw new AuthError('magic link token required', 400, 'BAD_REQUEST');

  const link = await MagicLinkModel.findOne({ tokenHash: sha256Hex(token) });
  if (!link) throw new AuthError('invalid or expired sign-in link', 400, 'BAD_REQUEST');
  if (link.status !== 'pending') throw new AuthError('this sign-in link has already been used', 400, 'BAD_REQUEST');
  if (link.expiresAt.getTime() < Date.now()) throw new AuthError('this sign-in link has expired', 400, 'BAD_REQUEST');

  const user = await UserModel.findOne({ userId: link.userId }).lean<IUser>();
  if (!user) throw new AuthError('account no longer exists', 400, 'BAD_REQUEST');

  // Burn the token only after we've confirmed the account still exists.
  // Atomic single-use guard: the status:'pending' filter means only ONE of N
  // concurrent consume() calls for the same token flips it. Losers match 0 docs
  // and must be rejected here rather than falling through to mint a second
  // session off an already-burned link.
  const burn = await MagicLinkModel.updateOne(
    { magicLinkId: link.magicLinkId, status: 'pending' },
    { $set: { status: 'used', usedAt: new Date() } },
  );
  if (burn.modifiedCount !== 1) {
    throw new AuthError('this sign-in link has already been used', 400, 'BAD_REQUEST');
  }

  await UserModel.updateOne({ userId: user.userId }, { $set: { lastLoginAt: new Date() } });

  log.info({ tenantId: user.tenantId, userId: user.userId }, 'magic link login completed');

  const sessionToken = await issueSessionToken({
    userId: user.userId,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role,
    userAgent: device.userAgent,
    ip: device.ip,
  });

  return {
    token: sessionToken,
    tenantId: user.tenantId,
    userId: user.userId,
    displayName: user.displayName,
    role: user.role,
  };
}

// ── Lookup (public — powers the dashboard's magic-link landing page) ──

export interface MagicLinkLookup {
  valid: boolean;
  reason?: string;
  email?: string;
  expiresAt?: Date;
}

export async function lookupMagicLink(token: string): Promise<MagicLinkLookup> {
  const link = await MagicLinkModel.findOne({ tokenHash: sha256Hex(token) }).lean<IMagicLink>();
  if (!link) return { valid: false, reason: 'sign-in link not found' };
  if (link.status !== 'pending') return { valid: false, reason: 'sign-in link already used' };
  if (link.expiresAt.getTime() < Date.now()) return { valid: false, reason: 'sign-in link expired' };
  return { valid: true, email: link.email, expiresAt: link.expiresAt };
}
