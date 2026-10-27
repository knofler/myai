// /marketplace/review — the operator-facing review queue (ADR-028 §4): every
// in_review ListingVersion, across all creator tenants, with a flagged
// declaredTools-widening badge so a reviewer doesn't have to open every
// listing to know which submissions need extra scrutiny. Distinct from
// /marketplace (the tenant-facing published-catalog browse/install surface).
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { EmptyState, Card } from '@/components/ui/card';
import { DataTable, type DataRow } from '@/components/ui/data-table';
import { listReviewQueue } from '@/lib/marketplace-store';
import { plural, verb, cap } from '@/lib/summary';

export const dynamic = 'force-dynamic';

/** The one-line answer (DESIGN_LANGUAGE §5.1) — how much is waiting on the
 *  reviewer, and how much of it asks for capabilities it did not have before. */
function reviewQueueSummary(total: number, widening: number, resubmissions: number): string {
  if (total === 0) {
    return 'Nothing is waiting for review. Every submitted version has been approved or sent back.';
  }
  const head = `${cap(plural(total, 'submission'))} ${verb(total, 'is', 'are')} waiting on your approve or reject decision.`;
  const risk =
    widening > 0
      ? ` ${widening === 1 ? 'One of them asks' : `${widening} of them ask`} for tools they did not have before, so read the diff first.`
      : resubmissions > 0
        ? ' None of them widen the tools they can use.'
        : '';
  return head + risk;
}

export default function MarketplaceReviewQueuePage() {
  const entries = listReviewQueue();
  const widening = entries.filter((e) => e.declaredToolsDiff.added.length > 0).length;
  const resubmissions = entries.filter((e) => e.priorApproved !== undefined).length;

  const rows: DataRow[] = entries.map((entry) => ({
    id: `${entry.listing.listingId}::${entry.version.version}`,
    search: `${entry.listing.title} ${entry.listing.slug} ${entry.version.version}`.toLowerCase(),
    sort: { listing: entry.listing.title, submitted: new Date(entry.version.createdAt).getTime() },
    cells: [
      <>
        <div className="text-[rgb(var(--text-primary))] font-medium">{entry.listing.title}</div>
        <div className="text-xs text-[rgb(var(--text-muted))]">{entry.listing.slug}</div>
      </>,
      <>
        {entry.version.version}
        {entry.priorApproved && (
          <div className="text-xs text-[rgb(var(--text-muted))]">resubmission (prior: {entry.priorApproved.version})</div>
        )}
      </>,
      <span className="text-xs">{new Date(entry.version.createdAt).toLocaleString()}</span>,
      entry.declaredToolsDiff.added.length > 0 ? (
        <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/40">
          widens: +{entry.declaredToolsDiff.added.join(', +')}
        </Badge>
      ) : (
        <span className="text-meta text-[rgb(var(--text-muted))]">no widening</span>
      ),
      <Link
        href={`/marketplace/review/${entry.listing.listingId}/${encodeURIComponent(entry.version.version)}`}
        className="text-xs px-3 py-1.5 rounded-md bg-[rgb(var(--bg-hover))] border border-[rgb(var(--border-subtle))] text-[rgb(var(--text-primary))] hover:border-emerald-500/40"
      >
        Review
      </Link>,
    ],
  }));

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        icon="audit"
        title="Marketplace review queue"
        summary={reviewQueueSummary(entries.length, widening, resubmissions)}
        subtitle="Listing versions submitted by creators, oldest first."
      />

      {entries.length === 0 ? (
        <Card title="Pending review" meta="0 in review">
          <EmptyState>No listing versions are awaiting review.</EmptyState>
        </Card>
      ) : (
        <DataTable
          title="Pending review"
          meta={`${plural(entries.length, 'version')} in review`}
          searchPlaceholder="Search listings…"
          defaultSort="submitted"
          columns={[
            { label: 'Listing', sortKey: 'listing', mobile: 'title' },
            { label: 'Version', mobile: 'meta' },
            { label: 'Submitted', sortKey: 'submitted', mobile: 'detail' },
            { label: 'Declared tools', mobile: 'badge' },
            { label: '', mobile: 'detail' },
          ]}
          rows={rows}
        />
      )}
    </div>
  );
}
