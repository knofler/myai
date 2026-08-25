// Marketplace model layer — DASHBOARD MIRROR of the ADR-019 spec slice:
//      runtime/src/marketplace/types.ts
//      runtime/src/marketplace/listing-lifecycle.ts
// (kept in sync the same way billing.ts mirrors runtime/src/core/billing.ts —
// the dashboard's Docker build context is ./dashboard, so it cannot import
// across the package boundary). The transition tables and gates below MUST
// stay byte-equivalent in behaviour to the runtime layer; the unit tests in
// marketplace.test.ts assert the ADR-019 diagrams directly so drift is caught.
//
// Dashboard-only additions (NOT in the runtime layer) live below the mirror
// line: catalog search/filter helpers and the free-tier install gate — the
// catalog UI ships free installs only; one_time/subscription/usage charging is
// an ADR-019 follow-up (Stripe wiring), so paid listings render but can't be
// installed yet.

// ── Mirror: types.ts ──────────────────────────────────────

export type ListingKind = 'agent' | 'skill';
export type PricingModel = 'free' | 'one_time' | 'subscription' | 'usage';

export type ListingStatus =
  | 'draft'
  | 'in_review'
  | 'rejected'
  | 'approved'
  | 'published'
  | 'suspended'
  | 'delisted';

export type VersionStatus =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'published'
  | 'yanked';

export type InstallStatus =
  | 'active'
  | 'disabled'
  | 'uninstalled';

