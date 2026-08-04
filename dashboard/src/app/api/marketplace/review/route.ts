// GET /api/marketplace/review — the operator review queue (ADR-028 §4): every
// in_review ListingVersion across all creator tenants, each paired with its
// declaredTools widening diff against the listing's prior approved/published
// version. Not tenant-scoped — a platform reviewer works across creators, so
// this is operator-only (requireOperator), not gated by tenant role.
import { NextResponse } from 'next/server';
import { listReviewQueue } from '@/lib/marketplace-store';
import { requireOperator } from '@/lib/require-operator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const denied = requireOperator(req);
  if (denied) return denied;
  return NextResponse.json({ entries: listReviewQueue() });
}
