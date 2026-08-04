// /marketplace/review — the operator-facing review queue (ADR-028 §4): every
// in_review ListingVersion, across all creator tenants, with a flagged
// declaredTools-widening badge so a reviewer doesn't have to open every
// listing to know which submissions need extra scrutiny. Distinct from
// /marketplace (the tenant-facing published-catalog browse/install surface).
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, EmptyState, THead } from '@/components/ui/card';
import { listReviewQueue } from '@/lib/marketplace-store';

export const dynamic = 'force-dynamic';

export default function MarketplaceReviewQueuePage() {
  const entries = listReviewQueue();

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        title="Marketplace review queue"
        subtitle="ListingVersions awaiting approve/reject (ADR-019 listing-lifecycle in_review state). Resubmissions widening declaredTools are flagged before you open the diff."
      />

      <Card title="Pending review" meta={`${entries.length} in_review`}>
        {entries.length === 0 ? (
          <EmptyState>No ListingVersions are awaiting review.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <THead
              cols={[
                { label: 'Listing' },
                { label: 'Version' },
                { label: 'Submitted' },
                { label: 'Declared tools' },
                { label: '' },
              ]}
            />
            <tbody>
              {entries.map((entry) => (
                <tr key={`${entry.listing.listingId}::${entry.version.version}`} className="border-b border-zinc-800/60 last:border-0">
                  <td className="px-4 py-3">
                    <div className="text-zinc-200 font-medium">{entry.listing.title}</div>
                    <div className="text-xs text-zinc-500">{entry.listing.slug}</div>
                  </td>
                  <td className="px-4 py-3 text-zinc-300">
                    {entry.version.version}
                    {entry.priorApproved && (
                      <div className="text-xs text-zinc-500">resubmission (prior: {entry.priorApproved.version})</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 text-xs">{new Date(entry.version.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    {entry.declaredToolsDiff.added.length > 0 ? (
                      <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/40">
                        widens: +{entry.declaredToolsDiff.added.join(', +')}
                      </Badge>
                    ) : (
                      <span className="text-xs text-zinc-600">no widening</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/marketplace/review/${entry.listing.listingId}/${encodeURIComponent(entry.version.version)}`}
                      className="text-xs px-3 py-1.5 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-emerald-500/40"
                    >
                      Review
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
