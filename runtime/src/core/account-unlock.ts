/**
 * Account auto-unlock via email — the AUTOMATIC post-lockout recovery path.
 *
 * Distinct from password-reset.ts (user-initiated credential change) and
 * magic-link.ts (passwordless login): user-auth.ts fires sendAccountLockedEmail()
 * the instant a login attempt trips the failed-attempt lockout threshold, so
 * the account owner can self-serve recover instead of waiting out the lockout
 * window or filing a support ticket.
 *
 * Same posture as password-reset/magic-link: CSPRNG token (sha256 stored, raw
 * token only ever in the email), short-TTL and single-use; a fresh lockout
 * supersedes any prior pending unlock for the address.
 *
 * consumeAccountUnlock() only clears the lock (failedLoginAttempts reset,
 * lockedUntil cleared) — it does NOT log the user in. They authenticate with
 * their existing password afterward, same as any other login.
 *
 * requestAccountUnlock() is the resend path (unlock email didn't arrive or
 * expired before the user got to it) — same no-enumeration shape as the other
 * two flows: always resolves { ok: true }, and is a no-op unless the account
 * is actually currently locked.
 *
 * The unlock link targets the dashboard: `${DASHBOARD_BASE_URL}/login?unlock=…`.
 * The base URL is server-configured ONLY — a caller-supplied URL would let an
 * attacker send victims a real token pointing at a phishing host.
 */
import crypto from 'node:crypto';
import { AccountUnlockModel, UserModel, type IAccountUnlock, type IUser } from '../shared/db.js';
import { sendMail } from '../shared/mailer.js';
import { AuthError } from './tenant-context.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'account-unlock' });

const UNLOCK_EXPIRES_MINUTES = Number(process.env.ACCOUNT_UNLOCK_EXPIRES_MINUTES) || 30;
const DASHBOARD_BASE_URL = (process.env.DASHBOARD_BASE_URL || 'http://localhost:3210').replace(/\/$/, '');

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

async function mintAndSendUnlockToken(user: Pick<IUser, 'userId' | 'tenantId' | 'email'>): Promise<void> {
  // Re-locking (or a resend) supersedes the previous pending unlock — its token dies.
  await AccountUnlockModel.updateMany(
    { email: user.email, status: 'pending' },
    { $set: { status: 'superseded' } },
  );

  const token = `myai_unl_${crypto.randomBytes(24).toString('base64url')}`;
  await AccountUnlockModel.create({
    unlockId: `unl_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    userId: user.userId,
    tenantId: user.tenantId,
    email: user.email,
    tokenHash: sha256Hex(token),
    status: 'pending',
    expiresAt: new Date(Date.now() + UNLOCK_EXPIRES_MINUTES * 60_000),
  });

  const link = `${DASHBOARD_BASE_URL}/login?unlock=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    subject: 'Unlock your myAI account',
    text:
      `Your myAI account (${user.email}) was locked after too many failed sign-in attempts.\n\n` +
      `Unlock it now instead of waiting out the lockout (link expires in ${UNLOCK_EXPIRES_MINUTES} minutes and works once):\n\n` +
      `${link}\n\n` +
      `If this wasn't you, someone may be guessing your password — consider changing it once you're back in.\n`,
  });

  log.warn({ email: user.email, userId: user.userId }, 'account locked — unlock email sent');
}

/** Called by user-auth.ts the instant a login attempt trips the lockout threshold. */
export async function sendAccountLockedEmail(user: Pick<IUser, 'userId' | 'tenantId' | 'email'>): Promise<void> {
  await mintAndSendUnlockToken(user);
}

// ── Resend (self-serve — unlock email didn't arrive or expired) ──

/**
 * Always resolves `{ ok: true }` — the caller (and therefore the HTTP client)
 * learns nothing about whether the address exists or is locked.
 */
export async function requestAccountUnlock(rawEmail: string): Promise<{ ok: true }> {
  const email = rawEmail?.toLowerCase().trim();
  if (!email || !email.includes('@')) throw new AuthError('invalid email', 400, 'BAD_REQUEST');

  const user = await UserModel.findOne({ email }).lean<IUser>();
  if (!user || !user.lockedUntil || user.lockedUntil.getTime() < Date.now()) {
    // No account, or not currently locked — nothing to unlock.
    log.info({ email }, 'account unlock requested for unknown/unlocked email — no-op');
    return { ok: true };
  }

  await mintAndSendUnlockToken(user);
  return { ok: true };
}

// ── Consume ──

export async function consumeAccountUnlock(token: string): Promise<{ ok: true; email: string }> {
  if (!token) throw new AuthError('unlock token required', 400, 'BAD_REQUEST');

  const unlock = await AccountUnlockModel.findOne({ tokenHash: sha256Hex(token) });
  if (!unlock) throw new AuthError('invalid or expired unlock link', 400, 'BAD_REQUEST');
  if (unlock.status !== 'pending') throw new AuthError('this unlock link has already been used', 400, 'BAD_REQUEST');
  if (unlock.expiresAt.getTime() < Date.now()) throw new AuthError('this unlock link has expired', 400, 'BAD_REQUEST');

  const updated = await UserModel.updateOne(
    { userId: unlock.userId },
    { $set: { failedLoginAttempts: 0, lockedUntil: null } },
  );
  if (!updated.matchedCount) throw new AuthError('account no longer exists', 400, 'BAD_REQUEST');

  // Burn the token only after the account is actually unlocked.
  await AccountUnlockModel.updateOne(
    { unlockId: unlock.unlockId, status: 'pending' },
    { $set: { status: 'used', usedAt: new Date() } },
  );

  log.info({ email: unlock.email, userId: unlock.userId }, 'account unlock completed');
  return { ok: true, email: unlock.email };
}

// ── Lookup (public — powers the dashboard's unlock landing page) ──

export interface AccountUnlockLookup {
  valid: boolean;
  reason?: string;
  email?: string;
  expiresAt?: Date;
}

export async function lookupAccountUnlock(token: string): Promise<AccountUnlockLookup> {
  const unlock = await AccountUnlockModel.findOne({ tokenHash: sha256Hex(token) }).lean<IAccountUnlock>();
  if (!unlock) return { valid: false, reason: 'unlock link not found' };
  if (unlock.status !== 'pending') return { valid: false, reason: 'unlock link already used' };
  if (unlock.expiresAt.getTime() < Date.now()) return { valid: false, reason: 'unlock link expired' };
  return { valid: true, email: unlock.email, expiresAt: unlock.expiresAt };
}
