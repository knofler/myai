// /marketplace/[slug] — listing detail: metadata, the version table with its
// integrity anchor (manifestHash), and the install panel driving the ADR-019
// install state machine. Non-published listings 404 — only `published` is
// discoverable, and delist/suspend grandfathers existing installs at the
// install row (this page simply stops being reachable for new ones).
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { PageHeader } from '@/components/page-header';
import { Badge, ListingVersionStatusBadge } from '@/components/ui/badge';
import { StatCard, Card } from '@/components/ui/card';
import { DataTable, type DataRow } from '@/components/ui/data-table';
import { MarketplaceInstallPanel } from '@/components/marketplace-install';
import { MarketplaceReviewsPanel } from '@/components/marketplace-reviews';
import {
  canInstallFreeTier,
  canReviewListing,
  formatPricing,
  isListingDiscoverable,
  type Install,
  type ListingVersion,
  type MarketplaceListing,
} from '@/lib/marketplace';
import { plural } from '@/lib/summary';
import {
  getLatestVersion,
  getListingBySlug,
  getLiveInstall,
  getReviewForTenant,
  getVersions,
  listReviewsForListing,
} from '@/lib/marketplace-store';
import { DEFAULT_TENANT_ID, TENANT_COOKIE } from '@/lib/tenant-cookie';

export const dynamic = 'force-dynamic';

/** The one-line answer (DESIGN_LANGUAGE §5.1) for a single listing: what this
 *  thing is, and where YOU stand with it — installed, disabled, or installable.
 *  A detail page describes one item, so it states a state, not a count. */
function listingSummary(
  listing: MarketplaceListing,
  latest: ListingVersion | undefined,
  install: Install | undefined,
  canInstall: boolean,
): string {
  const article = listing.kind === 'agent' ? 'an agent' : 'a skill';
  const version = latest ? `, latest version ${latest.version}` : ' with no published version yet';
  const reach =
    listing.installCount === 0
      ? 'nobody has installed it yet'
      : listing.ratingCount > 0
        ? `${plural(listing.installCount, 'tenant')} installed it and rated it ${listing.ratingAvg.toFixed(1)} out of 5`
        : `${plural(listing.installCount, 'tenant')} installed it, with no reviews yet`;
  const head = `${listing.title} is ${article} in ${listing.category}${version}, and ${reach}.`;

  let state: string;
  if (install) {
    state =
      install.status === 'active'
        ? `You have it installed and running on ${install.version}.`
        : `You have it installed on ${install.version} but switched off.`;
  } else if (canInstall) {
    state = 'You have not installed it. It is free to install right now.';
  } else if (!latest) {
    state = 'Nothing is installable here until a version is published.';
  } else {
    state = `You have not installed it. It is ${formatPricing(listing)} and checkout is not open yet.`;
  }

  return `${head} ${state}`;
}

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
  const reviews = listReviewsForListing(listing.listingId);
  const myReview = getReviewForTenant(tenantId, listing.listingId) ?? null;
  const reviewGate = canReviewListing(install);

  return (
    <div className="max-w-4xl mx-auto">
      <Link href="/marketplace" className="text-xs text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))]">
        ← Marketplace
      </Link>
      <div className="mt-2">
        <PageHeader
          icon="marketplace"
          title={listing.title}
          summary={listingSummary(listing, latest, install, gate.ok)}
          subtitle={listing.summary}
        >
          <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30">{formatPricing(listing)}</Badge>
          <Badge>{listing.kind}</Badge>
        </PageHeader>
      </div>

      {/* State before detail (§5.2) — same four facts, homepage tiles. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard
          label="Installs"
          value={listing.installCount}
          icon="apps"
          tone={listing.installCount > 0 ? 'ok' : 'muted'}
        />
        <StatCard
          label="Rating"
          value={listing.ratingCount > 0 ? listing.ratingAvg.toFixed(1) : '—'}
          sub={listing.ratingCount > 0 ? `${plural(listing.ratingCount, 'review')}` : 'no reviews yet'}
          icon="check"
          tone={listing.ratingCount > 0 ? 'ok' : 'muted'}
        />
        <StatCard
          label="Latest version"
          value={listing.latestVersion ?? '—'}
          icon="registry"
          tone={listing.latestVersion ? 'accent' : 'muted'}
        />
        <StatCard label="Category" value={listing.category} icon="marketplace" tone="muted" />
      </div>

      <Card title="Install" accent="emerald" className="mb-6">
        <div className="px-4 py-4">
          <MarketplaceInstallPanel
            slug={listing.slug}
            install={install ? { installId: install.installId, status: install.status, version: install.version } : null}
            gate={gate}
          />
          <p className="text-label text-zinc-600 mt-3">
            Installs run through the ADR-019 state machines (install gate → active ↔ disabled → uninstalled).
            Free tier only for now — charging, payouts and artifact hosting are deferred follow-ups.
          </p>
        </div>
      </Card>

      <DataTable
        title="Versions"
        meta={`publisher: ${listing.creatorTenantId}`}
        searchable={false}
        columns={[
          { label: 'Version', mobile: 'title' },
          { label: 'Status', mobile: 'badge' },
          { label: 'Manifest hash', mobile: 'detail' },
          { label: 'Changelog', mobile: 'detail' },
        ]}
        rows={versions.map((v): DataRow => ({
          id: v.version,
          search: v.version.toLowerCase(),
          cells: [
            <span className="font-mono text-[rgb(var(--text-primary))]">{v.version}</span>,
            <ListingVersionStatusBadge status={v.status} />,
            <span className="font-mono text-xs text-[rgb(var(--text-muted))] truncate max-w-[220px] inline-block" title={v.manifestHash}>{v.manifestHash}</span>,
            <span className="text-xs text-[rgb(var(--text-muted))]">{v.changelog}</span>,
          ],
        }))}
      />

      <div className="mt-4 flex flex-wrap gap-1.5">
        {listing.tags.map((t) => (
          <span key={t} className="text-label font-mono px-1.5 py-0.5 bg-[rgb(var(--bg-hover))] rounded text-[rgb(var(--text-secondary))]">{t}</span>
        ))}
      </div>

      <Card title="Reviews" meta={`★ ${listing.ratingAvg.toFixed(1)} (${listing.ratingCount})`} className="mt-6">
        <div className="px-4 py-4">
          <MarketplaceReviewsPanel slug={listing.slug} reviews={reviews} myReview={myReview} reviewGate={reviewGate} />
        </div>
      </Card>
    </div>
  );
}
