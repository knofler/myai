// GET /api/marketplace/listings/[slug] — listing detail: the listing, its
// versions, the ADR-019 install gate verdict for the latest version, and the
// calling tenant's live install (cookie-scoped, ADR-010). Non-published
// listings 404 — discoverability is the catalog contract.
import { NextRequest, NextResponse } from 'next/server';
import { canInstallFreeTier, isListingDiscoverable } from '@/lib/marketplace';
import { getLatestVersion, getListingBySlug, getLiveInstall, getVersions } from '@/lib/marketplace-store';
import { DEFAULT_TENANT_ID, TENANT_COOKIE } from '@/lib/tenant-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const listing = getListingBySlug(slug);
  if (!listing || !isListingDiscoverable(listing.status)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const tenantId = req.cookies.get(TENANT_COOKIE)?.value || DEFAULT_TENANT_ID;
  const latest = getLatestVersion(listing);
  const gate = latest
    ? canInstallFreeTier(listing, latest.status)
    : { ok: false as const, reason: 'no published version' };

  return NextResponse.json({
    listing,
    versions: getVersions(listing.listingId),
    installGate: gate,
    install: getLiveInstall(tenantId, listing.listingId) ?? null,
  });
}
