/**
 * Runtime catalog + install store for the `marketplace_search` /
 * `marketplace_install` MCP tools (ADR-019 Implementation checklist item #2's
 * remaining scope). Real artifact-hosting bytes (ADR-029) blocked item #2 on
 * "no bucket/CDN provisioned" — but ADR-029 §2 already shipped the LOCAL
 * filesystem backend for the self-hosted default tenant
 * (`artifact-store.ts`'s `LocalFilesystemArtifactStore`), so search/install
 * can ship now scoped to THAT backend; the S3/CDN production backend is a
 * later swap-in behind the same `ArtifactStore` interface, not a blocker.
 *
 * Catalog: the same four listings as `fixtures/listings.json` (the ADR-019
 * spec fixtures dashboard/src/lib/marketplace-store.ts also seeds from),
 * kept inline here rather than imported — `tsc` does not copy non-`.ts`
 * assets into `dist/`, so a runtime `import` of the JSON would 404 in a
 * built image even though it resolves fine under `tsx`/vitest. Update both
 * together; drift is limited to display metadata (title/summary/pricing),
 * not model-layer shape.
 *
 * Unlike the dashboard's fixture mirror (which serves synthetic
 * `fixture://` artifact URIs with no bytes behind them), this module seeds
 * REAL bytes into the local `ArtifactStore`'s `published/` keyspace for
 * every `published` listing at first access, so `installListing` performs a
 * genuine ADR-029 §4 fetch-integrity re-check (`sha256(fetched) ===
 * manifestHash`) against the local backend rather than trusting a
 * placeholder hash with nothing to verify against.
 *
 * Installs are kept in-memory (globalThis-cached, ADR-010 tenant-scoped),
 * same "durable store is still checklist #1's open follow-up" posture
 * `listing-version-store.ts` already established for versions.
 */
import { randomUUID } from 'node:crypto';
import { canInstall, isListingDiscoverable } from './listing-lifecycle.js';
import type {
  Install,
  ListingKind,
  ListingVersion,
  MarketplaceListing,
  PricingModel,
  VersionStatus,
} from './types.js';
import {
  artifactKey,
  normalizeManifestHash,
  sha256Hex,
  LocalFilesystemArtifactStore,
  type ArtifactStore,
} from './artifact-store.js';

// ── Catalog seed (mirrors fixtures/listings.json) ─────────────────────────

