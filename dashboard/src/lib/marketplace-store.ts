// Marketplace catalog + install store — the dashboard's stand-in for the
// deferred DB layer (ADR-019 implementation checklist #1: db.ts schemas +
// marketplace-store.ts in the gateway). Until that lands there is no
// marketplace collection anywhere, so this module:
//
//   - seeds the CATALOG from the ADR-019 fixtures on disk
//     (runtime/src/marketplace/fixtures/listings.json — single source of
//     truth, read through the AI_ROOT mount in Docker / the sibling dir in a
//     checkout), falling back to a bundled copy of the same fixtures where
//     the repo isn't mounted (Vercel);
//   - synthesises one ListingVersion per listing (the fixtures carry
//     `latestVersion` but no versions file) with a clearly-labelled
//     fixture manifest hash — NOT a real integrity anchor;
//   - keeps INSTALLS in process memory (globalThis, HMR-safe), every write
//     gated through the ADR-019 state machines (canInstall / free-tier /
//     canTransitionInstall) and scoped to the installer tenant (ADR-010).
//
// Installs therefore reset on dashboard restart — acceptable for the
// free-tier catalog surface; the gateway store swap is where durability
// arrives. NEVER import from a Client Component (pulls in node:fs).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  canInstall,
  canInstallFreeTier,
  canTransitionInstall,
  canTransitionVersion,
  diffDeclaredTools,
  type DeclaredToolsDiff,
  type Install,
  type InstallStatus,
  type ListingVersion,
  type MarketplaceListing,
} from '@/lib/marketplace';

// Bundled mirror of runtime/src/marketplace/fixtures/listings.json — used only
// when the repo mount is absent. Update together with the fixtures.
const FALLBACK_LISTINGS: MarketplaceListing[] = [
  {
    creatorTenantId: 'tenant-acme', listingId: 'lst_seo_auditor', slug: 'seo-auditor', kind: 'agent',
    title: 'SEO Auditor', summary: 'Crawls a Next.js site and reports Core Web Vitals + on-page SEO fixes.',
    status: 'published', pricingModel: 'one_time', priceUsd: 29.0, currency: 'USD', revenueShareBps: 7000,
    category: 'analysis', tags: ['seo', 'performance', 'nextjs'], latestVersion: '1.2.0',
    installCount: 214, ratingAvg: 4.6, ratingCount: 38, createdBy: 'user-acme-owner',
    publishedAt: '2028-02-11T09:00:00.000Z', createdAt: '2028-01-30T12:00:00.000Z', updatedAt: '2028-03-01T08:00:00.000Z',
  },
  {
    creatorTenantId: 'tenant-nimbus', listingId: 'lst_pg_migrator', slug: 'postgres-migrator', kind: 'skill',
    title: 'Postgres Migrator', summary: 'Generates and verifies safe up/down SQL migrations from a schema diff.',
    status: 'published', pricingModel: 'subscription', priceUsd: 9.0, currency: 'USD', revenueShareBps: 7000,
    category: 'database', tags: ['postgres', 'migration', 'sql'], latestVersion: '0.9.1',
    installCount: 51, ratingAvg: 4.2, ratingCount: 11, createdBy: 'user-nimbus-dev',
    publishedAt: '2028-04-02T14:30:00.000Z', createdAt: '2028-03-20T10:00:00.000Z', updatedAt: '2028-04-10T16:00:00.000Z',
  },
  {
    creatorTenantId: 'tenant-acme', listingId: 'lst_changelog_bot', slug: 'changelog-bot', kind: 'skill',
    title: 'Changelog Bot', summary: 'Free skill: generates Keep-a-Changelog entries from conventional commits.',
    status: 'published', pricingModel: 'free', priceUsd: 0.0, currency: 'USD', revenueShareBps: 7000,
    category: 'content', tags: ['changelog', 'git', 'docs'], latestVersion: '2.0.0',
    installCount: 903, ratingAvg: 4.9, ratingCount: 120, createdBy: 'user-acme-owner',
    publishedAt: '2027-12-01T00:00:00.000Z', createdAt: '2027-11-15T00:00:00.000Z', updatedAt: '2028-01-01T00:00:00.000Z',
  },
  {
    creatorTenantId: 'tenant-nimbus', listingId: 'lst_load_tester', slug: 'load-tester', kind: 'agent',
    title: 'Load Tester', summary: 'Usage-priced: drives k6 load profiles against an API and reports p95/p99.',
    status: 'in_review', pricingModel: 'usage', priceUsd: 0.0, currency: 'USD', revenueShareBps: 6500,
    category: 'performance', tags: ['load', 'k6', 'latency'],
    installCount: 0, ratingAvg: 0, ratingCount: 0, createdBy: 'user-nimbus-dev',
    createdAt: '2028-05-01T11:00:00.000Z', updatedAt: '2028-05-01T11:00:00.000Z',
  },
];

const FIXTURES_RELPATH = ['runtime', 'src', 'marketplace', 'fixtures', 'listings.json'];

