// POST /api/marketplace/checkout — the charge-trigger entry point for a PAID
// listing install (ADR-019 §4 / checklist item #3). Free listings still go
// straight through POST /api/marketplace/installs (no charge boundary at
// all — commerce short-circuits). A `one_time`/`subscription` listing instead
// starts a Stripe Checkout Session here; the Install row + ledger append only
// happen once Stripe confirms payment, via `checkout.session.completed` on
// the shared billing webhook (api/billing/webhook/route.ts →
// completeMarketplaceCharge in marketplace-store.ts).
import { NextRequest, NextResponse } from 'next/server';
import { getListingBySlug, getVersions } from '@/lib/marketplace-store';
import { canInstall } from '@/lib/marketplace';
import {
  isMarketplaceBillingConfigured,
  createMarketplaceCheckoutSession,
} from '@/lib/marketplace-billing';
import { DEFAULT_TENANT_ID, TENANT_COOKIE } from '@/lib/tenant-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function tenantOf(req: NextRequest): string {
  return req.cookies.get(TENANT_COOKIE)?.value || DEFAULT_TENANT_ID;
}

export async function POST(req: NextRequest) {
  if (!isMarketplaceBillingConfigured()) {
    return NextResponse.json({ error: 'marketplace billing not configured' }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const { slug, version } = (body ?? {}) as { slug?: unknown; version?: unknown };
  if (typeof slug !== 'string' || !slug || (version !== undefined && typeof version !== 'string')) {
    return NextResponse.json({ error: 'body must be { slug: string, version?: string }' }, { status: 400 });
  }

  const listing = getListingBySlug(slug);
  if (!listing) return NextResponse.json({ error: `no listing with slug "${slug}"` }, { status: 404 });

  if (listing.pricingModel === 'free') {
    return NextResponse.json(
      { error: 'free listings install directly via POST /api/marketplace/installs — no charge boundary' },
      { status: 400 },
    );
  }
  if (listing.pricingModel === 'usage') {
    return NextResponse.json(
      { error: 'usage-priced listings have no up-front checkout — they charge at the period roll-up (not yet wired)' },
      { status: 400 },
    );
  }

  const versions = getVersions(listing.listingId);
  const target = version ? versions.find((v) => v.version === version) : versions.find((v) => v.version === listing.latestVersion) ?? versions[0];
  if (!target) return NextResponse.json({ error: `no such version for "${slug}"` }, { status: 404 });

  const gate = canInstall({ listingStatus: listing.status, versionStatus: target.status });
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 409 });

  try {
    const session = await createMarketplaceCheckoutSession({
      tenantId: tenantOf(req),
      userId: 'dashboard-operator',
      slug: listing.slug,
      listingId: listing.listingId,
      version: target.version,
      pricingModel: listing.pricingModel,
      title: listing.title,
      priceUsd: listing.priceUsd,
      currency: listing.currency,
    });
    return NextResponse.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[marketplace/checkout] failed:', err);
    return NextResponse.json({ error: 'could not start checkout' }, { status: 502 });
  }
}
