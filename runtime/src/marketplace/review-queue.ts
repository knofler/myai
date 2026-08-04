/**
 * Operator review-queue model layer (ADR-028 §4 / implementation checklist
 * item #4 — "review-queue UI surfacing manifest diffs, especially
 * `declaredTools` widening ... so a reviewer sees 'this version adds
 * webfetch' as a flagged diff, not buried prose in a changelog field").
 *
 * Pure composition over `listing-version-store.ts`'s reads/writes — no I/O
 * beyond the in-memory store, same "prove the rules before they touch
 * infrastructure" posture as `listing-lifecycle.ts`. The dashboard's review
 * route handlers call `listReviewQueue()`/`decideReview()`; this module is
 * where "what changed" is computed so the UI never has to re-derive it.
 */
import type { ListingVersion } from './types.js';
import {
  getPriorApprovedListingVersion,
  listAllInReviewListingVersions,
  reviewListingVersion,
  type ReviewDecisionInput,
} from './listing-version-store.js';

export interface DeclaredToolsDiff {
  /** Tools this submission declares that the prior approved/published version did not. */
  added: string[];
  /** Tools the prior version declared that this submission drops. */
  removed: string[];
}

/**
 * `current` vs `prior` declaredTools. `prior` is `undefined` for a listing's
 * first-ever submission (nothing to widen against — every declared tool is
 * "new" only in the trivial sense, so nothing is flagged).
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

export interface ReviewQueueEntry {
  version: ListingVersion;
  /** The listing's prior approved/published version, if this is a resubmission. */
  priorApproved?: ListingVersion;
  declaredToolsDiff: DeclaredToolsDiff;
}

/** Every ListingVersion awaiting review, each paired with its widening diff. */
export function listReviewQueue(): ReviewQueueEntry[] {
  return listAllInReviewListingVersions().map((version) => {
    const priorApproved = getPriorApprovedListingVersion(version.creatorTenantId, version.listingId);
    return {
      version,
      priorApproved,
      declaredToolsDiff: diffDeclaredTools(version.declaredTools, priorApproved?.declaredTools),
    };
  });
}

/** One queue entry, for the review-queue detail view. */
export function getReviewQueueEntry(
  creatorTenantId: string,
  listingId: string,
  version: string,
): ReviewQueueEntry | undefined {
  return listReviewQueue().find(
    (e) => e.version.creatorTenantId === creatorTenantId && e.version.listingId === listingId && e.version.version === version,
  );
}

/** Apply a reviewer's approve/reject decision — thin re-export as the queue's write seam. */
export function decideReview(input: ReviewDecisionInput): ListingVersion {
  return reviewListingVersion(input);
}
