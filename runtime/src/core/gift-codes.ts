/**
 * Gift / redeemable subscription-code system (GROWTH).
 *
 * An operator mints a code that grants a plan tier for N months or a pool of
 * credits; a tenant redeems it once to apply the grant. Distinct from a Stripe
 * checkout coupon (percent off a purchase — billing.ts / dashboard checkout)
 * and a tenant invite (joins an existing tenant — invites.ts): this is a
 * standalone comp/promo grant used for promos, partnerships, and the
 * design-partner program, redeemed independently of any purchase.
 *
 * A code is a human-typed, shareable string (like a coupon code) — stored in
 * the clear (uppercased), unlike invite/reset tokens. Minting requires an
 * authenticated operator (owner/admin, or the `system`/`operator` principal for
 * scripted/ops mints); redeeming requires an owner/admin of the redeeming
 * tenant, since it mutates that tenant's billing state.
 */
import crypto from 'node:crypto';
import {
  GiftCodeModel,
  GiftRedemptionModel,
  TenantModel,
  DEFAULT_TENANT_ID,
  type IGiftCode,
  type GiftCodeGrantType,
  type GiftCodeStatus,
  type TenantPlan,
} from '../shared/db.js';
import type { CtxRole } from './tenant-context.js';
import { AuthError } from './tenant-context.js';
import { PAID_PLANS, planRank } from './billing.js';
import { createChildLogger } from '../shared/logger.js';
import { recordAuditEvent } from './audit-log.js';

const log = createChildLogger({ module: 'gift-codes' });

const MAX_EXPIRES_DAYS = 3650; // 10 years — sanity ceiling, not a real limit
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O 1/I/L

