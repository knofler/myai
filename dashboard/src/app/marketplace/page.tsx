// /marketplace — the ADR-019 catalog browse surface: published listings only,
// free-text search + kind/category filters (all server-rendered GET params so
// the page works without client JS), cards linking to the listing detail.
// Free installs are live; paid listings render with their price but install
// behind the deferred-Stripe gate (see marketplace.ts canInstallFreeTier).
import Link from 'next/link';
import { cookies } from 'next/headers';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/card';
import { catalogCategories, filterCatalog, formatPricing, type ListingKind } from '@/lib/marketplace';
import { getCatalog, getLiveInstall } from '@/lib/marketplace-store';
import { DEFAULT_TENANT_ID, TENANT_COOKIE } from '@/lib/tenant-cookie';

export const dynamic = 'force-dynamic';

const PRICING_BADGE: Record<string, string> = {
  free: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  one_time: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  subscription: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  usage: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
};

function chipHref(params: { q?: string; kind?: string; category?: string }): string {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.kind) search.set('kind', params.kind);
  if (params.category) search.set('category', params.category);
  const qs = search.toString();
  return qs ? `/marketplace?${qs}` : '/marketplace';
}

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; kind?: string; category?: string }>;
}) {
  const { q, kind: kindRaw, category } = await searchParams;
  const kind = kindRaw === 'agent' || kindRaw === 'skill' ? (kindRaw as ListingKind) : undefined;

  const tenantId = (await cookies()).get(TENANT_COOKIE)?.value || DEFAULT_TENANT_ID;
  const catalog = getCatalog();
  const listings = filterCatalog(catalog, { q, kind, category });
  const categories = catalogCategories(catalog);

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader
        title="Marketplace"
        subtitle="Browse & install agents and skills (ADR-019). Free installs are live — paid checkout and creator payouts are follow-ups."
      />

      <form method="GET" action="/marketplace" className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="text"
          name="q"
          defaultValue={q ?? ''}
          placeholder="Search listings by title, tag or category..."
          className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-md px-4 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50 transition-colors"
        />
        {kind && <input type="hidden" name="kind" value={kind} />}
        {category && <input type="hidden" name="category" value={category} />}
        <button
          type="submit"
          className="px-3 py-2 text-sm rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-emerald-500/40"
        >
          Search
        </button>
      </form>

      <div className="mb-6 flex flex-wrap items-center gap-1.5 text-xs">
        {[undefined, 'agent' as const, 'skill' as const].map((k) => (
          <Link
            key={k ?? 'all'}
            href={chipHref({ q, kind: k, category })}
            className={`px-2.5 py-1 rounded-md border ${
              kind === k ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:border-zinc-600'
            }`}
          >
            {k ? `${k}s` : 'all kinds'}
          </Link>
        ))}
        <span className="mx-1 text-zinc-700">|</span>
        <Link
          href={chipHref({ q, kind: kindRaw })}
          className={`px-2.5 py-1 rounded-md border ${
            !category ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:border-zinc-600'
          }`}
        >
          all categories
        </Link>
        {categories.map((c) => (
          <Link
            key={c}
            href={chipHref({ q, kind: kindRaw, category: c })}
            className={`px-2.5 py-1 rounded-md border ${
              category === c ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:border-zinc-600'
            }`}
          >
            {c}
          </Link>
        ))}
      </div>

      <p className="text-xs text-zinc-600 mb-3">
        {listings.length} listing{listings.length === 1 ? '' : 's'}
      </p>

      {listings.length === 0 ? (
        <EmptyState>No published listings match this filter.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {listings.map((l) => {
            const installed = getLiveInstall(tenantId, l.listingId);
            return (
              <Link
                key={l.listingId}
                href={`/marketplace/${l.slug}`}
                className="gel-surface tap-press bg-zinc-900 border border-zinc-800 rounded-xl p-4 hover:border-emerald-500/40 flex flex-col gap-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-sm text-zinc-100">{l.title}</p>
                  <Badge className={PRICING_BADGE[l.pricingModel]}>{formatPricing(l)}</Badge>
                </div>
                <p className="text-xs text-zinc-500 line-clamp-2">{l.summary}</p>
                <div className="flex flex-wrap items-center gap-1.5 mt-auto pt-1">
                  <Badge>{l.kind}</Badge>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 bg-zinc-800 rounded text-zinc-400">{l.category}</span>
                  {installed && (
                    <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
                      installed{installed.status === 'disabled' ? ' · disabled' : ''}
                    </Badge>
                  )}
                  <span className="ml-auto text-[11px] text-zinc-500">
                    ★ {l.ratingAvg.toFixed(1)} ({l.ratingCount}) · {l.installCount} installs
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
