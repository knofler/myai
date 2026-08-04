// /marketplace/[slug] — listing detail: metadata, the version table with its
// integrity anchor (manifestHash), and the install panel driving the ADR-019
// install state machine. Non-published listings 404 — only `published` is
// discoverable, and delist/suspend grandfathers existing installs at the
// install row (this page simply stops being reachable for new ones).
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, THead } from '@/components/ui/card';
import { MarketplaceInstallPanel } from '@/components/marketplace-install';
import { canInstallFreeTier, formatPricing, isListingDiscoverable } from '@/lib/marketplace';
import { getLatestVersion, getListingBySlug, getLiveInstall, getVersions } from '@/lib/marketplace-store';
import { DEFAULT_TENANT_ID, TENANT_COOKIE } from '@/lib/tenant-cookie';

export const dynamic = 'force-dynamic';

const VERSION_BADGE: Record<string, string> = {
  published: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  yanked: 'bg-red-500/15 text-red-400 border-red-500/30',
  in_review: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  approved: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  draft: 'bg-zinc-600/20 text-zinc-400 border-zinc-600/30',
};

export default async function MarketplaceListingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const listing = getListingBySlug(slug);
  if (!listing || !isListingDiscoverable(listing.status)) notFound();

  const tenantId = (await cookies()).get(TENANT_COOKIE)?.value || DEFAULT_TENANT_ID;
  const versions = getVersions(listing.listingId);
  const latest = getLatestVersion(listing);
  const gate = latest
    ? canInstallFreeTier(listing, latest.status)
    : { ok: false as const, reason: 'no published version' };
  const install = getLiveInstall(tenantId, listing.listingId);

  return (
    <div className="max-w-4xl mx-auto">
      <Link href="/marketplace" className="text-xs text-zinc-500 hover:text-zinc-300">
        ← Marketplace
      </Link>
      <div className="mt-2">
        <PageHeader title={listing.title} subtitle={listing.summary}>
          <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30">{formatPricing(listing)}</Badge>
          <Badge>{listing.kind}</Badge>
        </PageHeader>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6 text-sm">
        <div className="gel-surface bg-zinc-900/70 border border-zinc-800 rounded-xl p-3">
          <p className="text-[11px] text-zinc-500 uppercase tracking-wider">Installs</p>
          <p className="text-zinc-100 font-semibold mt-1">{listing.installCount}</p>
        </div>
        <div className="gel-surface bg-zinc-900/70 border border-zinc-800 rounded-xl p-3">
          <p className="text-[11px] text-zinc-500 uppercase tracking-wider">Rating</p>
          <p className="text-zinc-100 font-semibold mt-1">★ {listing.ratingAvg.toFixed(1)} <span className="text-zinc-500 font-normal">({listing.ratingCount})</span></p>
        </div>
        <div className="gel-surface bg-zinc-900/70 border border-zinc-800 rounded-xl p-3">
          <p className="text-[11px] text-zinc-500 uppercase tracking-wider">Latest</p>
          <p className="text-zinc-100 font-semibold mt-1">{listing.latestVersion ?? '—'}</p>
        </div>
        <div className="gel-surface bg-zinc-900/70 border border-zinc-800 rounded-xl p-3">
          <p className="text-[11px] text-zinc-500 uppercase tracking-wider">Category</p>
          <p className="text-zinc-100 font-semibold mt-1">{listing.category}</p>
        </div>
      </div>

      <Card title="Install" accent="emerald" className="mb-6">
        <div className="px-4 py-4">
          <MarketplaceInstallPanel
            slug={listing.slug}
            install={install ? { installId: install.installId, status: install.status, version: install.version } : null}
            gate={gate}
          />
          <p className="text-[11px] text-zinc-600 mt-3">
            Installs run through the ADR-019 state machines (install gate → active ↔ disabled → uninstalled).
            Free tier only for now — charging, payouts and artifact hosting are deferred follow-ups.
          </p>
        </div>
      </Card>

      <Card title="Versions" meta={`publisher: ${listing.creatorTenantId}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <THead cols={[{ label: 'Version' }, { label: 'Status' }, { label: 'Manifest hash' }, { label: 'Changelog' }]} />
            <tbody>
              {versions.map((v) => (
                <tr key={v.version} className="border-b border-zinc-800/60 last:border-0">
                  <td className="px-4 py-2.5 font-mono text-zinc-200">{v.version}</td>
                  <td className="px-4 py-2.5"><Badge className={VERSION_BADGE[v.status]}>{v.status}</Badge></td>
                  <td className="px-4 py-2.5 font-mono text-xs text-zinc-500 truncate max-w-[220px]" title={v.manifestHash}>{v.manifestHash}</td>
                  <td className="px-4 py-2.5 text-xs text-zinc-500">{v.changelog}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {listing.tags.map((t) => (
          <span key={t} className="text-[10px] font-mono px-1.5 py-0.5 bg-zinc-800 rounded text-zinc-400">{t}</span>
        ))}
      </div>
    </div>
  );
}