const CATALOG_SEED: MarketplaceListing[] = [
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

/** Deterministic synthetic artifact body — same inputs always hash the same,
 *  so the seeded bytes and manifestHash stay stable across process restarts. */
function artifactBodyFor(listing: MarketplaceListing, version: string): string {
  return `# ${listing.title}\n\n${listing.summary}\n\nkind: ${listing.kind}\nslug: ${listing.slug}\nversion: ${version}\n`;
}

interface MarketplaceRuntimeState {
  listings: MarketplaceListing[];
  versions: Map<string, ListingVersion[]>; // listingId -> versions
  installs: Map<string, Install>; // installId -> Install
}

const globalStore = globalThis as unknown as { __myaiRuntimeMarketplace?: MarketplaceRuntimeState };

/**
 * Module-default backend: always the local filesystem store, deliberately
 * NOT `resolveArtifactStore()` (`artifact-store.ts`) — this module seeds
 * synthetic fixture bytes (see file header) at first access, and doing that
 * against a real hosted S3 bucket if `MARKETPLACE_ARTIFACT_BACKEND=s3` is
 * set for the actual publish/quota/sweep paths would write demo data into
 * production storage. Callers that need the hosted backend pass their own
 * `artifactStore` (every exported function here already takes one).
 */
const defaultArtifactStore = new LocalFilesystemArtifactStore();

async function seedState(artifactStore: ArtifactStore): Promise<MarketplaceRuntimeState> {
  const listings = CATALOG_SEED.map((l) => ({ ...l }));
  const versions = new Map<string, ListingVersion[]>();

  for (const listing of listings) {
    const version = listing.latestVersion ?? '0.1.0';
    const body = artifactBodyFor(listing, version);
    const manifestHash = `sha256:${sha256Hex(Buffer.from(body, 'utf8'))}`;
    const versionStatus: VersionStatus = listing.status === 'published' ? 'published' : 'in_review';

    // ADR-029 §3: only `published` versions' bytes live under the CDN/
    // fetchable `published/` prefix — seed real bytes there so install's
    // fetch-integrity re-check (§4) has genuine bytes to verify, not a
    // placeholder hash nothing was ever written for.
    const stage = versionStatus === 'published' ? 'published' : 'staging';
    const key = artifactKey(stage, manifestHash);
    if (versionStatus === 'published') {
      await artifactStore.put(key, Buffer.from(body, 'utf8'));
    }

    versions.set(listing.listingId, [{
      creatorTenantId: listing.creatorTenantId,
      listingId: listing.listingId,
      version,
      status: versionStatus,
      manifestHash,
      changelog: 'Seed catalog version — local artifact backend (ADR-029 §2 default).',
      artifactUri: key,
      declaredTools: ['read'],
      publishedAt: listing.publishedAt,
      createdAt: listing.createdAt,
    }]);
  }

  return { listings, versions, installs: new Map() };
}

async function getState(artifactStore: ArtifactStore): Promise<MarketplaceRuntimeState> {
  if (!globalStore.__myaiRuntimeMarketplace) {
    globalStore.__myaiRuntimeMarketplace = await seedState(artifactStore);
  }
  return globalStore.__myaiRuntimeMarketplace;
}

/** Test/ops helper: force a reseed, e.g. against a temp-dir artifact store
 *  isolated from the developer's real `~/.myai/marketplace-artifacts`. */
export async function resetMarketplaceStoreForTest(artifactStore: ArtifactStore = defaultArtifactStore): Promise<void> {
  globalStore.__myaiRuntimeMarketplace = await seedState(artifactStore);
}

// ── marketplace_search ─────────────────────────────────────

export interface CatalogFilter {
  q?: string;
  kind?: ListingKind;
  category?: string;
  limit?: number;
}

export interface MarketplaceSearchResult {
  listingId: string;
  slug: string;
  kind: ListingKind;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  pricingModel: PricingModel;
  priceUsd: number;
  currency: string;
  latestVersion?: string;
  installCount: number;
  ratingAvg: number;
  ratingCount: number;
}

/** Discoverable (published) listings only (ADR-019 §3), free-text q + exact
 *  kind/category filters, all ANDed — mirrors the dashboard catalog's
 *  `filterCatalog` (kept independent per-package, same behavior). */
export async function searchListings(
  filter: CatalogFilter = {},
  artifactStore: ArtifactStore = defaultArtifactStore,
): Promise<MarketplaceSearchResult[]> {
  const state = await getState(artifactStore);
  const q = filter.q?.trim().toLowerCase();
  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);

  return state.listings
    .filter((l) => isListingDiscoverable(l.status))
    .filter((l) => !filter.kind || l.kind === filter.kind)
    .filter((l) => !filter.category || l.category === filter.category)
    .filter((l) => {
      if (!q) return true;
      const haystack = [l.title, l.summary, l.slug, l.category, ...l.tags].join(' ').toLowerCase();
      return haystack.includes(q);
    })
    .slice(0, limit)
    .map((l) => ({
      listingId: l.listingId,
      slug: l.slug,
      kind: l.kind,
      title: l.title,
      summary: l.summary,
      category: l.category,
      tags: l.tags,
      pricingModel: l.pricingModel,
      priceUsd: l.priceUsd,
      currency: l.currency,
      latestVersion: l.latestVersion,
      installCount: l.installCount,
      ratingAvg: l.ratingAvg,
      ratingCount: l.ratingCount,
    }));
}

// ── marketplace_install ────────────────────────────────────

export interface InstallInput {
  tenantId: string;
  userId: string;
  slug: string;
  version?: string;
}

export type InstallOutcome =
  | { ok: true; install: Install }
  | { ok: false; reason: string };

/**
 * Install a published listing for `input.tenantId`. Gates, in order:
 *   1. listing/version exist and pass the ADR-019 §3 install gate (`canInstall`)
 *   2. `free` pricing only — paid listings route through the billing checkout
 *      flow (dashboard `/api/marketplace/checkout`), not this tool; installing
 *      a paid listing for $0 here would be a real billing bug, not a shortcut
 *   3. one live install per tenant per listing
 *   4. ADR-029 §4 fetch-integrity re-check against the local artifact backend
 *      — fetched bytes must hash to the version's `manifestHash`, fail closed
 */
