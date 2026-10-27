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
import { computeCreatorBalance, type CreatorBalance, type PayoutLedgerEntry } from '@/lib/marketplace-billing';
import { listLedgerForCreator } from '@/lib/marketplace-ledger-store';
import { groupLedgerByListing, recentLedgerHistory } from '@/lib/marketplace-earnings';
import { getCatalog } from '@/lib/marketplace-store';
import { fmtUsd } from '@/lib/format';
import { plural, verb, joinClauses, cap } from '@/lib/summary';
import { PageHeader } from '@/components/page-header';
import { LedgerStatusBadge } from '@/components/ui/badge';
import { StatCard, Card, EmptyState } from '@/components/ui/card';
import { DataTable, type DataRow } from '@/components/ui/data-table';

export const dynamic = 'force-dynamic';

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

/** The one-line answer (DESIGN_LANGUAGE §5.1) — money you can take out, money
 *  still clearing, money already gone out. Built from the ledger rows this page
 *  already read, and it has to read right at zero and with the DB down. */
function earningsSummary(
  balance: CreatorBalance,
  entryCount: number,
  listingCount: number,
  dbError: boolean,
): string {
  if (dbError) {
    return 'Your earnings ledger cannot reach the database right now, so every figure below reads zero.';
  }
  if (entryCount === 0) {
    return 'You have not earned anything yet. Charges and payouts land here as soon as someone installs a paid listing of yours.';
  }
  const scope =
    listingCount > 0
      ? ` from ${plural(listingCount, 'listing')} that ${verb(listingCount, 'has', 'have')} earned`
      : '';
  const head =
    balance.availableUsd > 0
      ? `You have ${fmtUsd(balance.availableUsd)} ready to pay out${scope}.`
      : `Nothing is ready to pay out right now${scope}.`;
  const tail = joinClauses([
    balance.pendingUsd > 0 && `${fmtUsd(balance.pendingUsd)} is still clearing`,
    balance.paidUsd > 0 && `${fmtUsd(balance.paidUsd)} has already reached you`,
  ]);
  return tail ? `${head} ${cap(tail)}.` : head;
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

  const listingRows: DataRow[] = listingRollup.map((r) => ({
    id: r.listingId,
    search: `${listingTitle(r.listingId)} ${r.listingId}`.toLowerCase(),
    sort: { listing: listingTitle(r.listingId), charges: r.chargeCount, net: r.lifetimeNetUsd },
    cells: [
      <>
        <div className="text-[rgb(var(--text-primary))] font-medium">{listingTitle(r.listingId)}</div>
        <div className="text-xs text-[rgb(var(--text-muted))] font-mono">{r.listingId}</div>
      </>,
      <span className="tabular-nums">{r.chargeCount}</span>,
      <span className="text-emerald-400 font-medium tabular-nums">{fmtUsd(r.lifetimeNetUsd)}</span>,
    ],
  }));

  const historyRows: DataRow[] = history.map((e) => ({
    id: e.entryId,
    search: `${listingTitle(e.listingId)} ${TYPE_LABEL[e.type]} ${e.status}`.toLowerCase(),
    sort: { date: new Date(e.occurredAt).getTime(), net: e.creatorNetUsd },
    cells: [
      <span className="text-xs">{new Date(e.occurredAt).toLocaleString()}</span>,
      <span className="text-xs font-mono">{listingTitle(e.listingId)}</span>,
      TYPE_LABEL[e.type],
      <LedgerStatusBadge status={e.status} />,
      <span className="tabular-nums">{fmtSignedUsd(e.grossUsd)}</span>,
      <span className="text-[rgb(var(--text-muted))] tabular-nums">{fmtUsd(e.platformFeeUsd)}</span>,
      <span className="font-medium text-[rgb(var(--text-primary))] tabular-nums">{fmtSignedUsd(e.creatorNetUsd)}</span>,
    ],
  }));

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        icon="revenue"
        title="Creator earnings"
        summary={earningsSummary(balance, entries.length, listingRollup.length, dbError)}
        subtitle="Your marketplace revenue share: available, clearing, paid out, and the history behind it."
      >
        <Link href="/marketplace" className="text-xs px-3 py-1.5 rounded-md bg-[rgb(var(--bg-hover))] border border-[rgb(var(--border-subtle))] text-[rgb(var(--text-primary))] hover:border-emerald-500/40">
          ← Back to marketplace
        </Link>
      </PageHeader>

      {dbError && (
        <div role="alert" className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          Database unreachable — showing zeros. The ledger fills as charges and payouts are recorded.
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Available now"
          value={fmtUsd(balance.availableUsd)}
          sub="cleared, payout-eligible"
          icon="revenue"
          tone={balance.availableUsd > 0 ? 'ok' : 'muted'}
        />
        <StatCard
          label="Pending clearance"
          value={fmtUsd(balance.pendingUsd)}
          sub="in the hold window"
          icon="clock"
          tone="muted"
        />
        <StatCard
          label="Paid out"
          value={fmtUsd(balance.paidUsd)}
          sub="lifetime transfers"
          icon="check"
          tone={balance.paidUsd > 0 ? 'ok' : 'muted'}
        />
        <StatCard
          label="Lifetime net"
          value={fmtUsd(balance.lifetimeNetUsd)}
          sub="all charges, net of platform fee"
          icon="analytics"
          tone="muted"
        />
      </div>

      <div className="mb-8">
        {listingRollup.length === 0 ? (
          <Card title="Earnings by listing" meta="0 listings with activity">
            <EmptyState>No charges recorded yet for your listings.</EmptyState>
          </Card>
        ) : (
          <DataTable
            title="Earnings by listing"
            meta={`${listingRollup.length} listing${listingRollup.length === 1 ? '' : 's'} with activity`}
            searchPlaceholder="Search listings…"
            defaultSort="net"
            defaultDesc
            columns={[
              { label: 'Listing', sortKey: 'listing', mobile: 'title' },
              { label: 'Charges', align: 'right', sortKey: 'charges', mobile: 'meta' },
              { label: 'Lifetime net', align: 'right', sortKey: 'net', mobile: 'meta' },
            ]}
            rows={listingRows}
          />
        )}
      </div>

      {history.length === 0 ? (
        <Card title="Ledger history" meta="0 rows">
          <EmptyState>No ledger activity yet.</EmptyState>
        </Card>
      ) : (
        <DataTable
          title="Ledger history"
          meta={`${history.length} of ${entries.length} row${entries.length === 1 ? '' : 's'}`}
          searchPlaceholder="Search ledger…"
          defaultSort="date"
          defaultDesc
          columns={[
            { label: 'Date', sortKey: 'date', mobile: 'meta' },
            { label: 'Listing', mobile: 'title' },
            { label: 'Type', mobile: 'detail' },
            { label: 'Status', mobile: 'badge' },
            { label: 'Gross', align: 'right', mobile: 'detail' },
            { label: 'Platform fee', align: 'right', mobile: 'detail' },
            { label: 'Net to you', align: 'right', sortKey: 'net', mobile: 'detail' },
          ]}
          rows={historyRows}
        />
      )}
    </div>
  );
}
