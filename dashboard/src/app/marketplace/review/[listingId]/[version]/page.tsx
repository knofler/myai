// /marketplace/review/[listingId]/[version] — review-queue detail: the
// submission's changelog, manifest hash, and the declaredTools widening diff
// against the listing's prior approved/published version (ADR-028 §4), plus
// approve/reject actions driving the ADR-019 version-lifecycle transition.
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Card } from '@/components/ui/card';
import { DeclaredToolsDiffView } from '@/components/marketplace-declared-tools-diff';
import { MarketplaceReviewActions } from '@/components/marketplace-review-actions';
import { getReviewQueueEntry } from '@/lib/marketplace-store';

export const dynamic = 'force-dynamic';

export default async function MarketplaceReviewDetailPage({
  params,
}: {
  params: Promise<{ listingId: string; version: string }>;
}) {
  const { listingId, version } = await params;
  const entry = getReviewQueueEntry(listingId, decodeURIComponent(version));
  if (!entry) notFound();

  const { listing, version: v, priorApproved, declaredToolsDiff } = entry;

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader
        title={`Review: ${listing.title} @ ${v.version}`}
        subtitle={
          <Link href="/marketplace/review" className="hover:text-emerald-400">
            ← back to review queue
          </Link>
        }
      />

      <div className="space-y-4">
        <Card title="Submission">
          <div className="p-4 space-y-3 text-sm">
            <div>
              <span className="text-zinc-500">Listing:</span>{' '}
              <span className="text-zinc-200">{listing.title}</span>{' '}
              <span className="text-zinc-600">({listing.slug}, {listing.kind})</span>
            </div>
            <div>
              <span className="text-zinc-500">Manifest hash:</span>{' '}
              <span className="text-zinc-300 font-mono text-xs">{v.manifestHash}</span>
            </div>
            <div>
              <span className="text-zinc-500">Changelog:</span>
              <p className="text-zinc-300 mt-1">{v.changelog}</p>
            </div>
          </div>
        </Card>

        <Card title="Capability declaration" accent={declaredToolsDiff.added.length > 0 ? 'amber' : undefined}>
          <div className="p-4">
            <DeclaredToolsDiffView
              declaredTools={v.declaredTools}
              diff={declaredToolsDiff}
              isResubmission={priorApproved !== undefined}
            />
          </div>
        </Card>

        <Card title="Decision">
          <div className="p-4">
            <MarketplaceReviewActions listingId={listing.listingId} version={v.version} />
          </div>
        </Card>
      </div>
    </div>
  );
}
