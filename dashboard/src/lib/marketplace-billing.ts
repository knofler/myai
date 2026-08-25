// Marketplace charge-trigger wiring (ADR-019 §4 / checklist item #3: "Charge
// wiring at install / billing-period boundary; reuse billing.ts; ledger append
// via computeRevenueShare").
//
// DASHBOARD MIRROR of runtime/src/marketplace/charge.ts (the pure
// pricing-model → ledger-entry-type table + split builder) — same mirroring
// discipline as marketplace.ts/marketplace-connect.ts: the dashboard's Docker
// build context is ./dashboard, so it cannot import across the package
// boundary. Keep the pure half byte-equivalent; the runtime tests are the
// source of truth for the math.
//
// The REAL charge call reuses billing.ts's SDK-free `stripePost` (same
// pattern marketplace-connect.ts already established for Connect). A listing's
// price is creator-set and arbitrary, not one of the platform's own
// pre-registered Stripe Price ids, so the Checkout Session line item uses
// `price_data` (dynamic, inline price) rather than `priceIdForPlan`.
//
// Flow (mirrors the existing subscription checkout → webhook pattern):
//   1. POST /api/marketplace/checkout creates a Checkout Session here and
//      returns the hosted `url`.
//   2. The buyer pays on Stripe's hosted page.
//   3. `checkout.session.completed` lands on the SAME billing webhook
//      (api/billing/webhook/route.ts) as subscription checkouts, but is
//      routed to `completeMarketplaceCharge` (marketplace-store.ts) BEFORE the
//      tenant-plan switch — keyed on `metadata.listingId` — so a marketplace
//      purchase never touches `tenant.plan`/`subscriptionStatus`.
//
// Scope of THIS charge event: `one_time` (full price at install) and a
// `subscription` listing's FIRST period (Stripe's own recurring billing then
// invoices subsequent periods automatically). Appending a `subscription_cycle`
// ledger row for those LATER periods — off `invoice.payment_succeeded` for a
// marketplace-linked subscription — and `usage` period roll-ups (which read
// ADR-014's `UsageEvent` meter, not wired here) are follow-ups; see the
// ADR-019 checklist #3 addendum for exactly what's open.
import { STRIPE_SECRET_KEY, APP_BASE_URL, isStripeConfigured, stripePost } from './billing';

export function isMarketplaceBillingConfigured(): boolean {
  return isStripeConfigured() && Boolean(STRIPE_SECRET_KEY);
}

// ── Mirror: runtime/src/marketplace/charge.ts ──────────────

export type PricingModel = 'free' | 'one_time' | 'subscription' | 'usage';
export type LedgerEntryType =
  | 'sale'
  | 'subscription_cycle'
  | 'usage'
  | 'refund_reversal'
  | 'adjustment'
  | 'payout';
export type LedgerEntryStatus = 'pending' | 'available' | 'paid' | 'reversed';

export interface PayoutLedgerEntry {
  creatorTenantId: string;
  entryId: string;
  listingId: string;
  installId?: string;
  type: LedgerEntryType;
  status: LedgerEntryStatus;
  grossUsd: number;
  platformFeeUsd: number;
  creatorNetUsd: number;
  currency: string;
  occurredAt: string;
  payoutBatchId?: string;
  createdAt: string;
}

/** ADR-019 §4's pricing-model → ledger-entry-type table. `free` is absent —
 *  commerce short-circuits, no charge, no ledger row. */
export const CHARGE_LEDGER_TYPE: Readonly<Partial<Record<PricingModel, LedgerEntryType>>> = {
  one_time: 'sale',
  subscription: 'subscription_cycle',
  usage: 'usage',
};

export function chargeLedgerType(pricingModel: PricingModel): LedgerEntryType | null {
  return CHARGE_LEDGER_TYPE[pricingModel] ?? null;
}

/** Mirror of `BPS_DENOMINATOR` / the trunc-to-platform rounding rule in
 *  runtime/src/marketplace/revenue-share.ts's `computeRevenueShare`. */
