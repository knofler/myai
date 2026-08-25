/**
 * Marketplace charge-trigger → ledger-append call site (ADR-019 §4 / checklist
 * item #3).
 *
 * Pure — no I/O, no Stripe. The ADR-019 §4 billing-flow table says: "At the
 * charge boundary the implementation: charges the installer (Stripe, reusing
 * `billing.ts`), then appends a ledger entry via `computeRevenueShare`." This
 * module is the second half of that sentence, shaped as a pure function so it
 * is testable without a live Stripe account or a DB: given the charge event
 * (install-time for `one_time`, a billing-period boundary for `subscription`/
 * `usage`) and the amount actually charged, it produces the exact
 * `PayoutLedgerEntry` to append. The caller (dashboard's
 * `marketplace-billing.ts`, which does the real Stripe call reusing
 * `billing.ts`'s `stripePost`) supplies `entryId` — the Stripe
 * charge/PaymentIntent/invoice id — so the append is idempotent the same way
 * the ADR-014 meter-event pattern is: Stripe's own id is the dedup key.
 */
import type { LedgerEntryType, PayoutLedgerEntry, PricingModel } from './types.js';
import { computeRevenueShare } from './revenue-share.js';

/**
 * ADR-019 §4's pricing-model → ledger-entry-type table. `free` has no charge
 * event at all — commerce short-circuits (absent from this map).
 */
export const CHARGE_LEDGER_TYPE: Readonly<Partial<Record<PricingModel, LedgerEntryType>>> = {
  one_time: 'sale',
  subscription: 'subscription_cycle',
  usage: 'usage',
};

/** Which ledger entry type (if any) a pricing model's charge event produces.
 *  `null` for `free` — nothing is charged, nothing is appended. */
export function chargeLedgerType(pricingModel: PricingModel): LedgerEntryType | null {
  return CHARGE_LEDGER_TYPE[pricingModel] ?? null;
}

export interface ChargeEventInput {
  creatorTenantId: string;
  listingId: string;
  /** Absent for a usage period roll-up that isn't tied to a single install row. */
  installId?: string;
  pricingModel: PricingModel;
  /** Gross amount charged for THIS event: the one_time price, one subscription
   *  cycle's price, or a usage period's rolled-up amount. Always >= 0 here —
   *  refunds go through `buildRefundReversal` (revenue-share.ts), not this path. */
  grossUsd: number;
  /** The listing's resolved creator share (`MarketplaceListing.revenueShareBps`). */
  creatorShareBps: number;
  currency: string;
  /** Idempotency key — the Stripe object id (PaymentIntent/session/invoice) that
   *  proves the charge actually happened. Becomes `PayoutLedgerEntry.entryId`. */
  entryId: string;
  /** When the charge event occurred (install time, or the period boundary). */
  occurredAt: string;
}

/**
 * Build the ledger entry for a charge event at the install boundary
 * (`one_time`) or a billing-period boundary (`subscription`/`usage`).
 *
 * Returns `null` for `free` (no charge, no ledger row — ADR-019 §4). Status is
 * always `pending` on creation — entries clear into `available` on their own
 * hold-window schedule (`computeCreatorBalance`'s concern, not this one).
 *
 * Throws if `grossUsd` is negative — a charge event is never a credit; use
 * `buildRefundReversal` for that.
 */
export function buildChargeLedgerEntry(input: ChargeEventInput): Omit<PayoutLedgerEntry, 'createdAt'> | null {
  const type = chargeLedgerType(input.pricingModel);
  if (!type) return null;
  if (input.grossUsd < 0) {
    throw new Error(`grossUsd must be >= 0 for a charge event (got ${input.grossUsd}); use buildRefundReversal for credits`);
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
