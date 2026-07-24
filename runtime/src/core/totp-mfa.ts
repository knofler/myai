/**
 * TOTP MFA orchestration — enrolment, login-time verification, disable, and
 * recovery-code regeneration. The crypto primitives (secret/QR/code/recovery
 * code generation + verification) live in core/totp.ts; this module is the
 * Mongo-backed business logic on top, in the same split as
 * account-unlock.ts (crypto+token) vs user-auth.ts (login orchestration).
 */
import { UserModel, TenantModel, type IUser, type UserRole } from '../shared/db.js';
import { AuthError } from './tenant-context.js';
import { createChildLogger } from '../shared/logger.js';
import {
  generateTotpSecret,
  buildOtpauthUri,
  verifyTotpCode,
  generateRecoveryCodes,
  matchRecoveryCode,
  checkTotpVerifyRate,
} from './totp.js';
import { issueSessionToken, verifyMfaPendingToken } from './user-auth.js';
import type { DeviceInfo } from './user-sessions.js';

const log = createChildLogger({ module: 'totp-mfa' });

// ── Enrolment (step 1: generate a pending secret, not yet active) ──

export interface TotpEnrollResult {
  secret: string;
  otpauthUri: string;
}

export async function enrollTotp(userId: string): Promise<TotpEnrollResult> {
  const user = await UserModel.findOne({ userId }).lean<IUser>();
  if (!user) throw new AuthError('user not found', 404, 'NOT_FOUND');
  if (user.totpEnabled) throw new AuthError('TOTP is already enabled — disable it first to re-enroll', 409, 'CONFLICT');

  const secret = generateTotpSecret();
  await UserModel.updateOne({ userId }, { $set: { totpPendingSecret: secret } });

  const tenant = await TenantModel.findOne({ tenantId: user.tenantId }).lean();
  const otpauthUri = buildOtpauthUri({ secret, email: user.email, issuer: tenant?.name ? `myAI (${tenant.name})` : 'myAI' });

  log.info({ userId, tenantId: user.tenantId }, 'TOTP enrollment started');
  return { secret, otpauthUri };
}

// ── Confirm enrolment (step 2: prove possession of the secret) ──

export interface TotpConfirmResult {
  recoveryCodes: string[];
}

export async function confirmTotpEnrollment(userId: string, code: string): Promise<TotpConfirmResult> {
  const user = await UserModel.findOne({ userId }).select('+totpPendingSecret').lean<IUser>();
  if (!user) throw new AuthError('user not found', 404, 'NOT_FOUND');
  if (!user.totpPendingSecret) throw new AuthError('no TOTP enrollment in progress — call enroll first', 400, 'BAD_REQUEST');

  if (!verifyTotpCode(user.totpPendingSecret, code)) {
    throw new AuthError('invalid code — check your authenticator app and try again', 401, 'INVALID_CODE');
  }

  const { raw, hashed } = generateRecoveryCodes();
  await UserModel.updateOne(
    { userId },
    {
      $set: {
        totpSecret: user.totpPendingSecret,
        totpEnabled: true,
        totpVerifiedAt: new Date(),
        totpRecoveryCodes: hashed,
      },
      $unset: { totpPendingSecret: 1 },
    },
  );

  log.info({ userId, tenantId: user.tenantId }, 'TOTP enabled');
  return { recoveryCodes: raw };
}

// ── Login-time verification (the second factor after password) ──

export interface TotpLoginResult {
  token: string;
  tenantId: string;
  userId: string;
  displayName?: string;
  role: UserRole;
  recoveryCodeUsed: boolean;
}

