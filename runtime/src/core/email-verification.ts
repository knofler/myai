/**
 * Email verification (M2 — confirm the address behind a fresh signup).
 *
 * Distinct from password-reset.ts (user-initiated credential change) and
 * magic-link.ts (passwordless login): user-auth.ts fires
 * sendEmailVerification() immediately after signup() provisions a user (both
 * the fresh-tenant and invite-join paths), so a new account gets a
 * verification email without any extra client call. requestEmailVerification()
 * is the resend path the dashboard's unverified-email banner calls.
 *
 * Same posture as the sibling token flows: CSPRNG token (sha256 stored, raw
 * token only ever in the email), expiring (default 24h) and single-use; a
 * fresh send supersedes any prior pending verification.
 *
 * verifyEmail() burns the token and sets `emailVerified`/`emailVerifiedAt` on
 * the user. It does NOT gate login or dashboard access — an unverified
 * account can use the product; verification is enforced softly via a
 * dismissible-but-persistent banner (accountability without a lockout
 * footgun on day one of a hosted product).
 *
 * The verification link targets the dashboard: `${DASHBOARD_BASE_URL}/login?verify=…`.
 * The base URL is server-configured ONLY — a caller-supplied URL would let an
 * attacker send victims a real token pointing at a phishing host.
 */
import crypto from 'node:crypto';
import { EmailVerificationModel, UserModel, type IEmailVerification, type IUser } from '../shared/db.js';
import { sendTransactionalEmail } from '../notifications/email-service.js';
import { AuthError } from './tenant-context.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'email-verification' });

const VERIFY_EXPIRES_MINUTES = Number(process.env.EMAIL_VERIFY_EXPIRES_MINUTES) || 24 * 60;
const DASHBOARD_BASE_URL = (process.env.DASHBOARD_BASE_URL || 'http://localhost:3210').replace(/\/$/, '');

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

async function mintAndSendVerificationToken(user: Pick<IUser, 'userId' | 'tenantId' | 'email'>): Promise<void> {
  // A resend (or a re-signup racing an in-flight token) supersedes the
  // previous pending verification — its token dies.
  await EmailVerificationModel.updateMany(
    { email: user.email, status: 'pending' },
    { $set: { status: 'superseded' } },
  );

  const token = `myai_vfy_${crypto.randomBytes(24).toString('base64url')}`;
  await EmailVerificationModel.create({
    verificationId: `vfy_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    userId: user.userId,
    tenantId: user.tenantId,
    email: user.email,
    tokenHash: sha256Hex(token),
    status: 'pending',
    expiresAt: new Date(Date.now() + VERIFY_EXPIRES_MINUTES * 60_000),
  });

  const link = `${DASHBOARD_BASE_URL}/login?verify=${encodeURIComponent(token)}`;
  const send = await sendTransactionalEmail({
    to: user.email,
    template: 'verification',
    tenantId: user.tenantId,
    data: { email: user.email, link, expiresMinutes: VERIFY_EXPIRES_MINUTES },
  });

  log.info({ email: user.email, userId: user.userId, status: send.status }, 'email verification sent');
}

/** Called by user-auth.ts right after a new user is created (signup, both paths). */
export async function sendEmailVerification(user: Pick<IUser, 'userId' | 'tenantId' | 'email'>): Promise<void> {
  await mintAndSendVerificationToken(user);
}

// ── Resend (self-serve — dashboard "resend verification" banner) ──

/**
 * Always resolves `{ ok: true }` — the caller (and therefore the HTTP client)
 * learns nothing about whether the address has an account. A no-op if the
 * account is already verified.
 */
export async function requestEmailVerification(rawEmail: string): Promise<{ ok: true }> {
  const email = rawEmail?.toLowerCase().trim();
  if (!email || !email.includes('@')) throw new AuthError('invalid email', 400, 'BAD_REQUEST');

  const user = await UserModel.findOne({ email }).lean<IUser>();
  if (!user || user.emailVerified) {
    log.info({ email }, 'email verification requested for unknown/verified email — no-op');
    return { ok: true };
  }

  await mintAndSendVerificationToken(user);
  return { ok: true };
}

// ── Consume ──

export async function verifyEmail(token: string): Promise<{ ok: true; email: string }> {
  if (!token) throw new AuthError('verification token required', 400, 'BAD_REQUEST');

  const verification = await EmailVerificationModel.findOne({ tokenHash: sha256Hex(token) });
  if (!verification) throw new AuthError('invalid or expired verification link', 400, 'BAD_REQUEST');
  if (verification.status !== 'pending') {
    throw new AuthError('this verification link has already been used', 400, 'BAD_REQUEST');
  }
  if (verification.expiresAt.getTime() < Date.now()) {
    throw new AuthError('this verification link has expired', 400, 'BAD_REQUEST');
  }

  const updated = await UserModel.updateOne(
    { userId: verification.userId },
    { $set: { emailVerified: true, emailVerifiedAt: new Date() } },
  );
  if (!updated.matchedCount) throw new AuthError('account no longer exists', 400, 'BAD_REQUEST');

  // Burn the token only after the account is actually marked verified.
  await EmailVerificationModel.updateOne(
    { verificationId: verification.verificationId, status: 'pending' },
    { $set: { status: 'used', usedAt: new Date() } },
  );

  log.info({ email: verification.email, userId: verification.userId }, 'email verification completed');
  return { ok: true, email: verification.email };
}

// ── Lookup (public — powers a preflight before a "verifying…" UI state) ────

export interface EmailVerificationLookup {
  valid: boolean;
  reason?: string;
  email?: string;
  expiresAt?: Date;
}

export async function lookupEmailVerification(token: string): Promise<EmailVerificationLookup> {
  const verification = await EmailVerificationModel.findOne({ tokenHash: sha256Hex(token) }).lean<IEmailVerification>();
  if (!verification) return { valid: false, reason: 'verification link not found' };
  if (verification.status !== 'pending') return { valid: false, reason: 'verification link already used' };
  if (verification.expiresAt.getTime() < Date.now()) return { valid: false, reason: 'verification link expired' };
  return { valid: true, email: verification.email, expiresAt: verification.expiresAt };
}
