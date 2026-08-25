// /api/marketplace/listings/[slug]/reviews — ratings/reviews surface
// (ADR-019 checklist #6, second half). Scoped per installerTenantId (ADR-010
// §1.5), same posture as installs.
//
//   GET  → the listing's review list (newest first) + rating summary + the
//          calling tenant's own review (if any) + whether they're eligible
//          to leave one (cookie-scoped, ADR-010).
//   POST { rating, comment } → create or edit the calling tenant's review,
//          gated on having a live (non-uninstalled) install of the listing —
//          upsertReview() enforces this, mirroring the ADR-019 install gate's
//          "you must have actually used it" spirit without a new state
//          machine. Moderation (flagging, removal) is explicitly out of
//          scope for ADR-019 — see the ADR's "Out of scope" note.
import { NextRequest, NextResponse } from 'next/server';
import { canReviewListing, isListingDiscoverable } from '@/lib/marketplace';
import {
  getListingBySlug,
  getLiveInstall,
  getReviewForTenant,
  listReviewsForListing,
  upsertReview,
} from '@/lib/marketplace-store';
import { DEFAULT_TENANT_ID, TENANT_COOKIE } from '@/lib/tenant-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function tenantOf(req: NextRequest): string {
  return req.cookies.get(TENANT_COOKIE)?.value || DEFAULT_TENANT_ID;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const listing = getListingBySlug(slug);
  if (!listing || !isListingDiscoverable(listing.status)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const tenantId = tenantOf(req);
  const install = getLiveInstall(tenantId, listing.listingId);
  return NextResponse.json({
    reviews: listReviewsForListing(listing.listingId),
    ratingAvg: listing.ratingAvg,
    ratingCount: listing.ratingCount,
    myReview: getReviewForTenant(tenantId, listing.listingId) ?? null,
    reviewGate: canReviewListing(install),
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const { rating, comment } = (body ?? {}) as { rating?: unknown; comment?: unknown };
  if (typeof rating !== 'number' || (comment !== undefined && typeof comment !== 'string')) {
    return NextResponse.json({ error: 'body must be { rating: number, comment?: string }' }, { status: 400 });
  }

  const result = upsertReview({
    tenantId: tenantOf(req),
    userId: 'dashboard-operator',
    slug,
    rating,
    comment: comment ?? '',
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ review: result.value }, { status: 200 });
}