function fixturesPath(): string {
  // Docker: AI_ROOT=/app/AI (repo mount). Checkout/vitest: cwd=dashboard/, repo root is one up.
  const root = process.env.AI_ROOT || path.join(process.cwd(), '..');
  return path.join(root, ...FIXTURES_RELPATH);
}

function loadListings(): MarketplaceListing[] {
  try {
    const raw = fs.readFileSync(fixturesPath(), 'utf8');
    const parsed = JSON.parse(raw) as MarketplaceListing[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    /* repo not mounted (Vercel) — fall through to the bundled mirror */
  }
  return FALLBACK_LISTINGS.map((l) => ({ ...l }));
}

// Baseline declaredTools per listing (fixture stand-in for a real manifest's
// capabilities.declaredTools — ADR-027 §2 / ADR-028 §2). Every listing not
// named here falls back to a generic ['read'] declaration.
const BASE_DECLARED_TOOLS: Record<string, string[]> = {
  'lst_seo_auditor': ['read', 'webfetch'],
  'lst_pg_migrator': ['read', 'grep'],
  'lst_changelog_bot': ['read'],
  'lst_load_tester': ['read', 'bash'],
};

// One seeded resubmission (ADR-028 §4's own worked example): a listing that
// already has an approved/published version gets a second, in_review version
// that WIDENS declaredTools — proving the review-queue diff has something
// real to flag ("this version adds webfetch") without waiting on a live
// publish flow.
const RESUBMISSIONS: Record<string, { version: string; addedTools: string[]; changelog: string }> = {
  'lst_pg_migrator': {
    version: '1.0.0',
    addedTools: ['bash'],
    changelog: 'Adds an auto-apply mode that shells out to run the generated migration.',
  },
};

function synthesizeVersions(listings: MarketplaceListing[]): Map<string, ListingVersion[]> {
  const byListing = new Map<string, ListingVersion[]>();
  for (const l of listings) {
    const version = l.latestVersion ?? '0.1.0';
    const declaredTools = BASE_DECLARED_TOOLS[l.listingId] ?? ['read'];
    const versions: ListingVersion[] = [
      {
        creatorTenantId: l.creatorTenantId,
        listingId: l.listingId,
        version,
        // A published listing's latest version is published; anything earlier
        // in the listing lifecycle carries an in_review version.
        status: l.status === 'published' ? 'published' : 'in_review',
        manifestHash: `sha256:fixture-${l.slug}-${version}`,
        changelog: 'Seed version (ADR-019 fixtures — no artifact hosting yet).',
        artifactUri: `fixture://${l.slug}/${version}`,
        declaredTools,
        publishedAt: l.publishedAt,
        createdAt: l.createdAt,
      },
    ];

    const resubmission = RESUBMISSIONS[l.listingId];
    if (resubmission) {
      versions.push({
        creatorTenantId: l.creatorTenantId,
        listingId: l.listingId,
        version: resubmission.version,
        status: 'in_review',
        manifestHash: `sha256:fixture-${l.slug}-${resubmission.version}`,
        changelog: resubmission.changelog,
        artifactUri: `fixture://${l.slug}/${resubmission.version}`,
        declaredTools: [...declaredTools, ...resubmission.addedTools],
        createdAt: new Date(new Date(l.createdAt).getTime() + 1000).toISOString(),
      });
    }
    byListing.set(l.listingId, versions);
  }
  return byListing;
}

interface MarketplaceState {
  listings: MarketplaceListing[];
  versions: Map<string, ListingVersion[]>;
  installs: Map<string, Install>; // installId → Install
}

// globalThis cache: one store per server process, survives Next dev HMR.
const globalStore = globalThis as unknown as { __myaiMarketplace?: MarketplaceState };

function state(): MarketplaceState {
  if (!globalStore.__myaiMarketplace) {
    const listings = loadListings();
    globalStore.__myaiMarketplace = {
      listings,
      versions: synthesizeVersions(listings),
      installs: new Map(),
    };
  }
  return globalStore.__myaiMarketplace;
}

/** Test hook — drops the singleton so each suite starts from the fixtures. */
export function __resetMarketplaceStore(): void {
  globalStore.__myaiMarketplace = undefined;
}

// ── Catalog reads ─────────────────────────────────────────

export function getCatalog(): MarketplaceListing[] {
  return state().listings;
}

export function getListingBySlug(slug: string): MarketplaceListing | undefined {
  return state().listings.find((l) => l.slug === slug);
}

export function getVersions(listingId: string): ListingVersion[] {
  return state().versions.get(listingId) ?? [];
}

export function getLatestVersion(listing: MarketplaceListing): ListingVersion | undefined {
  const versions = getVersions(listing.listingId);
  return versions.find((v) => v.version === listing.latestVersion) ?? versions[0];
}

// ── Review queue (operator-facing, ADR-028 §4) ────────────
//
// Not tenant-scoped — a platform reviewer sees submissions across every
// creator tenant, same posture as the fixtures' `in_review` seed data.

export interface ReviewQueueEntry {
  listing: MarketplaceListing;
  version: ListingVersion;
  /** The listing's prior approved/published version, if this is a resubmission. */
  priorApproved?: ListingVersion;
  declaredToolsDiff: DeclaredToolsDiff;
}

/** Every ListingVersion currently awaiting review, oldest submission first. */
export function listReviewQueue(): ReviewQueueEntry[] {
  const entries: ReviewQueueEntry[] = [];
  for (const listing of state().listings) {
    const versions = getVersions(listing.listingId);
    for (const version of versions) {
      if (version.status !== 'in_review') continue;
      const priorApproved = versions.find(
        (v) => v.version !== version.version && (v.status === 'approved' || v.status === 'published'),
      );
      entries.push({
        listing,
        version,
        priorApproved,
        declaredToolsDiff: diffDeclaredTools(version.declaredTools, priorApproved?.declaredTools),
      });
    }
  }
  return entries.sort((a, b) => a.version.createdAt.localeCompare(b.version.createdAt));
}

export function getReviewQueueEntry(listingId: string, version: string): ReviewQueueEntry | undefined {
  return listReviewQueue().find((e) => e.listing.listingId === listingId && e.version.version === version);
}

/** Apply a reviewer's approve/reject decision to an `in_review` ListingVersion. */
export function reviewListingVersion(input: {
  listingId: string;
  version: string;
  to: 'approved' | 'draft'; // draft = reject, per the version transition table
  reviewedBy: string;
}): StoreResult<ListingVersion> {
  const versions = getVersions(input.listingId);
  const target = versions.find((v) => v.version === input.version);
  if (!target) return { ok: false, status: 404, error: 'listing version not found' };

  const gate = canTransitionVersion(target.status, input.to);
  if (!gate.ok) return { ok: false, status: 409, error: gate.reason! };

  target.status = input.to;
  target.reviewedBy = input.reviewedBy;
  return { ok: true, value: target };
}

// ── Install reads (tenant-scoped) ─────────────────────────

export function listInstallsForTenant(tenantId: string): Install[] {
  return [...state().installs.values()].filter((i) => i.installerTenantId === tenantId);
}

/** The tenant's live (not uninstalled) install of a listing, if any. */
export function getLiveInstall(tenantId: string, listingId: string): Install | undefined {
  return listInstallsForTenant(tenantId).find(
    (i) => i.listingId === listingId && i.status !== 'uninstalled',
  );
}

// ── Writes — every one gated by the ADR-019 state machines ─

export type StoreResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export function createInstall(input: {
  tenantId: string;
  userId: string;
  slug: string;
  version?: string;
}): StoreResult<Install> {
  const listing = getListingBySlug(input.slug);
  if (!listing) return { ok: false, status: 404, error: `no listing with slug "${input.slug}"` };

  const versions = getVersions(listing.listingId);
  const target = input.version
    ? versions.find((v) => v.version === input.version)
    : getLatestVersion(listing);
  if (!target) return { ok: false, status: 404, error: `no such version for "${input.slug}"` };

  // One live install per tenant per listing — reinstall only after uninstall
  // (uninstalled is terminal; a reinstall is a NEW install row).
  if (getLiveInstall(input.tenantId, listing.listingId)) {
    return { ok: false, status: 409, error: 'already installed for this tenant' };
  }

  // ADR-019 install gate (listing published + version published) …
  const gate = canInstall({ listingStatus: listing.status, versionStatus: target.status });
  if (!gate.ok) return { ok: false, status: 409, error: gate.reason! };
  // … narrowed to this release's free-tier scope (no charge boundary yet).
  const freeGate = canInstallFreeTier(listing, target.status);
  if (!freeGate.ok) return { ok: false, status: 402, error: freeGate.reason! };

  const now = new Date().toISOString();
  const install: Install = {
    installerTenantId: input.tenantId,
    installId: `inst_${randomUUID()}`,
    listingId: listing.listingId,
    version: target.version,
    status: 'active',
    installedBy: input.userId,
    pricePaidUsd: 0,
    installedAt: now,
    updatedAt: now,
  };
  state().installs.set(install.installId, install);
  listing.installCount += 1;
  return { ok: true, value: install };
}

export function transitionInstall(input: {
  tenantId: string;
  installId: string;
  to: InstallStatus;
}): StoreResult<Install> {
  const install = state().installs.get(input.installId);
  // Tenant scoping: another tenant's install is indistinguishable from absent.
  if (!install || install.installerTenantId !== input.tenantId) {
    return { ok: false, status: 404, error: 'install not found' };
  }
  const gate = canTransitionInstall(install.status, input.to);
  if (!gate.ok) return { ok: false, status: 409, error: gate.reason! };

  install.status = input.to;
  install.updatedAt = new Date().toISOString();
  return { ok: true, value: install };
}
