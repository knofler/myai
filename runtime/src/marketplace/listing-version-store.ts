/**
 * In-memory `ListingVersion` store for the `marketplace_publish` MCP tool
 * (ADR-019 Implementation checklist item #2, ADR-028 §3's server-side check
 * re-run).
 *
 * ADR-019's `db.ts` schemas + persistent stores (Implementation checklist
 * item #1) are still open — this repo has no marketplace collections yet.
 * Rather than block the publish tool on that larger follow-up, this module
 * gives `publishSubmission` (publish.ts) somewhere real to write the
 * `in_review` row it produces, using the same in-memory-store posture the
 * codebase already uses for process-local, soak-only state (see
 * `monitoring/rbac-shadow-store.ts`). Swapping this for a `db.ts`-backed
 * store later is a drop-in — the exported functions are the seam.
 *
 * `listingId` is derived from the manifest's `slug` (ADR-028 §2: slug "matches
 * the catalog's uniqueness key so a submission maps 1:1 to a listing without
 * a separate rename step") — there is no separate `MarketplaceListing`
 * creation flow yet, so slug stands in as the join key for now.
 */
import type { ListingVersion, VersionStatus } from './types.js';
import { canTransitionVersion } from './listing-lifecycle.js';

function key(creatorTenantId: string, listingId: string, version: string): string {
  return `${creatorTenantId}::${listingId}::${version}`;
}

const store = new Map<string, ListingVersion>();

/** Test/ops helper: wipe the store. */
export function clearListingVersionStore(): void {
  store.clear();
}

/**
 * Test/ops helper: insert or overwrite a `ListingVersion` row directly,
 * bypassing the lifecycle-transition checks. Used to seed `published` rows
 * in tests — the `approved → published` promotion path (ADR-029 §3 step 3)
 * that would normally produce one is a separate, not-yet-implemented
 * follow-up (see `artifact-store.ts`'s header note).
 */
export function upsertListingVersionForTest(version: ListingVersion): void {
  store.set(key(version.creatorTenantId, version.listingId, version.version), version);
}

export function getListingVersion(
  creatorTenantId: string,
  listingId: string,
  version: string,
): ListingVersion | undefined {
  return store.get(key(creatorTenantId, listingId, version));
}

/**
 * Every version ever submitted for one listing, newest-created first.
 *
 * `createdAt` is millisecond-resolution (`Date().toISOString()`), so two
 * versions created in the same millisecond (a fast resubmission, or a burst
 * of test/seed writes) tie under `localeCompare`. `Array.sort` is stable, so
 * ties keep their pre-sort relative order — reversing the Map's insertion
 * order (oldest→newest) to newest→oldest *before* sorting makes that
 * stable-sort tiebreak resolve to "most recently created", not "oldest of
 * the tied group". Without this, `getPriorApprovedListingVersion` could pick
 * a stale approved baseline for the reviewer's declaredTools diff.
 */
export function listListingVersions(creatorTenantId: string, listingId: string): ListingVersion[] {
  const prefix = `${creatorTenantId}::${listingId}::`;
  return [...store.values()]
    .reverse()
    .filter((v) => key(v.creatorTenantId, v.listingId, v.version).startsWith(prefix))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface UpsertInReviewInput {
  creatorTenantId: string;
  listingId: string;
  version: string;
  manifestHash: string;
  changelog: string;
  artifactUri: string;
  declaredTools: string[];
}

/**
 * Create or refresh a version row and move it to `in_review`. Callers
 * (`publish.ts`) MUST have already rejected any resubmission that collides
 * with an already-`published`/`yanked` version — the semver/immutability
 * check (ADR-028 §3 item 3) is the gate for that, not this function. This
 * function only re-validates the mechanical version-lifecycle transition so
 * the two never drift.
 */
export function upsertInReviewListingVersion(input: UpsertInReviewInput): ListingVersion {
  const existing = getListingVersion(input.creatorTenantId, input.listingId, input.version);
  const now = new Date().toISOString();

  if (!existing) {
    const created: ListingVersion = {
      creatorTenantId: input.creatorTenantId,
      listingId: input.listingId,
      version: input.version,
      status: 'in_review',
      manifestHash: input.manifestHash,
      changelog: input.changelog,
      artifactUri: input.artifactUri,
      declaredTools: input.declaredTools,
      createdAt: now,
    };
    store.set(key(input.creatorTenantId, input.listingId, input.version), created);
    return created;
  }

  // Same version resubmitted while still `in_review` (e.g. a retried
  // submission) is a refresh, not a lifecycle transition — `in_review` →
  // `in_review` is illegal in the transition table by design (draft/version
  // lifecycle tables treat same-status as a no-op error, not a re-entry).
  const targetStatus: VersionStatus = 'in_review';
  if (existing.status !== targetStatus) {
    const result = canTransitionVersion(existing.status, targetStatus);
    if (!result.ok) {
      throw new Error(`cannot move ListingVersion ${input.listingId}@${input.version} to in_review: ${result.reason}`);
    }
  }

  const updated: ListingVersion = {
    ...existing,
    status: targetStatus,
    manifestHash: input.manifestHash,
    changelog: input.changelog,
    artifactUri: input.artifactUri,
    declaredTools: input.declaredTools,
  };
  store.set(key(input.creatorTenantId, input.listingId, input.version), updated);
  return updated;
}

/**
 * Every `published` ListingVersion owned by a creator tenant, across all of
 * their listings — what `artifact-quota.ts` sums bytes over (ADR-029 §6:
 * "summed across all owned listings' published/ bytes").
 */
export function listPublishedListingVersionsForTenant(creatorTenantId: string): ListingVersion[] {
  return [...store.values()].filter((v) => v.creatorTenantId === creatorTenantId && v.status === 'published');
}

// ── Review-queue reads/writes (ADR-028 §4 — the operator review-queue UI) ──

/** Every ListingVersion currently awaiting review, across all creator tenants. */
export function listAllInReviewListingVersions(): ListingVersion[] {
  return [...store.values()]
    .filter((v) => v.status === 'in_review')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The listing's most recently created approved-or-published version, if any —
 * what a reviewer diffs a resubmission's `declaredTools` against (ADR-028
 * §4). `published` versions are included alongside `approved` ones because an
 * already-live listing's currently-published version is the meaningful prior
 * state even before its `approved` predecessor is looked at.
 */
export function getPriorApprovedListingVersion(
  creatorTenantId: string,
  listingId: string,
): ListingVersion | undefined {
  return listListingVersions(creatorTenantId, listingId).find(
    (v) => v.status === 'approved' || v.status === 'published',
  );
}

export interface ReviewDecisionInput {
  creatorTenantId: string;
  listingId: string;
  version: string;
  /** `approved` or `draft` (reject → back to draft, per the version transition table). */
  to: Extract<VersionStatus, 'approved' | 'draft'>;
  reviewedBy: string;
}

/** Apply a reviewer's approve/reject decision to an `in_review` ListingVersion. */
export function reviewListingVersion(input: ReviewDecisionInput): ListingVersion {
  const existing = getListingVersion(input.creatorTenantId, input.listingId, input.version);
  if (!existing) {
    throw new Error(`no such ListingVersion ${input.listingId}@${input.version}`);
  }
  const result = canTransitionVersion(existing.status, input.to);
  if (!result.ok) {
    throw new Error(`cannot move ListingVersion ${input.listingId}@${input.version} to ${input.to}: ${result.reason}`);
  }
  const updated: ListingVersion = { ...existing, status: input.to, reviewedBy: input.reviewedBy };
  store.set(key(input.creatorTenantId, input.listingId, input.version), updated);
  return updated;
}