function toCents(usd: number): number {
  return Math.round(usd * 100);
}
function fromCents(cents: number): number {
  return cents / 100;
}

export interface RevenueSplit {
  grossUsd: number;
  platformFeeUsd: number;
  creatorNetUsd: number;
  creatorShareBps: number;
}

/** Byte-equivalent mirror of `computeRevenueShare` (revenue-share.ts). Kept
 *  here rather than imported so this module has no cross-package dependency. */
export function computeRevenueShare(grossUsd: number, creatorShareBps: number): RevenueSplit {
  if (!Number.isFinite(grossUsd)) throw new Error('grossUsd must be finite');
  if (creatorShareBps < 0 || creatorShareBps > 10_000) {
    throw new Error(`creatorShareBps out of range: ${creatorShareBps}`);
  }
  const grossCents = toCents(grossUsd);
  const creatorCents = Math.trunc((grossCents * creatorShareBps) / 10_000);
  const platformCents = grossCents - creatorCents;
  return {
    grossUsd: fromCents(grossCents),
    platformFeeUsd: fromCents(platformCents),
    creatorNetUsd: fromCents(creatorCents),
    creatorShareBps,
  };
}

// ── Payout-run mirrors: revenue-share.ts's balance rollup + gate, and
// connect-payout.ts's clearance-hold check (ADR-019 checklist item #4's
// still-open half — "the actual payout-RUN endpoint that reads a real ledger
// store"). Same discipline as computeRevenueShare above: byte-equivalent
// copies, no cross-package import, kept in sync by the runtime tests being
// the source of truth for the math.

/** Creators must accrue at least this (cleared) before a payout runs. */
export const DEFAULT_MIN_PAYOUT_USD = 50;

export interface CreatorBalance {
  availableUsd: number;
  pendingUsd: number;
  paidUsd: number;
  lifetimeNetUsd: number;
}

/** Byte-equivalent mirror of `computeCreatorBalance` (revenue-share.ts). */
export function computeCreatorBalance(entries: readonly PayoutLedgerEntry[]): CreatorBalance {
  let available = 0;
  let pending = 0;
  let paid = 0;
  let lifetime = 0;

  for (const e of entries) {
    const cents = toCents(e.creatorNetUsd);
    if (e.type === 'payout') {
      paid += -cents;
      continue;
    }
    if (e.status === 'reversed') continue;
    lifetime += cents;
    if (e.status === 'available') available += cents;
    else if (e.status === 'pending') pending += cents;
  }

  return {
    availableUsd: fromCents(available),
    pendingUsd: fromCents(pending),
    paidUsd: fromCents(paid),
    lifetimeNetUsd: fromCents(lifetime),
  };
}

export interface PayoutDecision {
  eligible: boolean;
  amountUsd: number;
  reason?: string;
}

/** Byte-equivalent mirror of `decidePayout` (revenue-share.ts). */
export function decidePayout(
  balance: CreatorBalance,
  minPayoutUsd: number = DEFAULT_MIN_PAYOUT_USD,
): PayoutDecision {
  const available = balance.availableUsd;
  if (available <= 0) return { eligible: false, amountUsd: 0, reason: 'no cleared balance' };
  if (available < minPayoutUsd) {
    return { eligible: false, amountUsd: 0, reason: `below minimum payout ($${minPayoutUsd})` };
  }
  return { eligible: true, amountUsd: available };
}

/** Mirror of `DEFAULT_HOLD_DAYS` (connect-payout.ts) — the hold window before
 *  a `pending` ledger entry clears to `available`. */
export const DEFAULT_HOLD_DAYS = 2;

/** Byte-equivalent mirror of `isClearanceElapsed` (connect-payout.ts). Pure —
 *  the payout run's ledger-store sweep is the "actual status mutation"
 *  connect-payout.ts's doc comment says belongs to the store, not here. */
export function isClearanceElapsed(
  occurredAt: string,
  holdDays: number = DEFAULT_HOLD_DAYS,
  now: Date = new Date(),
): boolean {
  const occurred = new Date(occurredAt).getTime();
  if (!Number.isFinite(occurred)) return false;
  const holdMs = holdDays * 24 * 60 * 60 * 1000;
  return now.getTime() - occurred >= holdMs;
}

