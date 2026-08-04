/**
 * ADR-029 §4 — the fetch-time artifact-integrity re-check, as one shared
 * helper (implementation checklist #3) so every consumption point (review
 * fetch, install flow, and the ADR-027 sandboxed-execution loader
 * immediately before invocation) calls the same comparison instead of
 * re-implementing it.
 *
 * `sha256(fetchedBytes) === ListingVersion.manifestHash` is the ONLY trusted
 * integrity check — the storage layer's own ETag is explicitly not trusted
 * (ADR-029 §4: "S3-style ETags are not guaranteed to be a plain content hash
 * ... a storage-layer detail, not an application-level guarantee tied to
 * manifestHash"). A mismatch aborts fail-closed (throws, never returns
 * partial trust) and is logged to the append-only `AuditEvent` trail
 * (checklist #5, ADR-013 posture, matching ADR-027's Repudiation-row
 * treatment of a denied tool call) before the throw, so the abort is never
 * silent.
 */
import type { AuditActor } from '../core/audit-log.js';
import { recordAuditEvent } from '../core/audit-log.js';
import { normalizeManifestHash, sha256Hex } from './artifact-store.js';

/** The three points ADR-029 §4 names as required callers of this check. */
export type ArtifactConsumptionPoint = 'review_fetch' | 'install_flow' | 'sandbox_loader';

export interface ArtifactHashRecheckContext {
  tenantId: string;
  listingId: string;
  version: string;
  /** Present when the check runs against a specific install (install flow, sandbox loader). */
  installId?: string;
  consumptionPoint: ArtifactConsumptionPoint;
  actor: AuditActor;
}

/** Thrown on a hash mismatch — the fail-closed abort ADR-029 §4 mandates. */
export class ArtifactIntegrityError extends Error {
  readonly code = 'ARTIFACT_HASH_MISMATCH';
  readonly expectedHash: string;
  readonly actualHash: string;

  constructor(message: string, expectedHash: string, actualHash: string) {
    super(message);
    this.name = 'ArtifactIntegrityError';
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

/**
 * Re-verify `fetchedBytes` against `manifestHash` (ADR-029 §4). Returns
 * silently on a match. On a mismatch, records a `marketplace.
 * artifact_hash_mismatch` `AuditEvent` (best-effort — audit is a side-record
 * per `recordAuditEvent`'s own contract, so a write failure never masks the
 * abort) and then throws `ArtifactIntegrityError`, which the caller must let
 * propagate — never catch-and-continue.
 */
export function recheckArtifactHash(
  fetchedBytes: Buffer,
  manifestHash: string,
  context: ArtifactHashRecheckContext,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const expectedHash = normalizeManifestHash(manifestHash);
  const actualHash = sha256Hex(fetchedBytes);
  if (actualHash === expectedHash) return;

  recordAuditEvent(
    {
      tenantId: context.tenantId,
      actor: context.actor,
      action: 'marketplace.artifact_hash_mismatch',
      target: `${context.listingId}@${context.version}`,
      detail: {
        consumptionPoint: context.consumptionPoint,
        installId: context.installId,
        expectedHash,
        actualHash,
      },
    },
    env,
  );

  throw new ArtifactIntegrityError(
    `artifact hash mismatch at ${context.consumptionPoint} for ${context.listingId}@${context.version}: ` +
      `expected sha256:${expectedHash}, got sha256:${actualHash} — aborting fail-closed (ADR-029 §4)`,
    expectedHash,
    actualHash,
  );
}
