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
import type { DeclaredToolsDiff, ListingVersion, MarketplaceListing } from '@/lib/marketplace';
import { plural } from '@/lib/summary';

export const dynamic = 'force-dynamic';

/** The one-line answer (DESIGN_LANGUAGE §5.1) for a single submission: what is
 *  being asked for, and whether it widens what this package can do. One item,
 *  so it states that item's standing rather than a count of the queue. */
function submissionSummary(
  listing: MarketplaceListing,
  version: ListingVersion,
  priorApproved: ListingVersion | undefined,
  diff: DeclaredToolsDiff,
): string {
  const lineage = priorApproved
    ? `a resubmission over ${priorApproved.version}`
    : 'its first version for review';
  const head = `${listing.title} wants to publish ${version.version} as ${lineage}.`;
  const tools =
    diff.added.length > 0
      ? `It asks for ${plural(diff.added.length, 'tool')} it did not have before (${diff.added.join(', ')}), so check that against the changelog before approving.`
      : priorApproved
        ? 'It asks for no tools it did not already have.'
        : 'Check the declared tools below against what the changelog says it does.';
  return `${head} ${tools}`;
}

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
        icon="audit"
        title={`Review: ${listing.title} @ ${v.version}`}
        summary={submissionSummary(listing, v, priorApproved, declaredToolsDiff)}
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
              <span className="text-[rgb(var(--text-muted))]">Listing:</span>{' '}
              <span className="text-[rgb(var(--text-primary))]">{listing.title}</span>{' '}
              <span className="text-[rgb(var(--text-muted))]">({listing.slug}, {listing.kind})</span>
            </div>
            <div>
              <span className="text-[rgb(var(--text-muted))]">Manifest hash:</span>{' '}
              <span className="text-[rgb(var(--text-primary))] font-mono text-xs">{v.manifestHash}</span>
            </div>
            <div>
              <span className="text-[rgb(var(--text-muted))]">Changelog:</span>
              <p className="text-[rgb(var(--text-primary))] mt-1">{v.changelog}</p>
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
