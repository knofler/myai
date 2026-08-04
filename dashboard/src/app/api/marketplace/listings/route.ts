// GET /api/marketplace/listings?q=&kind=&category= — the catalog browse
// query (ADR-019 catalog axis). Only discoverable (published) listings are
// returned; filtering is the same pure filterCatalog the page uses.
import { NextRequest, NextResponse } from 'next/server';
import { catalogCategories, filterCatalog, type ListingKind } from '@/lib/marketplace';
import { getCatalog } from '@/lib/marketplace-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const kindRaw = params.get('kind') ?? undefined;
  if (kindRaw && kindRaw !== 'agent' && kindRaw !== 'skill') {
    return NextResponse.json({ error: 'kind must be "agent" or "skill"' }, { status: 400 });
  }

  const catalog = getCatalog();
  const listings = filterCatalog(catalog, {
    q: params.get('q') ?? undefined,
    kind: kindRaw as ListingKind | undefined,
    category: params.get('category') ?? undefined,
  });

  return NextResponse.json({ listings, categories: catalogCategories(catalog) });
}
