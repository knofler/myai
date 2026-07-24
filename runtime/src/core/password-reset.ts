/**
 * Password reset via email (Team tier — second M2 gap close).
 *
 * requestPasswordReset() mints a CSPRNG token (sha256 stored, raw token only
 * ever in the reset email), expiring (default 60 min) and single-use;
 * re-requesting supersedes any prior pending reset. The response is identical
 * whether or not the address has an account — no user enumeration.
 *
 * resetPassword() burns the token and sets the new bcrypt hash, then revokes
 * every active UserSession for the account (core/user-sessions.ts) — a leaked
 * password no longer leaves existing sessions live after the owner recovers
 * the account.
 *
 * The reset link targets the dashboard: `${DASHBOARD_BASE_URL}/login?reset=…`.
 * The base URL is server-configured ONLY — a caller-supplied URL would let an
 * attacker send victims a real token pointing at a phishing host.
 */
import crypto from 'node:crypto';
import { PasswordResetModel, UserModel, type IPasswordReset, type IUser } from '../shared/db.js';
import { sendMail } from '../shared/mailer.js';
import { AuthError } from './tenant-context.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from './user-auth.js';
import { revokeAllSessions } from './user-sessions.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'password-reset' });

const RESET_EXPIRES_MINUTES = Number(process.env.RESET_EXPIRES_MINUTES) || 60;
const DASHBOARD_BASE_URL = (process.env.DASHBOARD_BASE_URL || 'http://localhost:3210').replace(/\/$/, '');

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ── Request ──

/**
 * Always resolves `{ ok: true }` — the caller (and therefore the HTTP client)
 * learns nothing about whether the address exists.
 */
export async function requestPasswordReset(rawEmail: string): Promise<{ ok: true }> {
  const email = rawEmail?.toLowerCase().trim();
  if (!email || !email.includes('@')) throw new AuthError('invalid email', 400, 'BAD_REQUEST');

  const user = await UserModel.findOne({ email }).lean<IUser>();
  if (!user) {
    log.info({ email }, 'password reset requested for unknown email — no-op');
    return { ok: true };
  }

  // Re-requesting supersedes the previous pending reset (its token dies).
  await PasswordResetModel.updateMany(
    { email, status: 'pending' },
    { $set: { status: 'superseded' } },
  );

  const token = `myai_rst_${crypto.randomBytes(24).toString('base64url')}`;
  await PasswordResetModel.create({
    resetId: `rst_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    userId: user.userId,
    tenantId: user.tenantId,
    email,
    tokenHash: sha256Hex(token),
    status: 'pending',
    expiresAt: new Date(Date.now() + RESET_EXPIRES_MINUTES * 60_000),
  });

  const link = `${DASHBOARD_BASE_URL}/login?reset=${encodeURIComponent(token)}`;
  await sendMail({
    to: email,
    subject: 'Reset your myAI password',
    text:
      `Someone (hopefully you) asked to reset the myAI password for ${email}.\n\n` +
      `Reset it here (link expires in ${RESET_EXPIRES_MINUTES} minutes and works once):\n\n` +
      `${link}\n\n` +
      `If you didn't ask for this, ignore this email — your password is unchanged.\n`,
  });

  log.info({ email, userId: user.userId }, 'password reset email sent');
  return { ok: true };
}

// ── Confirm ──

export async function resetPassword(token: string, newPassword: string): Promise<{ ok: true; email: string }> {
  if (!token) throw new AuthError('reset token required', 400, 'BAD_REQUEST');
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400, 'BAD_REQUEST');
  }

  const reset = await PasswordResetModel.findOne({ tokenHash: sha256Hex(token) });
  if (!reset) throw new AuthError('invalid or expired reset link', 400, 'BAD_REQUEST');
  if (reset.status !== 'pending') throw new AuthError('this reset link has already been used', 400, 'BAD_REQUEST');
  if (reset.expiresAt.getTime() < Date.now()) throw new AuthError('this reset link has expired', 400, 'BAD_REQUEST');

  const passwordHash = await hashPassword(newPassword);
  const updated = await UserModel.updateOne({ userId: reset.userId }, { $set: { passwordHash } });
  if (!updated.matchedCount) throw new AuthError('account no longer exists', 400, 'BAD_REQUEST');

  // Burn the token only after the password actually changed.
  await PasswordResetModel.updateOne(
    { resetId: reset.resetId, status: 'pending' },
    { $set: { status: 'used', usedAt: new Date() } },
  );

  // A password change invalidates every outstanding session — including
  // whatever device did the resetting; it gets a fresh one on next login.
  const { revokedCount } = await revokeAllSessions(reset.userId);

  log.info({ email: reset.email, userId: reset.userId, revokedCount }, 'password reset completed');
  return { ok: true, email: reset.email };
}

// ── Lookup (public — powers the dashboard's reset form preflight) ──

export interface ResetLookup {
  valid: boolean;
  reason?: string;
  email?: string;
  expiresAt?: Date;
}

export async function lookupPasswordReset(token: string): Promise<ResetLookup> {
  const reset = await PasswordResetModel.findOne({ tokenHash: sha256Hex(token) }).lean<IPasswordReset>();
  if (!reset) return { valid: false, reason: 'reset link not found' };
  if (reset.status !== 'pending') return { valid: false, reason: 'reset link already used' };
  if (reset.expiresAt.getTime() < Date.now()) return { valid: false, reason: 'reset link expired' };
  return { valid: true, email: reset.email, expiresAt: reset.expiresAt };
}
