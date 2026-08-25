/**
 * ADR-029 §3 step 3 — the `approved → published` promotion: copies the
 * reviewed object from `staging/` to `published/` and sets the final
 * `ListingVersion.artifactUri`. Previously an open follow-up (see
 * `listing-version-store.ts` / `artifact-store.ts` header notes); this
 * module implements it, with ADR-035's malware/static-analysis scan wired in
 * as a new, mandatory precondition inserted between ADR-029 §3 step 2
 * (reviewer fetches + reviews from `staging/`) and step 3 (the copy) —
 * exactly the placement ADR-035 §5 specifies:
 *
 *   1. version must be `approved` (mechanical lifecycle gate, unchanged)
 *   2. ADR-029 §6 quota re-check ("in case usage shifted between submission
 *      and approval" — artifact-quota.ts's own header note names this as
 *      the follow-up that should call its existing verdict function, not a
 *      second copy)
 *   3. NEW (ADR-035 §5 step 2a): malware scan, keyed/cached by manifestHash
 *        - clean            -> proceed
 *        - flagged          -> blocked UNLESS a reviewer override with a
 *                              justification was already recorded for this
 *                              manifestHash (`malware-scan.ts`'s
 *                              `overrideFlaggedVerdict`)
 *        - blocked          -> hard-fail, non-overridable, full stop
 *        - scanner unreachable -> fail closed, treated as blocking for this
 *          attempt only (not cached, so a retry gets a fresh scan)
 *   4. copy `staging/<hash>` bytes to `published/<hash>`, re-verify the
 *      round-tripped hash (ADR-029 §4's fetch-integrity re-check, same
 *      posture `publish.ts` already applies at upload time)
 *   5. flip the ListingVersion to `published` (`listing-version-store.ts`'s
 *      `promoteListingVersionToPublished`)
 *
 * A `blocked`/unresolved-`flagged` verdict or a scanner-unavailable event
 * means the version never gets a `published/` artifactUri — no code here
 * needs to special-case "don't set artifactUri", it simply never reaches
 * step 4 (ADR-035 §4's "double enforcement" note).
 */
import type { TenantPlan } from '../shared/db.js';
import type { AuditActor } from '../core/audit-log.js';
import type { ListingVersion } from './types.js';
import {
  artifactKey,
  normalizeManifestHash,
  sha256Hex,
  resolveArtifactStore,
  type ArtifactStore,
} from './artifact-store.js';
import { getListingVersion, promoteListingVersionToPublished } from './listing-version-store.js';
import { checkArtifactUploadQuota } from './artifact-quota.js';
import {
  runMalwareScan,
  getCachedScanVerdict,
  type MalwareScanner,
  defaultMalwareScanner,
} from './malware-scan.js';

export type PromotionCheck = 'not_found' | 'lifecycle' | 'quota' | 'malware_scan' | 'artifact_copy';

export interface PromotionRejection {
  check: PromotionCheck;
  reason: string;
  /** Present only for `check: 'malware_scan'` — lets the caller decide whether an override is even possible. */
  scanVerdict?: 'flagged' | 'blocked' | 'scanner_unavailable';
}

export type PromotionResult =
  | { ok: true; listingVersion: ListingVersion }
  | { ok: false; rejection: PromotionRejection };

export interface PromoteInput {
  creatorTenantId: string;
  listingId: string;
  version: string;
  /** The submitting tenant's plan — when present, the ADR-029 §6 re-check runs. Optional for tests that don't care about quota, mirrors `publish.ts`'s `PublishSubmission.plan`. */
  plan?: TenantPlan;
  /** A bundled dependency manifest's raw text, if any (ADR-035 §3 item 3 — supply-chain check input). */
  dependencyManifest?: string;
  actor: AuditActor;
}

const defaultArtifactStore = resolveArtifactStore();

/**
 * Run the ADR-029 §3 `approved → published` promotion, gated on ADR-035's
 * malware scan. `artifactStore`/`scanner` are injectable for tests; default
 * to the resolved production backends.
 */