function randomSegment(len: number): string {
  return Array.from(crypto.randomBytes(len), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function generateCode(): string {
  return `MYAI-${randomSegment(4)}-${randomSegment(4)}`;
}

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

const MINT_ROLES: ReadonlySet<CtxRole> = new Set(['owner', 'admin', 'system', 'operator']);
const REDEEM_ROLES: ReadonlySet<CtxRole> = new Set(['owner', 'admin']);

/** MongoDB duplicate-key error — the unique-index race loser (same helper shape
 *  as runner-lease-store / tenant-api-keys). */
function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

// ── Views ──────────────────────────────────────────────────────────────

export interface GiftCodeView {
  codeId: string;
  code: string;
  grantType: GiftCodeGrantType;
  grantPlan?: TenantPlan;
  grantMonths?: number;
  grantCredits?: number;
  maxRedemptions: number;
  redemptionCount: number;
  status: GiftCodeStatus;
  note?: string;
  createdBy: string;
  expiresAt?: Date;
  createdAt?: Date;
}

function toView(doc: IGiftCode): GiftCodeView {
  return {
    codeId: doc.codeId,
    code: doc.code,
    grantType: doc.grantType,
    grantPlan: doc.grantPlan,
    grantMonths: doc.grantMonths,
    grantCredits: doc.grantCredits,
    maxRedemptions: doc.maxRedemptions,
    redemptionCount: doc.redemptionCount,
    status: doc.status,
    note: doc.note,
    createdBy: doc.createdBy,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
  };
}

// ── Mint (operator action) ──────────────────────────────────────────────

export interface MintGiftCodeInput {
  createdBy: string;        // operator identity (userId, or a script/ops label)
  actorRole: CtxRole;
  grantType: GiftCodeGrantType;
  grantPlan?: TenantPlan;   // required for grantType 'plan_months' — solo/team/scale only
  grantMonths?: number;     // required for grantType 'plan_months'
  grantCredits?: number;    // required for grantType 'credits'
  maxRedemptions?: number;  // default 1 — set higher for a shared partnership code
  expiresInDays?: number;   // omit for a code that never expires
  note?: string;
  /** Operator-supplied memorable code (e.g. "DESIGNPARTNER2026"). Normalized to
   *  uppercase. Omit to get a random `MYAI-XXXX-XXXX` code. */
  code?: string;
}

export async function mintGiftCode(input: MintGiftCodeInput): Promise<GiftCodeView> {
  if (!MINT_ROLES.has(input.actorRole)) {
    throw new AuthError('only an owner, admin, or operator can mint a gift code', 403, 'FORBIDDEN');
  }
  if (!input.createdBy) throw new AuthError('createdBy is required', 400, 'BAD_REQUEST');

  if (input.grantType === 'plan_months') {
    if (!input.grantPlan || !(PAID_PLANS as readonly string[]).includes(input.grantPlan)) {
      throw new AuthError('grantPlan must be one of: solo, team, scale', 400, 'BAD_REQUEST');
    }
    if (!Number.isFinite(input.grantMonths) || (input.grantMonths as number) <= 0) {
      throw new AuthError('grantMonths must be a positive number', 400, 'BAD_REQUEST');
    }
  } else if (input.grantType === 'credits') {
    if (!Number.isFinite(input.grantCredits) || (input.grantCredits as number) <= 0) {
      throw new AuthError('grantCredits must be a positive number', 400, 'BAD_REQUEST');
    }
  } else {
    throw new AuthError('grantType must be one of: plan_months, credits', 400, 'BAD_REQUEST');
  }

  const maxRedemptions = input.maxRedemptions && input.maxRedemptions > 0
    ? Math.floor(input.maxRedemptions)
    : 1;
  const expiresAt = input.expiresInDays && input.expiresInDays > 0
    ? new Date(Date.now() + Math.min(input.expiresInDays, MAX_EXPIRES_DAYS) * 86_400_000)
    : undefined;

  let code: string;
  if (input.code) {
    code = normalizeCode(input.code);
    if (await GiftCodeModel.findOne({ code }).lean()) {
      throw new AuthError('that code already exists', 409, 'CONFLICT');
    }
  } else {
    code = generateCode();
    // Astronomically rare collision on the random alphabet — a short retry loop
    // is cheaper than a unique-index catch/retry and keeps this function pure.
    for (let i = 0; i < 5 && (await GiftCodeModel.findOne({ code }).lean()); i++) code = generateCode();
  }

  const doc = await GiftCodeModel.create({
    codeId: `gift_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    code,
    grantType: input.grantType,
    grantPlan: input.grantType === 'plan_months' ? input.grantPlan : undefined,
    grantMonths: input.grantType === 'plan_months' ? Math.floor(input.grantMonths as number) : undefined,
    grantCredits: input.grantType === 'credits' ? Math.floor(input.grantCredits as number) : undefined,
    maxRedemptions,
    redemptionCount: 0,
    status: 'active',
    note: input.note,
    createdBy: input.createdBy,
    expiresAt,
  });

  log.info({ codeId: doc.codeId, grantType: input.grantType, maxRedemptions }, 'gift code minted');
  recordAuditEvent({
    tenantId: DEFAULT_TENANT_ID, // platform-level mint — not scoped to a redeeming tenant
    actor: { userId: input.createdBy, role: input.actorRole, via: input.actorRole === 'operator' ? 'operator' : 'jwt' },
    action: 'giftcode.mint',
    target: code,
    detail: { grantType: input.grantType, grantPlan: input.grantPlan, grantMonths: input.grantMonths, grantCredits: input.grantCredits, maxRedemptions },
  });
  return toView(doc as IGiftCode);
}

// ── Preview (non-mutating — powers a "what does this code grant?" UI check) ──

export interface GiftCodePreview {
  valid: boolean;
  reason?: string;
  grantType?: GiftCodeGrantType;
  grantPlan?: TenantPlan;
  grantMonths?: number;
  grantCredits?: number;
}

export async function previewGiftCode(rawCode: string): Promise<GiftCodePreview> {
  const doc = await GiftCodeModel.findOne({ code: normalizeCode(rawCode) }).lean<IGiftCode>();
  if (!doc) return { valid: false, reason: 'code not found' };
  const reason = invalidReason(doc);
  if (reason) return { valid: false, reason };
  return {
    valid: true,
    grantType: doc.grantType,
    grantPlan: doc.grantPlan,
    grantMonths: doc.grantMonths,
    grantCredits: doc.grantCredits,
  };
}

/** Null when the code is currently redeemable; otherwise the reason it isn't. */
function invalidReason(doc: Pick<IGiftCode, 'status' | 'expiresAt' | 'redemptionCount' | 'maxRedemptions'>): string | null {
  if (doc.status === 'disabled') return 'this code has been disabled';
  if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) return 'this code has expired';
  if (doc.status === 'expired') return 'this code has expired';
  if (doc.redemptionCount >= doc.maxRedemptions || doc.status === 'exhausted') {
    return 'this code has already been fully redeemed';
  }
  return null;
}

// ── Redeem (tenant owner/admin action) ──────────────────────────────────

export interface RedeemGiftCodeInput {
  code: string;
  tenantId: string;
  actorRole: CtxRole;
  redeemedBy?: string; // userId, when known
}

export interface RedeemGiftCodeResult {
  grantType: GiftCodeGrantType;
  grantPlan?: TenantPlan;
  grantMonths?: number;
  grantCredits?: number;
  /** The tenant's resulting plan/period-end (plan_months grants only). */
  plan?: TenantPlan;
  currentPeriodEnd?: Date;
  /** The tenant's resulting credit balance (credits grants only). */
  creditBalance?: number;
}

export async function redeemGiftCode(input: RedeemGiftCodeInput): Promise<RedeemGiftCodeResult> {
  if (!REDEEM_ROLES.has(input.actorRole)) {
    throw new AuthError('only an owner or admin can redeem a gift code', 403, 'FORBIDDEN');
  }

  const code = normalizeCode(input.code);
  const giftCode = await GiftCodeModel.findOne({ code });
  if (!giftCode) throw new AuthError('invalid code', 400, 'BAD_REQUEST');

  // Expiry is lazily latched to the persisted status so a stale 'active' row
  // never re-passes this check after its expiresAt has passed.
  if (giftCode.status === 'active' && giftCode.expiresAt && giftCode.expiresAt.getTime() < Date.now()) {
    giftCode.status = 'expired';
    await giftCode.save();
  }
  const reason = invalidReason(giftCode);
  if (reason) throw new AuthError(reason, 400, 'BAD_REQUEST');

  const tenant = await TenantModel.findOne({ tenantId: input.tenantId });
  if (!tenant) throw new AuthError('tenant not found', 404, 'NOT_FOUND');

  // ── Reserve BEFORE granting (concurrency-safe) ──────────────────────────
  // The grant was previously applied and persisted first, with the dedupe
  // ledger row and the maxRedemptions bump written only afterwards. That left
  // two non-atomic windows: the same tenant double-submitting both passed a
  // check-then-act "already redeemed?" read and got the grant twice, and N
  // tenants racing a maxRedemptions=1 code all passed a non-atomic count gate.
  // Both durable guards now happen up front; the grant is applied only after
  // both succeed, so a race can never reach a double grant.

  // 1. Per-tenant dedupe: the unique {codeId, tenantId} ledger row IS the gate.
  //    Insert it first — a duplicate-key error means this tenant already
  //    redeemed, so we grant nothing.
  try {
    await GiftRedemptionModel.create({
      redemptionId: `gred_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      codeId: giftCode.codeId,
      code: giftCode.code,
      tenantId: input.tenantId,
      grantType: giftCode.grantType,
      grantPlan: giftCode.grantPlan,
      grantMonths: giftCode.grantMonths,
      grantCredits: giftCode.grantCredits,
      redeemedBy: input.redeemedBy,
      redeemedAt: new Date(),
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      throw new AuthError('this tenant has already redeemed this code', 409, 'CONFLICT');
    }
    throw err;
  }

  // 2. maxRedemptions: atomically claim a slot — increment redemptionCount only
  //    while the code is still active and under its cap. Concurrent redemptions
  //    of a limited code can't all pass this ($inc under a guarded filter is a
  //    single atomic op), unlike the prior read-then-save count bump.
  const reserved = await GiftCodeModel.findOneAndUpdate(
    {
      codeId: giftCode.codeId,
      status: 'active',
      $expr: { $lt: ['$redemptionCount', '$maxRedemptions'] },
    },
    { $inc: { redemptionCount: 1 } },
    { new: true },
  );
  if (!reserved) {
    // Lost the slot to a concurrent redemption after our pre-check — undo the
    // ledger reservation so this tenant isn't falsely recorded, then reject.
    await GiftRedemptionModel.deleteOne({ codeId: giftCode.codeId, tenantId: input.tenantId });
    throw new AuthError('this code has already been fully redeemed', 400, 'BAD_REQUEST');
  }
  if (reserved.status === 'active' && reserved.redemptionCount >= reserved.maxRedemptions) {
    reserved.status = 'exhausted';
    await reserved.save();
  }

  // 3. Both durable guards held — apply and persist the grant. A failure here
  //    leaves a reserved-but-ungranted state (recoverable), never a double grant.
  const result: RedeemGiftCodeResult = { grantType: giftCode.grantType };

  if (giftCode.grantType === 'plan_months') {
    const grantPlan = giftCode.grantPlan as TenantPlan;
    const grantMonths = giftCode.grantMonths as number;

    // Extend from the tenant's current paid-through date if it's still in the
    // future (stacks with an active subscription/prior grant); otherwise from
    // now. Never downgrade a tenant already on an equal-or-higher tier.
    const base = tenant.currentPeriodEnd && tenant.currentPeriodEnd.getTime() > Date.now()
      ? tenant.currentPeriodEnd
      : new Date();
    const extended = new Date(base);
    extended.setMonth(extended.getMonth() + grantMonths);

    if (planRank(grantPlan) >= planRank(tenant.plan)) {
      tenant.plan = grantPlan;
    }
    tenant.currentPeriodEnd = extended;
    tenant.subscriptionStatus = 'active';
    await tenant.save();

    result.grantPlan = grantPlan;
    result.grantMonths = grantMonths;
    result.plan = tenant.plan;
    result.currentPeriodEnd = tenant.currentPeriodEnd;
  } else {
    const grantCredits = giftCode.grantCredits as number;
    tenant.creditBalance = (tenant.creditBalance ?? 0) + grantCredits;
    await tenant.save();

    result.grantCredits = grantCredits;
    result.creditBalance = tenant.creditBalance;
  }

  log.info({ tenantId: input.tenantId, codeId: giftCode.codeId, grantType: giftCode.grantType }, 'gift code redeemed');
  recordAuditEvent({
    tenantId: input.tenantId,
    actor: { userId: input.redeemedBy, role: input.actorRole, via: 'jwt' },
    action: 'giftcode.redeem',
    target: giftCode.code,
    detail: {
      grantType: giftCode.grantType,
      grantPlan: giftCode.grantPlan,
      grantMonths: giftCode.grantMonths,
      grantCredits: giftCode.grantCredits,
    },
  });

  return result;
}

// ── List / revoke (operator management) ─────────────────────────────────

export async function listGiftCodes(): Promise<GiftCodeView[]> {
  const codes = await GiftCodeModel.find({}).sort({ createdAt: -1 }).limit(200).lean<IGiftCode[]>();
  return codes.map(toView);
}

export async function revokeGiftCode(codeId: string, actorRole: CtxRole, actorUserId?: string): Promise<GiftCodeView> {
  if (!MINT_ROLES.has(actorRole)) {
    throw new AuthError('only an owner, admin, or operator can revoke a gift code', 403, 'FORBIDDEN');
  }
  const giftCode = await GiftCodeModel.findOne({ codeId });
  if (!giftCode) throw new AuthError('gift code not found', 404, 'NOT_FOUND');
  if (giftCode.status === 'disabled') return toView(giftCode as IGiftCode);

  giftCode.status = 'disabled';
  await giftCode.save();

  log.info({ codeId }, 'gift code revoked');
  recordAuditEvent({
    tenantId: DEFAULT_TENANT_ID,
    actor: { userId: actorUserId, role: actorRole, via: actorRole === 'operator' ? 'operator' : 'jwt' },
    action: 'giftcode.revoke',
    target: giftCode.code,
    detail: { codeId },
  });
  return toView(giftCode as IGiftCode);
}
