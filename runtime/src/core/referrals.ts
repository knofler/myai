/**
 * Referral program (GROWTH): each tenant gets a tracked invite link. A
 * successful signup through that link — a brand-new tenant, never an invite
 * join into an existing one (invites.ts) — grants a one-time credit-balance
 * bump to BOTH the referrer and the referee. Builds on the existing
 * credit-grant rail (`Tenant.creditBalance`, shared with core/gift-codes.ts)
 * and the shipped viral share/proof-card surface (dashboard/src/lib/proof-card.ts)
 * for the shareable link itself.
 *
 * Env-gated: `REFERRAL_PROGRAM_ENABLED` must be `true` for signup to apply a
 * referral grant. Code lookup/link generation is unaffected by the gate (so
 * disabling mid-launch never breaks an already-shared link's landing page) —
 * only the credit grant is skipped when the flag is off.
 */
import crypto from 'node:crypto';
import {
  ReferralCodeModel,
  ReferralSignupModel,
  TenantModel,
  type IReferralCode,
} from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { recordAuditEvent } from './audit-log.js';

const log = createChildLogger({ module: 'referrals' });

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O 1/I/L
const CODE_LENGTH = 8;

function generateCode(): string {
  return Array.from(crypto.randomBytes(CODE_LENGTH), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** Master on/off switch — the credit grant only fires while this is true. */
export function isReferralProgramEnabled(): boolean {
  return process.env.REFERRAL_PROGRAM_ENABLED === 'true';
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Credits granted to the referrer when their link converts a new signup. */
export function referrerCreditAmount(): number {
  return numEnv('REFERRAL_CREDITS_REFERRER', 60);
}

/** Credits granted to the brand-new referee tenant that signed up via the link. */
export function refereeCreditAmount(): number {
  return numEnv('REFERRAL_CREDITS_REFEREE', 30);
}

/** MongoDB duplicate-key error — the unique-index race loser (same helper
 *  shape as gift-codes.ts / runner-lease-store / tenant-api-keys). */
function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

// ── Code lookup / creation ───────────────────────────────────────────────

export interface ReferralLinkView {
  code: string;
  createdAt?: Date;
}

/** Every tenant's referral code is created lazily on first request (rather
 *  than at provisioning time) so the program can be toggled on for existing
 *  tenants without a backfill migration. Idempotent under a concurrent race:
 *  the {@link ReferralCodeModel} `tenantId` unique index is the guard — a
 *  duplicate-key loser simply re-reads the winner's row. */
export async function getOrCreateReferralCode(tenantId: string): Promise<ReferralLinkView> {
  const existing = await ReferralCodeModel.findOne({ tenantId }).lean<IReferralCode>();
  if (existing) return { code: existing.code, createdAt: existing.createdAt };

  let code = generateCode();
  for (let i = 0; i < 5 && (await ReferralCodeModel.findOne({ code }).lean()); i++) code = generateCode();

  try {
    const doc = await ReferralCodeModel.create({
      referralCodeId: `refc_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      tenantId,
      code,
    });
    return { code: doc.code, createdAt: doc.createdAt };
  } catch (err) {
    if (isDuplicateKey(err)) {
      // Lost the create race (another request for the same tenant won first,
      // or a code collision) — the winning row is now readable.
      const winner = await ReferralCodeModel.findOne({ tenantId }).lean<IReferralCode>();
      if (winner) return { code: winner.code, createdAt: winner.createdAt };
    }
    throw err;
  }
}

/** Resolve a shared referral code back to its referring tenant, without
 *  mutating anything — used both to validate a `?ref=` link at signup time
 *  and to preview it before submitting the signup form. */
export async function resolveReferralCode(rawCode: string): Promise<{ tenantId: string } | null> {
  const code = rawCode.trim().toUpperCase();
  if (!code) return null;
  const doc = await ReferralCodeModel.findOne({ code }).lean<IReferralCode>();
  return doc ? { tenantId: doc.tenantId } : null;
}

// ── Stats (for the referrer's own dashboard panel) ──────────────────────

export interface ReferralStats {
  code: string;
  enabled: boolean;
  referralCount: number;
  creditsEarned: number;
}

/** The gateway has no notion of the dashboard's public URL, so it returns the
 *  bare code — the dashboard builds the shareable `/welcome?ref=<code>` link
 *  itself from its own known origin (same split as gift-codes: gateway owns
 *  the code, the UI owns the link chrome). */
export async function getReferralStats(tenantId: string): Promise<ReferralStats> {
  const { code } = await getOrCreateReferralCode(tenantId);
  const signups = await ReferralSignupModel.find({ referrerTenantId: tenantId }).lean();
  const creditsEarned = signups.reduce((sum, s) => sum + (s.referrerCredits as number), 0);
  return {
    code,
    enabled: isReferralProgramEnabled(),
    referralCount: signups.length,
    creditsEarned,
  };
}

// ── Apply on signup (fresh-tenant path only — never for invite joins) ──────

export interface ApplyReferralSignupInput {
  code: string;
  refereeTenantId: string;
}

export interface ApplyReferralSignupResult {
  applied: boolean;
  reason?: string;
  referrerTenantId?: string;
  referrerCredits?: number;
  refereeCredits?: number;
}

/**
 * Grants credits to both sides of a referral once, at the moment the referee
 * tenant is provisioned. Never throws on an invalid/unknown/self-referral
 * code — signup must never fail because of a bad or stale `?ref=` link; the
 * caller (user-auth.ts `signup`) fires this fire-and-forget-safe after the
 * tenant row already exists.
 */
export async function applyReferralSignup(input: ApplyReferralSignupInput): Promise<ApplyReferralSignupResult> {
  if (!isReferralProgramEnabled()) return { applied: false, reason: 'program disabled' };

  const code = input.code.trim().toUpperCase();
  if (!code) return { applied: false, reason: 'no code' };

  const referral = await ReferralCodeModel.findOne({ code }).lean<IReferralCode>();
  if (!referral) return { applied: false, reason: 'unknown code' };
  if (referral.tenantId === input.refereeTenantId) {
    return { applied: false, reason: 'self-referral' };
  }

  const referrerCredits = referrerCreditAmount();
  const refereeCredits = refereeCreditAmount();

  // The unique {refereeTenantId} ledger row IS the dedupe guard — a tenant
  // can be credited as a referee at most once, ever, no matter how many times
  // signup is retried or how many `?ref=` links it carried.
  try {
    await ReferralSignupModel.create({
      referralId: `ref_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      code,
      referrerTenantId: referral.tenantId,
      refereeTenantId: input.refereeTenantId,
      referrerCredits,
      refereeCredits,
    });
  } catch (err) {
    if (isDuplicateKey(err)) return { applied: false, reason: 'already credited' };
    throw err;
  }

  await TenantModel.updateOne(
    { tenantId: referral.tenantId },
    { $inc: { creditBalance: referrerCredits } },
  );
  await TenantModel.updateOne(
    { tenantId: input.refereeTenantId },
    { $inc: { creditBalance: refereeCredits } },
  );

  log.info(
    { referrerTenantId: referral.tenantId, refereeTenantId: input.refereeTenantId, referrerCredits, refereeCredits },
    'referral signup credited',
  );
  recordAuditEvent({
    tenantId: input.refereeTenantId,
    actor: { role: 'system', via: 'system' },
    action: 'referral.signup_credited',
    target: referral.tenantId,
    detail: { code, referrerCredits, refereeCredits },
  });

  return {
    applied: true,
    referrerTenantId: referral.tenantId,
    referrerCredits,
    refereeCredits,
  };
}