export async function installListing(
  input: InstallInput,
  artifactStore: ArtifactStore = defaultArtifactStore,
): Promise<InstallOutcome> {
  const state = await getState(artifactStore);

  const listing = state.listings.find((l) => l.slug === input.slug);
  if (!listing) return { ok: false, reason: `no listing with slug "${input.slug}"` };

  const versions = state.versions.get(listing.listingId) ?? [];
  const target = input.version
    ? versions.find((v) => v.version === input.version)
    : (versions.find((v) => v.version === listing.latestVersion) ?? versions[0]);
  if (!target) return { ok: false, reason: `no such version for "${input.slug}"` };

  const gate = canInstall({ listingStatus: listing.status, versionStatus: target.status });
  if (!gate.ok) return { ok: false, reason: gate.reason! };

  if (listing.pricingModel !== 'free') {
    return {
      ok: false,
      reason: `listing "${listing.slug}" is ${listing.pricingModel}-priced — paid installs go through the billing checkout flow, not marketplace_install`,
    };
  }

  const alreadyInstalled = [...state.installs.values()].some(
    (i) => i.installerTenantId === input.tenantId && i.listingId === listing.listingId && i.status !== 'uninstalled',
  );
  if (alreadyInstalled) return { ok: false, reason: 'already installed for this tenant' };

  const artifactBytes = await artifactStore.get(artifactKey('published', target.manifestHash));
  if (!artifactBytes || sha256Hex(artifactBytes) !== normalizeManifestHash(target.manifestHash)) {
    return { ok: false, reason: 'artifact integrity check failed against the local artifact backend — refusing to install' };
  }

  const now = new Date().toISOString();
  const install: Install = {
    installerTenantId: input.tenantId,
    installId: `inst_${randomUUID()}`,
    listingId: listing.listingId,
    version: target.version,
    status: 'active',
    installedBy: input.userId,
    pricePaidUsd: 0,
    updatePolicy: 'manual', // ADR-034 §3 — auto-track eligibility is opt-in
    installedAt: now,
    updatedAt: now,
  };
  state.installs.set(install.installId, install);
  listing.installCount += 1;

  return { ok: true, install };
}

export async function listInstallsForTenant(
  tenantId: string,
  artifactStore: ArtifactStore = defaultArtifactStore,
): Promise<Install[]> {
  const state = await getState(artifactStore);
  return [...state.installs.values()].filter((i) => i.installerTenantId === tenantId);
}

// ── ADR-034 auto-update — reads/writes the sweep job + tenant approval need ──

/** Every install across every tenant — what the auto-update sweep iterates. */
export async function listAllInstalls(
  artifactStore: ArtifactStore = defaultArtifactStore,
): Promise<Install[]> {
  const state = await getState(artifactStore);
  return [...state.installs.values()];
}

export async function getListingById(
  listingId: string,
  artifactStore: ArtifactStore = defaultArtifactStore,
): Promise<MarketplaceListing | undefined> {
  const state = await getState(artifactStore);
  return state.listings.find((l) => l.listingId === listingId);
}

/** Every `ListingVersion` in the runtime catalog for one listing — distinct
 *  from `listing-version-store.ts`'s creator-submission/review-workflow
 *  versions; this is what `installListing` and the auto-update sweep both
 *  actually read installs' pinned/candidate versions from. */
export async function listCatalogVersionsForListing(
  listingId: string,
  artifactStore: ArtifactStore = defaultArtifactStore,
): Promise<ListingVersion[]> {
  const state = await getState(artifactStore);
  return state.versions.get(listingId) ?? [];
}

/**
 * Test/ops helper: publish (or, called again for the same version, upsert —
 * e.g. yanking) a `ListingVersion` into the runtime catalog (not
 * `listing-version-store.ts` — see `listCatalogVersionsForListing`), seeding
 * real bytes at the `published/` key so the sweep's post-fetch integrity
 * re-check has something genuine to verify against. Upserting-by-version
 * (rather than always appending) matters for a re-publish that only flips
 * `status` (e.g. `published` → `yanked`) — a duplicate row would leave the
 * OLD `published` entry as the one `Array.find` sees first, hiding the yank
 * from any caller keyed on version number. Bumps the listing's
 * `latestVersion` to match on a `published` write, mirroring what an
 * `approved → published` promotion would do.
 */
