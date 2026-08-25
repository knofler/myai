/**
 * ADR-034 — the auto-update background job for installed marketplace
 * packages (ADR-028 checklist #5). Polling on `ListingVersion` publish — the
 * ADR's own open scheduling-mechanics question ("What this ADR does not
 * decide"), picked for the first slice; event-driven-on-publish is a stated
 * future option, not built here.
 *
 * Not wired to an automatic in-process cron — an operator/cron invokes this
 * on a cadence, same posture as `marketplace-staging-sweep.ts`. Each install
 * is handled independently — one failure never blocks the rest.
 *
 * Per install: finds the highest-semver published, non-yanked candidate
 * version newer than the pinned one, classifies its bump, and applies
 * ADR-034's decision table (`marketplace/auto-update-policy.ts`) — the
 * capability diff it needs is `review-queue.ts`'s `diffDeclaredTools`, the
 * same computation review time already trusts, never a second
 * hand-maintained copy (ADR-034 §2).
 */
import { classifySemverBump, compareSemver, decideUpdateAction } from '../marketplace/auto-update-policy.js';
import { diffDeclaredTools } from '../marketplace/review-queue.js';
import { resolveArtifactStore, type ArtifactStore } from '../marketplace/artifact-store.js';
import type { ListingVersion } from '../marketplace/types.js';
import {
  advanceInstallVersion,
  getListingById,
  listAllInstalls,
  listCatalogVersionsForListing,
  setInstallPendingVersion,
} from '../marketplace/marketplace-store.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'marketplace-auto-update-sweep' });

export interface AutoUpdateSweepOptions {
  artifactStore?: ArtifactStore;
  env?: NodeJS.ProcessEnv;
}

export interface AutoUpdateSweepResult {
  ranAt: Date;
  scanned: number;
  applied: Array<{ installId: string; from: string; to: string }>;
  pending: Array<{ installId: string; pendingVersion: string; reason: string }>;
  /** A pending manual-track prompt withdrawn because its version was yanked
   *  before the tenant approved it (ADR-034 §4). */
  withdrawn: Array<{ installId: string; version: string }>;
  skipped: Array<{ installId: string; reason: string }>;
  failed: Array<{ installId: string; error: string }>;
}

/** Highest-semver `published`, non-`yanked` version strictly newer than
 *  `installedVersion`, or `undefined` if there is none — the auto-update
 *  job's downgrade guard (ADR-034 §4): a version that isn't strictly newer
 *  is never a candidate, on either track. */
function pickUpdateCandidate(installedVersion: string, versions: readonly ListingVersion[]): ListingVersion | undefined {
  let best: ListingVersion | undefined;
  for (const v of versions) {
    if (v.status !== 'published') continue;
    const bump = classifySemverBump(installedVersion, v.version);
    if (bump === 'same' || bump === 'downgrade') continue;
    if (!best || compareSemver(v.version, best.version) > 0) best = v;
  }
  return best;
}

export async function runMarketplaceAutoUpdateSweep(opts: AutoUpdateSweepOptions = {}): Promise<AutoUpdateSweepResult> {
  const env = opts.env ?? process.env;
  const artifactStore = opts.artifactStore ?? resolveArtifactStore(env);

  const result: AutoUpdateSweepResult = {
    ranAt: new Date(),
    scanned: 0,
    applied: [],
    pending: [],
    withdrawn: [],
    skipped: [],
    failed: [],
  };

  const installs = await listAllInstalls(artifactStore);

  for (const install of installs) {
    if (install.status !== 'active') continue;
    result.scanned += 1;

    try {
      const versions = await listCatalogVersionsForListing(install.listingId, artifactStore);

      // ADR-034 §4: a pending version yanked before approval withdraws the
      // prompt — the install stays on its current pinned version, and this
      // pass re-evaluates from scratch on the next sweep rather than
      // chasing a fresh candidate in the same pass.
      if (install.pendingVersion) {
        const pendingRow = versions.find((v) => v.version === install.pendingVersion);
        if (!pendingRow || pendingRow.status === 'yanked') {
          const withdrawnVersion = install.pendingVersion;
          await setInstallPendingVersion(install.installId, undefined, artifactStore);
          result.withdrawn.push({ installId: install.installId, version: withdrawnVersion });
          continue;
        }
      }

      const listing = await getListingById(install.listingId, artifactStore);
      if (!listing) {
        result.skipped.push({ installId: install.installId, reason: `no such listing "${install.listingId}"` });
        continue;
      }

      const candidate = pickUpdateCandidate(install.version, versions);
      if (!candidate) {
        result.skipped.push({ installId: install.installId, reason: 'already on the newest published version' });
        continue;
      }

      const currentVersionRow = versions.find((v) => v.version === install.version);
      const bump = classifySemverBump(install.version, candidate.version);
      const declaredToolsDiff = diffDeclaredTools(candidate.declaredTools, currentVersionRow?.declaredTools);
      const action = decideUpdateAction({ updatePolicy: install.updatePolicy, bump, declaredToolsDiff });

      switch (action.kind) {
        case 'apply': {
          const fromVersion = install.version;
          const outcome = await advanceInstallVersion(install.installId, candidate, artifactStore);
          if (outcome.ok) {
            result.applied.push({ installId: install.installId, from: fromVersion, to: candidate.version });
          } else {
            result.failed.push({ installId: install.installId, error: outcome.reason });
          }
          break;
        }
        case 'pending': {
          if (install.pendingVersion !== candidate.version) {
            await setInstallPendingVersion(install.installId, candidate.version, artifactStore);
          }
          result.pending.push({ installId: install.installId, pendingVersion: candidate.version, reason: action.reason });
          break;
        }
        case 'none':
          result.skipped.push({ installId: install.installId, reason: action.reason });
          break;
      }
    } catch (err) {
      log.error({ err, installId: install.installId }, 'marketplace-auto-update-sweep: install failed');
      result.failed.push({ installId: install.installId, error: (err as Error).message });
    }
  }

  log.info(
    {
      scanned: result.scanned,
      applied: result.applied.length,
      pending: result.pending.length,
      withdrawn: result.withdrawn.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    },
    'marketplace-auto-update-sweep: complete',
  );
  return result;
}