export interface ChargeEventInput {
  creatorTenantId: string;
  listingId: string;
  installId?: string;
  pricingModel: PricingModel;
  grossUsd: number;
  creatorShareBps: number;
  currency: string;
  entryId: string;
  occurredAt: string;
}

/** Mirror of `buildChargeLedgerEntry` (charge.ts) — the charge-trigger →
 *  ledger-append call site's pure core. `null` for `free`. */
export function buildChargeLedgerEntry(input: ChargeEventInput): Omit<PayoutLedgerEntry, 'createdAt'> | null {
  const type = chargeLedgerType(input.pricingModel);
  if (!type) return null;
  if (input.grossUsd < 0) {
    throw new Error(`grossUsd must be >= 0 for a charge event (got ${input.grossUsd})`);
  }
  const split = computeRevenueShare(input.grossUsd, input.creatorShareBps);
  return {
    creatorTenantId: input.creatorTenantId,
    entryId: input.entryId,
    listingId: input.listingId,
    installId: input.installId,
    type,
    status: 'pending',
    grossUsd: split.grossUsd,
    platformFeeUsd: split.platformFeeUsd,
    creatorNetUsd: split.creatorNetUsd,
    currency: input.currency,
    occurredAt: input.occurredAt,
  };
}

// ── Real Stripe wiring (reuses billing.ts's stripePost) ────

export interface MarketplaceCheckoutSession {
  id: string;
  url: string;
}

/**
 * Create the Checkout Session that IS the install/period-boundary charge
 * trigger. `mode: 'payment'` for a `one_time` sale; `mode: 'subscription'`
 * for a `subscription` listing (Stripe then owns future-period billing).
 * `usage` listings have no up-front checkout — they charge at period roll-up,
 * a follow-up (reads the ADR-014 `UsageEvent` meter) — callers must not reach
 * here with `pricingModel: 'usage'`.
 *
 * `metadata.listingId` is the marker the webhook uses to route this checkout
 * to `completeMarketplaceCharge` instead of the tenant-plan switch.
 */
export async function createMarketplaceCheckoutSession(opts: {
  tenantId: string;
  userId: string;
  slug: string;
  listingId: string;
  version: string;
  pricingModel: Extract<PricingModel, 'one_time' | 'subscription'>;
  title: string;
  priceUsd: number;
  currency?: string;
  ownerEmail?: string;
  stripeCustomerId?: string;
}): Promise<MarketplaceCheckoutSession> {
  const currency = (opts.currency ?? 'usd').toLowerCase();
  const meta = {
    tenantId: opts.tenantId,
    userId: opts.userId,
    listingId: opts.listingId,
    slug: opts.slug,
    version: opts.version,
    pricingModel: opts.pricingModel,
  };
  const priceData: Record<string, unknown> = {
    currency,
    unit_amount: Math.round(opts.priceUsd * 100),
    product_data: { name: opts.title },
  };
  if (opts.pricingModel === 'subscription') {
    priceData.recurring = { interval: 'month' };
  }
  const body: Record<string, unknown> = {
    mode: opts.pricingModel === 'subscription' ? 'subscription' : 'payment',
    client_reference_id: opts.tenantId,
    success_url: `${APP_BASE_URL}/marketplace/${opts.slug}?install=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_BASE_URL}/marketplace/${opts.slug}?install=cancel`,
    line_items: [{ price_data: priceData, quantity: 1 }],
    metadata: meta,
    ...(opts.pricingModel === 'subscription' ? { subscription_data: { metadata: meta } } : { payment_intent_data: { metadata: meta } }),
  };
  if (opts.stripeCustomerId) body.customer = opts.stripeCustomerId;
  else if (opts.ownerEmail) body.customer_email = opts.ownerEmail;
  return stripePost<MarketplaceCheckoutSession>('/checkout/sessions', body);
}
