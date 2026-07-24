/**
 * Marketplace revenue-share math — the pure model layer (ADR-019).
 *
 * The money rules, as functions with no I/O so they are exhaustively testable:
 *  1. split gross into platform fee + creator net (basis-point rate, cent-exact)
 *  2. roll a set of ledger entries into a creator balance
 *  3. decide whether a payout batch may run (minimum-threshold gate)
 *
 * Cent-exactness is the non-negotiable invariant: `platformFeeUsd + creatorNetUsd
 * === grossUsd` to the cent, always. We compute in integer cents and give the
 * ROUNDING REMAINDER TO THE PLATFORM (fee = gross − floor(creatorNet)), which is
 * the conventional app-store behaviour and guarantees the creator is never
 * over-credited by sub-cent rounding.
 */
import type { PayoutLedgerEntry, LedgerEntryStatus } from './types.js';

/** Platform defaults. Overridable per-listing via `revenueShareBps`. */
export const DEFAULT_CREATOR_SHARE_BPS = 7000;   // creator keeps 70%
export const BPS_DENOMINATOR = 10_000;
/** Creators must accrue at least this (cleared) before a payout runs. */
export const DEFAULT_MIN_PAYOUT_USD = 50;

export interface RevenueSplit {
  grossUsd: number;
  platformFeeUsd: number;
  creatorNetUsd: number;
  creatorShareBps: number;
}

/** USD ↔ integer cents. Rounds to nearest cent (half-up) to kill FP dust. */
function toCents(usd: number): number {
  return Math.round(usd * 100);
}
function fromCents(cents: number): number {
  return cents / 100;
}

/**
 * Split a gross charge into creator net + platform fee, cent-exact.
 *
 * Works for negative gross too (refunds/reversals): the split is proportional,
 * so a reversal unwinds exactly what the original sale credited.
 *
 * @throws if the share is outside [0, BPS_DENOMINATOR].
 */
export function computeRevenueShare(
  grossUsd: number,
  creatorShareBps: number = DEFAULT_CREATOR_SHARE_BPS,
): RevenueSplit {
  if (!Number.isFinite(grossUsd)) throw new Error('grossUsd must be finite');
  if (creatorShareBps < 0 || creatorShareBps > BPS_DENOMINATOR) {
    throw new Error(`creatorShareBps out of range: ${creatorShareBps}`);
  }

  const grossCents = toCents(grossUsd);
  // Round the creator net TOWARD ZERO (Math.trunc) so a sub-cent remainder falls
  // to the platform on both positive sales and negative refunds — the creator is
  // never over-credited, and a refund never over-debits the platform.
  const creatorCents = Math.trunc((grossCents * creatorShareBps) / BPS_DENOMINATOR);
  const platformCents = grossCents - creatorCents;   // remainder → platform (exact)

  return {
    grossUsd: fromCents(grossCents),
    platformFeeUsd: fromCents(platformCents),
    creatorNetUsd: fromCents(creatorCents),
    creatorShareBps,
  };
}

export interface CreatorBalance {
  /** Cleared funds eligible for the next payout (status = 'available'). */
  availableUsd: number;
  /** Earned but still inside the clearance/hold window (status = 'pending'). */
  pendingUsd: number;
  /** Already disbursed (sum of 'paid' creatorNet, sign-flipped to positive). */
  paidUsd: number;
  /** Net lifetime creator earnings across non-reversed, non-payout rows. */
  lifetimeNetUsd: number;
}

/** Sum a set of a single creator's ledger entries into a balance snapshot. */
export function computeCreatorBalance(entries: readonly PayoutLedgerEntry[]): CreatorBalance {
  let available = 0;
  let pending = 0;
  let paid = 0;
  let lifetime = 0;

  for (const e of entries) {
    const cents = toCents(e.creatorNetUsd);
    if (e.type === 'payout') {
      // payout rows carry NEGATIVE net (funds leaving the balance); track paid as positive.
      paid += -cents;
      continue;
    }
    // 'reversed' voids a PENDING entry that never cleared (no compensating row);
    // a refund of a CLEARED sale is instead a separate negative 'refund_reversal'
    // entry that nets arithmetically. Both paths are append-only — the ledger is
    // never mutated retroactively.
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
  amountUsd: number;    // what would be paid (0 when not eligible)
  reason?: string;
}

/**
 * Decide whether a creator's cleared balance may be paid out now.
 * Gate: available balance must meet the minimum threshold. Below it, funds roll
 * forward (nothing is lost) until a later run clears the bar.
 */
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

/**
 * Build the reversing ledger entry for a refund of a CLEARED sale. Negates the
 * original split so `computeCreatorBalance` unwinds it exactly. Append-only: the
 * original entry is LEFT INTACT (never mutated) — the negative row nets against
 * it. (For a still-pending entry that never cleared, void it by setting its
 * status to 'reversed' instead; do not also append a reversal, or the balance
 * double-subtracts.)
 */
export function buildRefundReversal(
  original: Pick<PayoutLedgerEntry, 'creatorTenantId' | 'listingId' | 'installId' | 'grossUsd' | 'platformFeeUsd' | 'creatorNetUsd' | 'currency'>,
  entryId: string,
  occurredAt: string,
): Omit<PayoutLedgerEntry, 'createdAt'> {
  return {
    creatorTenantId: original.creatorTenantId,
    entryId,
    listingId: original.listingId,
    installId: original.installId,
    type: 'refund_reversal',
    status: 'available',            // immediately nets against the balance
    grossUsd: -original.grossUsd,
    platformFeeUsd: -original.platformFeeUsd,
    creatorNetUsd: -original.creatorNetUsd,
    currency: original.currency,
    occurredAt,
  };
}

/** Ledger statuses that count as "settled money owed to the creator". */
export const OWED_STATUSES: readonly LedgerEntryStatus[] = ['pending', 'available'];