export async function verifyTotpLogin(pendingToken: string, code: string, device: DeviceInfo = {}): Promise<TotpLoginResult> {
  const pending = verifyMfaPendingToken(pendingToken);

  const rate = checkTotpVerifyRate(pending.sub);
  if (!rate.ok) {
    throw new AuthError('too many attempts — please wait and try again', 429, 'RATE_LIMITED');
  }

  const user = await UserModel.findOne({ userId: pending.sub }).select('+totpSecret +totpRecoveryCodes').lean<IUser>();
  if (!user || !user.totpEnabled || !user.totpSecret) {
    throw new AuthError('TOTP is not enabled for this account', 400, 'BAD_REQUEST');
  }

  let recoveryCodeUsed = false;
  if (verifyTotpCode(user.totpSecret, code)) {
    // matched the live code
  } else {
    const idx = matchRecoveryCode(code, user.totpRecoveryCodes || []);
    if (idx === -1) {
      throw new AuthError('invalid code', 401, 'INVALID_CODE');
    }
    recoveryCodeUsed = true;
    const remaining = [...(user.totpRecoveryCodes || [])];
    remaining.splice(idx, 1); // single-use — burn it immediately
    await UserModel.updateOne({ userId: user.userId }, { $set: { totpRecoveryCodes: remaining } });
    log.warn({ userId: user.userId, remaining: remaining.length }, 'TOTP recovery code used at login');
  }

  await UserModel.updateOne(
    { userId: user.userId },
    { $set: { lastLoginAt: new Date(), failedLoginAttempts: 0 } },
  );

  const token = await issueSessionToken({
    userId: user.userId,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role,
    userAgent: device.userAgent,
    ip: device.ip,
  });

  log.info({ userId: user.userId, tenantId: user.tenantId, recoveryCodeUsed }, 'TOTP login completed');
  return {
    token,
    tenantId: user.tenantId,
    userId: user.userId,
    displayName: user.displayName,
    role: user.role,
    recoveryCodeUsed,
  };
}

// ── Disable + recovery-code regeneration (both require a live code — you
// must prove you still hold the factor you're about to remove/rotate) ──

async function requireLiveCode(userId: string, code: string): Promise<IUser> {
  const user = await UserModel.findOne({ userId }).select('+totpSecret').lean<IUser>();
  if (!user) throw new AuthError('user not found', 404, 'NOT_FOUND');
  if (!user.totpEnabled || !user.totpSecret) throw new AuthError('TOTP is not enabled', 400, 'BAD_REQUEST');
  if (!verifyTotpCode(user.totpSecret, code)) throw new AuthError('invalid code', 401, 'INVALID_CODE');
  return user;
}

export async function disableTotp(userId: string, code: string): Promise<{ ok: true }> {
  const user = await requireLiveCode(userId, code);
  await UserModel.updateOne(
    { userId },
    { $set: { totpEnabled: false }, $unset: { totpSecret: 1, totpPendingSecret: 1, totpRecoveryCodes: 1 } },
  );
  log.info({ userId, tenantId: user.tenantId }, 'TOTP disabled');
  return { ok: true };
}

export async function regenerateRecoveryCodes(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  const user = await requireLiveCode(userId, code);
  const { raw, hashed } = generateRecoveryCodes();
  await UserModel.updateOne({ userId }, { $set: { totpRecoveryCodes: hashed } });
  log.info({ userId, tenantId: user.tenantId }, 'TOTP recovery codes regenerated');
  return { recoveryCodes: raw };
}

// ── Status (dashboard settings page) ──

export async function getTotpStatus(userId: string): Promise<{ enabled: boolean; recoveryCodesRemaining: number }> {
  const user = await UserModel.findOne({ userId }).select('+totpRecoveryCodes').lean<IUser>();
  if (!user) throw new AuthError('user not found', 404, 'NOT_FOUND');
  return { enabled: !!user.totpEnabled, recoveryCodesRemaining: user.totpRecoveryCodes?.length || 0 };
}

// ── Per-tenant enforce policy (owner/admin toggle) ──

export async function setTenantRequire2fa(tenantId: string, enabled: boolean): Promise<{ require2fa: boolean }> {
  const updated = await TenantModel.updateOne({ tenantId }, { $set: { require2fa: enabled } });
  if (!updated.matchedCount) throw new AuthError('tenant not found', 404, 'NOT_FOUND');
  return { require2fa: enabled };
}
