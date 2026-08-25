// Pure rollup helpers for the /marketplace/earnings creator-earnings dashboard
// (ADR-019 checklist item #6, creator-earnings half — ratings/reviews are
// explicitly out of scope per the ADR's "Out of scope" list). Kept separate
// from marketplace-billing.ts, which is a byte-equivalent mirror of the
// runtime pure layer and must not grow UI-only rollups.
import type { PayoutLedgerEntry } from './marketplace-billing';

export interface ListingEarningsRollup {
  listingId: string;
  lifetimeNetUsd: number;
  chargeCount: number;
}

/** Per-listing lifetime net-to-creator, sorted highest-earning first. Skips
 *  `payout` rows (not listing-scoped — see PAYOUT_LEDGER_SENTINEL_LISTING_ID
 *  in api/marketplace/payouts/run/route.ts) and `reversed` rows (refunded,
 *  never counted), mirroring computeCreatorBalance's own exclusions. */
export function groupLedgerByListing(entries: readonly PayoutLedgerEntry[]): ListingEarningsRollup[] {
  const byListing = new Map<string, { netCents: number; count: number }>();
  for (const e of entries) {
    if (e.type === 'payout') continue;
    if (e.status === 'reversed') continue;
    const cur = byListing.get(e.listingId) ?? { netCents: 0, count: 0 };
    cur.netCents += Math.round(e.creatorNetUsd * 100);
    cur.count += 1;
    byListing.set(e.listingId, cur);
  }
  return [...byListing.entries()]
    .map(([listingId, v]) => ({ listingId, lifetimeNetUsd: v.netCents / 100, chargeCount: v.count }))
    .sort((a, b) => b.lifetimeNetUsd - a.lifetimeNetUsd);
}

/** Most-recent-first ledger history, capped so the dashboard table stays
 *  bounded for a long-lived creator. */
export function recentLedgerHistory(entries: readonly PayoutLedgerEntry[], limit = 50): PayoutLedgerEntry[] {
  return [...entries].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()).slice(0, limit);
}