export interface MarketplaceListing {
  creatorTenantId: string;
  listingId: string;
  slug: string;
  kind: ListingKind;
  title: string;
  summary: string;
  status: ListingStatus;
  pricingModel: PricingModel;
  priceUsd: number;
  currency: string;
  revenueShareBps: number;
  category: string;
  tags: string[];
  latestVersion?: string;
  installCount: number;
  ratingAvg: number;
  ratingCount: number;
  createdBy: string;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListingVersion {
  creatorTenantId: string;
  listingId: string;
  version: string;
  status: VersionStatus;
  manifestHash: string;
  changelog: string;
  artifactUri: string;
  /** PackageCapabilities.declaredTools (ADR-027 §2), frozen from the manifest at submission. */
  declaredTools: string[];
  reviewedBy?: string;
  publishedAt?: string;
  createdAt: string;
}

export interface Install {
  installerTenantId: string;
  installId: string;
  listingId: string;
  version: string;
  status: InstallStatus;
  installedBy: string;
  pricePaidUsd: number;
  billingRef?: string;
  installedAt: string;
  updatedAt: string;
}

// ── Mirror: listing-lifecycle.ts ──────────────────────────

const LISTING_TRANSITIONS: Record<ListingStatus, readonly ListingStatus[]> = {
  draft: ['in_review'],
  in_review: ['approved', 'rejected'],
  rejected: ['draft'],
  approved: ['published'],
  published: ['suspended', 'delisted'],
  suspended: ['published', 'delisted'],
  delisted: [],
};

export function isListingDiscoverable(status: ListingStatus): boolean {
  return status === 'published';
}

const VERSION_TRANSITIONS: Record<VersionStatus, readonly VersionStatus[]> = {
  draft: ['in_review'],
  in_review: ['approved', 'draft'],
  approved: ['published'],
  published: ['yanked'],
  yanked: [],
};

const INSTALL_TRANSITIONS: Record<InstallStatus, readonly InstallStatus[]> = {
  active: ['disabled', 'uninstalled'],
  disabled: ['active', 'uninstalled'],
  uninstalled: [],
};

export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

function checkTransition<S extends string>(
  table: Record<S, readonly S[]>,
  from: S,
  to: S,
  label: string,
): TransitionResult {
  const allowed = table[from];
  if (!allowed) return { ok: false, reason: `unknown ${label} status: ${from}` };
  if (from === to) return { ok: false, reason: `${label} already in status ${to}` };
  if (!allowed.includes(to)) {
    return { ok: false, reason: `illegal ${label} transition: ${from} → ${to}` };
  }
  return { ok: true };
}

export function canTransitionListing(from: ListingStatus, to: ListingStatus): TransitionResult {
  return checkTransition(LISTING_TRANSITIONS, from, to, 'listing');
}

export function canTransitionVersion(from: VersionStatus, to: VersionStatus): TransitionResult {
  return checkTransition(VERSION_TRANSITIONS, from, to, 'version');
}

export function canTransitionInstall(from: InstallStatus, to: InstallStatus): TransitionResult {
  return checkTransition(INSTALL_TRANSITIONS, from, to, 'install');
}

export interface InstallEligibility {
  listingStatus: ListingStatus;
  versionStatus: VersionStatus;
}

export function canInstall({ listingStatus, versionStatus }: InstallEligibility): TransitionResult {
  if (listingStatus !== 'published') {
    return { ok: false, reason: `listing not installable in status ${listingStatus}` };
  }
  if (versionStatus !== 'published') {
    return { ok: false, reason: `version not installable in status ${versionStatus}` };
  }
  return { ok: true };
}

export const TRANSITION_TABLES = {
  listing: LISTING_TRANSITIONS,
  version: VERSION_TRANSITIONS,
  install: INSTALL_TRANSITIONS,
} as const;

// ═══ Dashboard-only catalog/UI helpers (not in the runtime mirror) ═══

/** Catalog search/filter input — everything optional, everything ANDed. */
export interface CatalogFilter {
  q?: string;
  kind?: ListingKind;
  category?: string;
}

/**
 * The browse query: discoverable (published) listings only, then free-text
 * match on title/summary/slug/tags, then exact kind/category. Pure so the
 * page, the API route, and the tests share one definition.
 */
export function filterCatalog(listings: MarketplaceListing[], filter: CatalogFilter = {}): MarketplaceListing[] {
  const q = filter.q?.trim().toLowerCase();
  return listings.filter((l) => {
    if (!isListingDiscoverable(l.status)) return false;
    if (filter.kind && l.kind !== filter.kind) return false;
    if (filter.category && l.category !== filter.category) return false;
    if (q) {
      const haystack = [l.title, l.summary, l.slug, l.category, ...l.tags].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/** Distinct categories across discoverable listings — the filter chip row. */
export function catalogCategories(listings: MarketplaceListing[]): string[] {
  return [...new Set(listings.filter((l) => isListingDiscoverable(l.status)).map((l) => l.category))].sort();
}

/**
 * The `POST /api/marketplace/installs` route's gate — direct, synchronous
 * installs for `free` listings only (no charge boundary at all: commerce
 * short-circuits). A paid listing (`one_time`/`subscription`/`usage`) does
 * NOT go through this path: `POST /api/marketplace/checkout` starts a Stripe
 * Checkout Session instead, and the Install row is only created once payment
 * completes, via `completeMarketplaceCharge` (ADR-019 §4 / checklist #3 —
 * `marketplace-billing.ts` + `marketplace-store.ts`).
 */
export function canInstallFreeTier(
  listing: Pick<MarketplaceListing, 'status' | 'pricingModel'>,
  versionStatus: VersionStatus,
): TransitionResult {
  const gate = canInstall({ listingStatus: listing.status, versionStatus });
  if (!gate.ok) return gate;
  if (listing.pricingModel !== 'free') {
    return {
      ok: false,
      reason: 'paid listings install via POST /api/marketplace/checkout (Stripe), not this direct-install route',
    };
  }
  return { ok: true };
}

/** UI actions on an existing install → target state (drives canTransitionInstall). */
export const INSTALL_ACTIONS: Record<'enable' | 'disable' | 'uninstall', InstallStatus> = {
  enable: 'active',
  disable: 'disabled',
  uninstall: 'uninstalled',
};

export type InstallAction = keyof typeof INSTALL_ACTIONS;

export function isInstallAction(value: unknown): value is InstallAction {
  return typeof value === 'string' && value in INSTALL_ACTIONS;
}

/** Human pricing label for cards/detail — money stays display-only here. */
export function formatPricing(listing: Pick<MarketplaceListing, 'pricingModel' | 'priceUsd'>): string {
  switch (listing.pricingModel) {
    case 'free':
      return 'Free';
    case 'one_time':
      return `$${listing.priceUsd} one-time`;
    case 'subscription':
      return `$${listing.priceUsd}/mo`;
    case 'usage':
      return 'Usage-based';
  }
}

// ═══ Ratings/reviews (dashboard-only — ADR-019 checklist #6, second half) ═══
//
// Out of scope for ADR-019 itself is *moderation* of reviews (flagging, an
// admin removal queue, spam filtering) — this is the plain data model +
// display half: one review per installerTenantId per listing (ADR-010 §1.5
// scoping, same posture as `Install`), a 1-5 integer star rating plus a
// comment, aggregated into the listing's `ratingAvg`/`ratingCount`.

export interface Review {
  installerTenantId: string;
  reviewId: string;
  listingId: string;
  rating: number; // integer 1-5
  comment: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function isValidRating(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
}

export const REVIEW_COMMENT_MAX_LENGTH = 2000;

export interface RatingSummary {
  ratingAvg: number;
  ratingCount: number;
}

/** Listing's `ratingAvg`/`ratingCount` are a pure derivation of its reviews — never hand-edited once reviews exist. */
export function summarizeRatings(reviews: readonly Pick<Review, 'rating'>[]): RatingSummary {
  if (reviews.length === 0) return { ratingAvg: 0, ratingCount: 0 };
  const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
  return { ratingAvg: Math.round((sum / reviews.length) * 10) / 10, ratingCount: reviews.length };
}

/**
 * Only a tenant with a live (non-uninstalled) install may leave a review —
 * mirrors the ADR-019 install gate's spirit (you must have actually used the
 * listing) without adding a new state machine. `install` is that tenant's
 * install of this listing, if any (undefined = never installed).
 */
export function canReviewListing(install: Pick<Install, 'status'> | undefined): TransitionResult {
  if (!install) return { ok: false, reason: 'install this listing before leaving a review' };
  if (install.status === 'uninstalled') return { ok: false, reason: 'reinstall this listing before leaving a review' };
  return { ok: true };
}

// ═══ Review-queue helpers (ADR-028 §4 — mirrors runtime/src/marketplace/review-queue.ts) ═══

export interface DeclaredToolsDiff {
  /** Tools this submission declares that the prior approved/published version did not. */
  added: string[];
  /** Tools the prior version declared that this submission drops. */
  removed: string[];
}

/**
 * `current` vs `prior` declaredTools — a resubmission's capability-widening
 * diff (ADR-028 §4). `prior` is `undefined` for a listing's first-ever
 * submission, so nothing is flagged as "added".
 */
export function diffDeclaredTools(
  current: readonly string[],
  prior: readonly string[] | undefined,
): DeclaredToolsDiff {
  if (!prior) return { added: [], removed: [] };
  const priorSet = new Set(prior);
  const currentSet = new Set(current);
  return {
    added: current.filter((t) => !priorSet.has(t)),
    removed: prior.filter((t) => !currentSet.has(t)),
  };
}
