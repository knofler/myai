// GET  /api/marketplace/review/[listingId]/[version] — one review-queue entry
//      (listing + version + declaredTools diff), for the detail page.
// POST /api/marketplace/review/[listingId]/[version] { decision, reviewedBy }
//      — approve or reject an in_review ListingVersion (ADR-019
//      listing-lifecycle version transitions: in_review → approved | draft).
// Illegal transitions (e.g. re-deciding an already-approved version) are 409
// with the state machine's own reason.
//
// Operator-only (requireOperator): approving/rejecting a third-party
// submission is a platform operation, not a tenant action (ADR-019
// "marketplace.review ... not a tenant role, a platform operation") — every
// caller here is gated the same way regardless of which tenant they belong
// to, same posture as the other operator-only dashboard routes.
import { NextRequest, NextResponse } from 'next/server';
import { getReviewQueueEntry, reviewListingVersion } from '@/lib/marketplace-store';
import { requireOperator } from '@/lib/require-operator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ listingId: string; version: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const denied = requireOperator(req);
  if (denied) return denied;
  const { listingId, version } = await params;
  const entry = getReviewQueueEntry(listingId, decodeURIComponent(version));
  if (!entry) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ entry });
}

const DECISION_TO_STATUS = { approve: 'approved', reject: 'draft' } as const;

export async function POST(req: NextRequest, { params }: Params) {
  const denied = requireOperator(req);
  if (denied) return denied;
  const { listingId, version } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const { decision, reviewedBy } = (body ?? {}) as { decision?: unknown; reviewedBy?: unknown };
  if (decision !== 'approve' && decision !== 'reject') {
    return NextResponse.json({ error: 'body must be { decision: "approve" | "reject", reviewedBy: string }' }, { status: 400 });
  }
  if (typeof reviewedBy !== 'string' || reviewedBy.length === 0) {
    return NextResponse.json({ error: 'reviewedBy is required' }, { status: 400 });
  }

  const result = reviewListingVersion({
    listingId,
    version: decodeURIComponent(version),
    to: DECISION_TO_STATUS[decision],
    reviewedBy,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ version: result.value });
}