export async function publishCatalogVersionForTest(
  listingId: string,
  version: ListingVersion,
  artifactBytes: Buffer,
  artifactStore: ArtifactStore = defaultArtifactStore,
): Promise<void> {
  const state = await getState(artifactStore);
  const versions = state.versions.get(listingId) ?? [];
  const existingIndex = versions.findIndex((v) => v.version === version.version);
  if (existingIndex >= 0) {
    versions[existingIndex] = version;
  } else {
    versions.push(version);
  }
  state.versions.set(listingId, versions);
  if (version.status === 'published') {
    await artifactStore.put(artifactKey('published', version.manifestHash), artifactBytes);
    const listing = state.listings.find((l) => l.listingId === listingId);
    if (listing) listing.latestVersion = version.version;
  }
}

/**
 * Advance an install to a newer version, only after re-verifying the fetched
 * artifact bytes hash to the target's `manifestHash` (ADR-029 §4 / ADR-034
 * §4's "mid-apply failure" guard) — a hash mismatch leaves the install
 * pinned at its prior version, never half-updated. Clears any
 * `pendingVersion`. Used by both the auto-track's silent apply and a
 * tenant's explicit manual-track approval (`approveInstallUpdate`).
 */
export async function advanceInstallVersion(
  installId: string,
  targetVersion: ListingVersion,
  artifactStore: ArtifactStore = defaultArtifactStore,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const state = await getState(artifactStore);
  const install = state.installs.get(installId);
  if (!install) return { ok: false, reason: `no such install "${installId}"` };

  const artifactBytes = await artifactStore.get(artifactKey('published', targetVersion.manifestHash));
  if (!artifactBytes || sha256Hex(artifactBytes) !== normalizeManifestHash(targetVersion.manifestHash)) {
    return {
      ok: false,
      reason: 'artifact integrity check failed against the local artifact backend — refusing to apply update',
    };
  }

  install.version = targetVersion.version;
  install.pendingVersion = undefined;
  install.updatedAt = new Date().toISOString();
  return { ok: true };
}

/** Test/ops helper: set an install's ADR-034 §3 update-policy preference —
 *  what the dashboard's per-install opt-in toggle would eventually write. */
export async function setInstallUpdatePolicyForTest(
  installId: string,
  updatePolicy: Install['updatePolicy'],
  artifactStore: ArtifactStore = defaultArtifactStore,
): Promise<void> {
  const state = await getState(artifactStore);
  const install = state.installs.get(installId);
  if (!install) return;
  install.updatePolicy = updatePolicy;
}

/** Set (or clear, with `undefined`) an install's pending-approval version —
 *  the manual-track prompt state (ADR-034 §3). A no-op if the install
 *  doesn't exist (the sweep's own iteration already holds a live reference,
 *  so this only matters for a caller acting on a stale id). */
export async function setInstallPendingVersion(
  installId: string,
  pendingVersion: string | undefined,
  artifactStore: ArtifactStore = defaultArtifactStore,
): Promise<void> {
  const state = await getState(artifactStore);
  const install = state.installs.get(installId);
  if (!install) return;
  install.pendingVersion = pendingVersion;
  install.updatedAt = new Date().toISOString();
}

/** A tenant's explicit approval of a pending manual-track update (ADR-034
 *  §3) — advances the install through the same integrity-checked path the
 *  auto-track's silent apply uses. */
export async function approveInstallUpdate(
  installId: string,
  artifactStore: ArtifactStore = defaultArtifactStore,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const state = await getState(artifactStore);
  const install = state.installs.get(installId);
  if (!install) return { ok: false, reason: `no such install "${installId}"` };
  if (!install.pendingVersion) return { ok: false, reason: 'no pending update to approve' };

  const versions = state.versions.get(install.listingId) ?? [];
  const target = versions.find((v) => v.version === install.pendingVersion);
  if (!target) return { ok: false, reason: `pending version "${install.pendingVersion}" no longer exists` };

  return advanceInstallVersion(installId, target, artifactStore);
}
