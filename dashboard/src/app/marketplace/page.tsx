// /marketplace — the ADR-019 catalog browse surface: published listings only,
// free-text search + kind/category filters (all server-rendered GET params so
// the page works without client JS), cards linking to the listing detail.
// Free installs are live; paid listings render with their price but install
// behind the deferred-Stripe gate (see marketplace.ts canInstallFreeTier).
import Link from 'next/link';
import { cookies } from 'next/headers';
import { PageHeader } from '@/components/page-header';
import { Badge, PricingBadge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/card';
import { catalogCategories, filterCatalog, formatPricing, type ListingKind } from '@/lib/marketplace';
import { getCatalog, getLiveInstall } from '@/lib/marketplace-store';
import { plural, verb, cap } from '@/lib/summary';
import { DEFAULT_TENANT_ID, TENANT_COOKIE } from '@/lib/tenant-cookie';

export const dynamic = 'force-dynamic';

/** The one-line answer (DESIGN_LANGUAGE §5.1) — what is on the shelf and what
 *  of it is already yours, built only from the catalog this page already read. */
function marketplaceSummary(shown: number, total: number, installed: number, filtered: boolean): string {
  if (total === 0) {
    return 'Nothing is published in the marketplace yet. Agents and skills appear here once their listing goes live.';
  }
  const head = filtered
    ? shown === 0
      ? `Nothing matches this filter. The catalog has ${plural(total, 'published listing')} in all.`
      : `${plural(shown, 'listing')} ${verb(shown, 'matches', 'match')} your filter, out of ${total} published.`
    : `${plural(total, 'agent or skill', 'agents and skills')} ${verb(total, 'is', 'are')} published and ready to install.`;
  const tail =
    installed > 0
      ? ` You already have ${installed === 1 ? 'one of them' : `${installed} of them`} installed.`
      : '';
  return cap(head) + tail;
}

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
  // Same per-card lookup the grid below already does — counted once so the
  // header sentence can say what is already yours without a second source.
  const installedCount = listings.filter((l) => getLiveInstall(tenantId, l.listingId)).length;
  const isFiltered = Boolean(q || kind || category);
  // getCatalog() also holds draft/in_review/delisted rows — only discoverable
  // ones are "published", so the unfiltered total runs through the same filter.
  const publishedTotal = isFiltered ? filterCatalog(catalog).length : listings.length;

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader
        icon="marketplace"
        title="Marketplace"
        summary={marketplaceSummary(listings.length, publishedTotal, installedCount, isFiltered)}
        subtitle="Agents and skills you can install. Free installs are live, paid checkout is a follow-up."
      >
        <Link href="/marketplace/earnings" className="text-xs px-3 py-1.5 rounded-md bg-[rgb(var(--bg-hover))] border border-[rgb(var(--border-subtle))] text-[rgb(var(--text-primary))] hover:border-emerald-500/40">
          My earnings →
        </Link>
      </PageHeader>

      <form method="GET" action="/marketplace" className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="text"
          name="q"
          aria-label="Search listings by title, tag or category"
          defaultValue={q ?? ''}
          placeholder="Search listings by title, tag or category..."
          className="w-full max-w-md bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded-md px-4 py-2 text-sm text-[rgb(var(--text-primary))] placeholder:text-[rgb(var(--text-muted))] focus:outline-none focus:border-emerald-500/50 focus-visible:ring-2 focus-visible:ring-emerald-500/50 transition-colors"
        />
        {kind && <input type="hidden" name="kind" value={kind} />}
        {category && <input type="hidden" name="category" value={category} />}
        <button
          type="submit"
          className="px-3 py-2 text-sm rounded-md bg-[rgb(var(--bg-hover))] border border-[rgb(var(--border-subtle))] text-[rgb(var(--text-primary))] hover:border-emerald-500/40"
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
              kind === k ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-[rgb(var(--bg-surface))] text-[rgb(var(--text-secondary))] border-[rgb(var(--border-subtle))] hover:border-zinc-600'
            }`}
          >
            {k ? `${k}s` : 'all kinds'}
          </Link>
        ))}
        <span className="mx-1 text-[rgb(var(--text-muted))]">|</span>
        <Link
          href={chipHref({ q, kind: kindRaw })}
          className={`px-2.5 py-1 rounded-md border ${
            !category ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-[rgb(var(--bg-surface))] text-[rgb(var(--text-secondary))] border-[rgb(var(--border-subtle))] hover:border-zinc-600'
          }`}
        >
          all categories
        </Link>
        {categories.map((c) => (
          <Link
            key={c}
            href={chipHref({ q, kind: kindRaw, category: c })}
            className={`px-2.5 py-1 rounded-md border ${
              category === c ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-[rgb(var(--bg-surface))] text-[rgb(var(--text-secondary))] border-[rgb(var(--border-subtle))] hover:border-zinc-600'
            }`}
          >
            {c}
          </Link>
        ))}
      </div>

      <p className="text-meta text-[rgb(var(--text-muted))] mb-3">
        Showing {plural(listings.length, 'listing')}
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
                className="gel-surface tap-press bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded-xl p-4 hover:border-emerald-500/40 flex flex-col gap-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-sm text-[rgb(var(--text-primary))]">{l.title}</p>
                  <PricingBadge pricingModel={l.pricingModel}>{formatPricing(l)}</PricingBadge>
                </div>
                <p className="text-xs text-[rgb(var(--text-muted))] line-clamp-2">{l.summary}</p>
                <div className="flex flex-wrap items-center gap-1.5 mt-auto pt-1">
                  <Badge>{l.kind}</Badge>
                  <span className="text-label font-mono px-1.5 py-0.5 bg-[rgb(var(--bg-hover))] rounded text-[rgb(var(--text-secondary))]">{l.category}</span>
                  {installed && (
                    <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
                      installed{installed.status === 'disabled' ? ' · disabled' : ''}
                    </Badge>
                  )}
                  <span className="ml-auto text-label text-[rgb(var(--text-muted))]">
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
