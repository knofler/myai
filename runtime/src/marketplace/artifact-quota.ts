/**
 * ADR-029 §6 — per-creatorTenantId marketplace-artifact storage quota, a gate
 * on NEW uploads only. Evicting existing `published` bytes to make room is
 * explicitly ruled out (§6, and the ADR's own Risk table: "quota enforcement
 * evicts old artifacts to make room for new ones" — flagged as an "easy but
 * retention-breaking implementation shortcut" to avoid). Implementation
 * checklist item #4.
 *
 * Mirrors the pure-verdict / I/O-usage-getter split `core/entitlements.ts`
 * already established for other plan-tiered business-action gates, and
 * reuses that module's `nextPlan()` tier order rather than re-deriving it —
 * "reusing PLAN_LIMITS-style tiering (core/billing.ts) the way ADR-017 §4 did
 * for the hosted brain" (ADR-029 §6 / checklist #4), applied here as the
 * marketplace-artifact analog rather than a new tiering mechanism.
 *
 * Quota counts only `published/` bytes, never `staging/` (§6: "a creator
 * mid-review cycle isn't penalized for an in-flight submission against their
 * durable cap" — `staging/`'s own bound is the TTL sweep,
 * `scheduler/marketplace-staging-sweep.ts`, not this quota).
 */
import type { TenantPlan } from '../shared/db.js';
import { nextPlan } from '../core/entitlements.js';
import { artifactKey, LocalFilesystemArtifactStore, type ArtifactStore } from './artifact-store.js';
import { listPublishedListingVersionsForTenant } from './listing-version-store.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'marketplace-artifact-quota' });

export interface MarketplaceStorageLimits {
  /** Free tenants can install, not create — publishing is a paid-tier
   *  capability (ADR-013's `marketplace.publish` is creator-owner/admin-only
   *  in the first place). Mirrors `PlanLimits.hostedBrain: false`. */
  publishEntitled: boolean;
  /** Cap on summed `published/` bytes across all listings owned by the
   *  creator tenant (-1 = unlimited, matching `PLAN_LIMITS.scale`'s existing
   *  convention for uncapped fields). Meaningless when `publishEntitled` is
   *  false (free tier isn't entitled to publish at all). */
  publishedBytesCap: number;
}

/** ADR-029 §6's table, verbatim: free (not entitled), solo 500MB, team 5GB,
 *  scale unlimited. */
export const MARKETPLACE_STORAGE_LIMITS: Readonly<Record<TenantPlan, MarketplaceStorageLimits>> = {
  free: { publishEntitled: false, publishedBytesCap: 0 },
  solo: { publishEntitled: true, publishedBytesCap: 500 * 1024 * 1024 },
  team: { publishEntitled: true, publishedBytesCap: 5 * 1024 * 1024 * 1024 },
  scale: { publishEntitled: true, publishedBytesCap: -1 },
} as const;

export interface ArtifactQuotaVerdict {
  allowed: boolean;
  plan: TenantPlan;
  /** -1 = unlimited. */
  capBytes: number;
  currentPublishedBytes: number;
  newArtifactBytes: number;
  upgradeTo: TenantPlan | null;
  message: string;
}

/**
 * Pure verdict — no I/O, fully unit-testable (mirrors `entitlements.ts`'s
 * `verdictFor`). `currentPublishedBytes` is the tenant's existing published
 * total; `newArtifactBytes` is the size of the upload being requested.
 */
export function verdictForArtifactUpload(
  plan: TenantPlan,
  currentPublishedBytes: number,
  newArtifactBytes: number,
): ArtifactQuotaVerdict {
  const limits = MARKETPLACE_STORAGE_LIMITS[plan] ?? MARKETPLACE_STORAGE_LIMITS.free;
  const upgradeCandidate = nextPlan(plan);

  if (!limits.publishEntitled) {
    return {
      allowed: false,
      plan,
      capBytes: limits.publishedBytesCap,
      currentPublishedBytes,
      newArtifactBytes,
      upgradeTo: upgradeCandidate,
      message: upgradeCandidate
        ? `plan '${plan}' is not entitled to publish marketplace artifacts — upgrade to ${upgradeCandidate} to enable creator uploads`
        : `plan '${plan}' is not entitled to publish marketplace artifacts`,
    };
  }

  const cap = limits.publishedBytesCap;
  const projected = currentPublishedBytes + newArtifactBytes;
  const allowed = cap < 0 || projected <= cap;
  const upgradeTo = allowed ? null : upgradeCandidate;
  const message = allowed
    ? `within plan limit (${projected}/${cap < 0 ? 'unlimited' : cap} published bytes)`
    : upgradeTo
      ? `plan '${plan}' allows ${cap} published bytes (this upload would reach ${projected}) — upgrade to ${upgradeTo} for more storage`
      : `plan '${plan}' allows ${cap} published bytes (this upload would reach ${projected})`;

  return { allowed, plan, capBytes: cap, currentPublishedBytes, newArtifactBytes, upgradeTo, message };
}

const defaultArtifactStore = new LocalFilesystemArtifactStore();

/**
 * Current summed `published/` bytes for a creator tenant, deduplicated by
 * `manifestHash` (ADR-029 §2: two listings that happen to produce
 * byte-identical artifacts share one object — summing per-`ListingVersion`
 * would double-count a shared blob).
 */
export async function currentPublishedBytesForTenant(
  creatorTenantId: string,
  artifactStore: ArtifactStore = defaultArtifactStore,
): Promise<number> {
  const versions = listPublishedListingVersionsForTenant(creatorTenantId);
  const uniqueHashes = new Set(versions.map((v) => v.manifestHash));

  let total = 0;
  for (const hash of uniqueHashes) {
    const size = await artifactStore.size(artifactKey('published', hash));
    if (size !== null) total += size;
  }
  return total;
}

/**
 * The gate the creators' upload path (`publish.ts`'s `publishSubmission`,
 * called from the `marketplace_publish` MCP tool) must call before accepting
 * bytes into `staging/` (ADR-029 §6: "enforced server-side, before accepting
 * an upload"). The same check must run again at the `staging → published`
 * promotion step once that's implemented (§6: "in case usage shifted between
 * submission and approval") — that follow-up should call this same function,
 * not a second copy of the comparison.
 */
export async function checkArtifactUploadQuota(
  creatorTenantId: string,
  plan: TenantPlan,
  newArtifactBytes: number,
  artifactStore: ArtifactStore = defaultArtifactStore,
): Promise<ArtifactQuotaVerdict> {
  const currentPublishedBytes = await currentPublishedBytesForTenant(creatorTenantId, artifactStore);
  const verdict = verdictForArtifactUpload(plan, currentPublishedBytes, newArtifactBytes);
  if (!verdict.allowed) {
    log.warn({ creatorTenantId, ...verdict }, 'marketplace artifact upload quota exceeded');
  }
  return verdict;
}