export async function promoteApprovedListingVersion(
  input: PromoteInput,
  artifactStore: ArtifactStore = defaultArtifactStore,
  scanner: MalwareScanner = defaultMalwareScanner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PromotionResult> {
  const { creatorTenantId, listingId, version } = input;

  const existing = getListingVersion(creatorTenantId, listingId, version);
  if (!existing) {
    return { ok: false, rejection: { check: 'not_found', reason: `no such ListingVersion ${listingId}@${version}` } };
  }
  if (existing.status !== 'approved') {
    return {
      ok: false,
      rejection: { check: 'lifecycle', reason: `ListingVersion ${listingId}@${version} is "${existing.status}", not "approved" — promotion requires approved` },
    };
  }

  // ADR-029 §6: re-check quota — usage may have shifted between submission and approval
  // (artifact-quota.ts's own header note names this exact follow-up: reuse
  // `checkArtifactUploadQuota`, never a second copy of the comparison).
  if (input.plan) {
    const stagingBytes = await artifactStore.size(artifactKey('staging', existing.manifestHash));
    const quotaVerdict = await checkArtifactUploadQuota(creatorTenantId, input.plan, stagingBytes ?? 0, artifactStore);
    if (!quotaVerdict.allowed) {
      return { ok: false, rejection: { check: 'quota', reason: quotaVerdict.message } };
    }
  }

  const stagingKey = artifactKey('staging', existing.manifestHash);
  const stagedBytes = await artifactStore.get(stagingKey);
  if (stagedBytes === null) {
    return { ok: false, rejection: { check: 'artifact_copy', reason: `no staged bytes at ${stagingKey} — cannot promote` } };
  }

  // ── ADR-035 §5 step 2a: the mandatory malware-scan gate ──────────────────
  const scanOutcome = await runMalwareScan(
    { manifestHash: existing.manifestHash, artifactBytes: stagedBytes, dependencyManifest: input.dependencyManifest },
    { tenantId: creatorTenantId, listingId, version, actor: input.actor },
    scanner,
    env,
  );

  if (scanOutcome.kind === 'scanner_unavailable') {
    // ADR-035 §5a: fail closed — never treat "scan didn't run" as "scan passed".
    return {
      ok: false,
      rejection: {
        check: 'malware_scan',
        reason: `malware scanner unreachable — promotion blocked fail-closed (ADR-035 §5a): ${scanOutcome.reason}`,
        scanVerdict: 'scanner_unavailable',
      },
    };
  }

  const { result } = scanOutcome;
  if (result.verdict === 'blocked') {
    return {
      ok: false,
      rejection: {
        check: 'malware_scan',
        reason: `malware scan verdict "blocked" — non-overridable (ADR-035 §4), found: ${result.findings.map((f) => f.label).join('; ')}`,
        scanVerdict: 'blocked',
      },
    };
  }
  if (result.verdict === 'flagged') {
    const cached = getCachedScanVerdict(existing.manifestHash);
    if (!cached?.override) {
      return {
        ok: false,
        rejection: {
          check: 'malware_scan',
          reason:
            `malware scan verdict "flagged" — blocked pending reviewer override with justification (ADR-035 §4), ` +
            `found: ${result.findings.map((f) => f.label).join('; ')}`,
          scanVerdict: 'flagged',
        },
      };
    }
    // Overridden — fall through to promotion. The override event was already
    // audit-logged by `overrideFlaggedVerdict` at the time it was recorded.
  }
  // 'clean' falls straight through.

  // ── ADR-029 §3 step 3: copy staging/ -> published/, re-verify the hash ──
  const publishedKey = artifactKey('published', existing.manifestHash);
  await artifactStore.put(publishedKey, stagedBytes);

  const roundTripped = await artifactStore.get(publishedKey);
  if (roundTripped === null || sha256Hex(roundTripped) !== normalizeManifestHash(existing.manifestHash)) {
    return {
      ok: false,
      rejection: { check: 'artifact_copy', reason: 'published artifact bytes did not round-trip to manifestHash after the staging->published copy' },
    };
  }

  const listingVersion = promoteListingVersionToPublished(creatorTenantId, listingId, version, publishedKey);
  return { ok: true, listingVersion };
}
