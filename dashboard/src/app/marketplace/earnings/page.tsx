// /marketplace/earnings — the creator-earnings dashboard (ADR-019 checklist
// item #6, creator-earnings half; ratings/reviews stay out of scope per the
// ADR's own "Out of scope" list). Reads the active tenant's PayoutLedgerEntry
// rows (marketplace-ledger-store.ts, persisted since checklist #1) through
// computeCreatorBalance (marketplace-billing.ts) for the available/pending/
// paid/lifetime headline, then breaks lifetime net down per listing and shows
// the raw ledger history. Scoped to `creatorTenantId` (ADR-010) — a tenant
// only ever sees its OWN earnings, matching the ledger's own ownership model.
import Link from 'next/link';
import { connectDB } from '@/lib/db';
import { getActiveTenant } from '@/lib/tenant';
import { computeCreatorBalance, type PayoutLedgerEntry } from '@/lib/marketplace-billing';
import { listLedgerForCreator } from '@/lib/marketplace-ledger-store';
import { groupLedgerByListing, recentLedgerHistory } from '@/lib/marketplace-earnings';
import { getCatalog } from '@/lib/marketplace-store';
import { fmtUsd } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { StatCard, Card, EmptyState, THead } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

const STATUS_BADGE: Record<PayoutLedgerEntry['status'], string> = {
  pending: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  available: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  paid: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  reversed: 'bg-red-500/15 text-red-400 border-red-500/30',
};

const TYPE_LABEL: Record<PayoutLedgerEntry['type'], string> = {
  sale: 'sale',
  subscription_cycle: 'subscription',
  usage: 'usage',
  refund_reversal: 'refund reversal',
  adjustment: 'adjustment',
  payout: 'payout',
};

/** Ledger rows carry a positive gross/net for a charge and a negative net for
 *  a payout — render with an explicit sign rather than a bare `$-50.00`. */
function fmtSignedUsd(n: number): string {
  return n < 0 ? `-${fmtUsd(-n)}` : fmtUsd(n);
}

export default async function MarketplaceEarningsPage() {
  let dbError = false;
  try {
    await connectDB();
  } catch {
    dbError = true;
  }

  const tenantId = await getActiveTenant();
  const entries = dbError ? [] : await listLedgerForCreator(tenantId);
  const balance = computeCreatorBalance(entries);
  const listingRollup = groupLedgerByListing(entries);
  const history = recentLedgerHistory(entries);

  const myListings = getCatalog().filter((l) => l.creatorTenantId === tenantId);
  const listingTitle = (listingId: string) =>
    myListings.find((l) => l.listingId === listingId)?.title ?? listingId;

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        title="Creator earnings"
        subtitle="Your marketplace revenue-share ledger (ADR-019 §1/§4) — available, pending clearance, paid out, and the full history behind it."
      >
        <Link href="/marketplace" className="text-xs px-3 py-1.5 rounded-md bg-[rgb(var(--bg-hover))] border border-zinc-700 text-[rgb(var(--text-primary))] hover:border-emerald-500/40">
          ← Back to marketplace
        </Link>
      </PageHeader>

      {dbError && (
        <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          Database unreachable — showing zeros. The ledger fills as charges and payouts are recorded.
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Available now" value={fmtUsd(balance.availableUsd)} sub="cleared, payout-eligible" accent="green" />
        <StatCard label="Pending clearance" value={fmtUsd(balance.pendingUsd)} sub="in the hold window" accent="yellow" />
        <StatCard label="Paid out" value={fmtUsd(balance.paidUsd)} sub="lifetime transfers" accent="blue" />
        <StatCard label="Lifetime net" value={fmtUsd(balance.lifetimeNetUsd)} sub="all charges, net of platform fee" accent="purple" />
      </div>

      <div className="mb-8">
        <Card title="Earnings by listing" meta={`${listingRollup.length} listing${listingRollup.length === 1 ? '' : 's'} with activity`}>
          {listingRollup.length === 0 ? (
            <EmptyState>No charges recorded yet for your listings.</EmptyState>
          ) : (
            <table className="w-full text-sm">
              <THead cols={[{ label: 'Listing' }, { label: 'Charges', align: 'right' }, { label: 'Lifetime net', align: 'right' }]} />
              <tbody>
                {listingRollup.map((r) => (
                  <tr key={r.listingId} className="border-b border-[rgb(var(--border-subtle))]/60 last:border-0">
                    <td className="px-4 py-3">
                      <div className="text-[rgb(var(--text-primary))] font-medium">{listingTitle(r.listingId)}</div>
                      <div className="text-xs text-[rgb(var(--text-muted))] font-mono">{r.listingId}</div>
                    </td>
                    <td className="px-4 py-3 text-right text-[rgb(var(--text-secondary))]">{r.chargeCount}</td>
                    <td className="px-4 py-3 text-right text-emerald-400 font-medium">{fmtUsd(r.lifetimeNetUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Ledger history" meta={`${history.length} of ${entries.length} row${entries.length === 1 ? '' : 's'}`}>
        {history.length === 0 ? (
          <EmptyState>No ledger activity yet.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <THead
              cols={[
                { label: 'Date' },
                { label: 'Listing' },
                { label: 'Type' },
                { label: 'Status' },
                { label: 'Gross', align: 'right' },
                { label: 'Platform fee', align: 'right' },
                { label: 'Net to you', align: 'right' },
              ]}
            />
            <tbody>
              {history.map((e) => (
                <tr key={e.entryId} className="border-b border-[rgb(var(--border-subtle))]/60 last:border-0">
                  <td className="px-4 py-3 text-[rgb(var(--text-muted))] text-xs">{new Date(e.occurredAt).toLocaleString()}</td>
                  <td className="px-4 py-3 text-[rgb(var(--text-primary))] text-xs font-mono">{listingTitle(e.listingId)}</td>
                  <td className="px-4 py-3 text-[rgb(var(--text-secondary))]">{TYPE_LABEL[e.type]}</td>
                  <td className="px-4 py-3">
                    <Badge className={STATUS_BADGE[e.status]}>{e.status}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right text-[rgb(var(--text-secondary))]">{fmtSignedUsd(e.grossUsd)}</td>
                  <td className="px-4 py-3 text-right text-[rgb(var(--text-muted))]">{fmtUsd(e.platformFeeUsd)}</td>
                  <td className="px-4 py-3 text-right font-medium text-[rgb(var(--text-primary))]">{fmtSignedUsd(e.creatorNetUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
