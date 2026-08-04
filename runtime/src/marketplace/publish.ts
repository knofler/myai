/**
 * Server-side re-run of ADR-028 §3's four package-submission checks, plus
 * staging `ListingVersion` creation (ADR-019 Implementation checklist #2 —
 * the `marketplace_publish` MCP tool).
 *
 * ADR-028 §3: local `myai-marketplace validate`/`pack` (queued separately,
 * not implemented anywhere yet) is "advisory-fast, never authoritative" —
 * THIS module is the actual security boundary. It accepts the same
 * `pack()`-shaped manifest a future CLI would produce and re-runs the exact
 * four checks server-side, fail-fast in ADR-028's order:
 *   1. schema validity (manifest shape + manifestHash integrity)
 *   2. declaredTools ⊆ the marketplace-exposable tool allowlist (§5)
 *   3. semver / immutability rules (§4)
 *   4. injection-pattern scan (mirrors the security-integrity agent's scan)
 *
 * ADR-029 §3's staging upload: on a passing submission this module writes
 * the artifact bytes to the `ArtifactStore`'s `staging/` keyspace
 * (`artifact-store.ts`) under the content-addressed key derived from
 * `manifest.manifestHash`, then re-reads them back and re-verifies the
 * hash (ADR-029 §4's fetch-integrity re-check, run here at upload time
 * rather than fetch time since upload is the only write) before the
 * `ListingVersion` is ever marked `in_review`. `artifactUri` is the real
 * staging key, not a placeholder.
 *
 * Explicitly OUT of scope here (separate, larger follow-ups):
 *   - The `approved → published` promotion that copies the object from
 *     `staging/` to `published/` and sets the final CDN `artifactUri`
 *     (ADR-029 §3 step 3) — this module only handles the submission-time
 *     staging upload.
 *   - The review-queue UI that lets a human act on the resulting `in_review`
 *     row.
 *   - `myai-marketplace` CLI itself (ADR-028 checklist #1).
 */
import { createHash } from 'node:crypto';
import { marketplaceExposableTools } from '../core/rbac.js';
import type { TenantPlan } from '../shared/db.js';
import type { ListingKind, ListingVersion } from './types.js';
import { listListingVersions, upsertInReviewListingVersion } from './listing-version-store.js';
import {
  artifactKey,
  normalizeManifestHash,
  sha256Hex,
  LocalFilesystemArtifactStore,
  type ArtifactStore,
} from './artifact-store.js';
// Lazy-imported inside publishSubmission (not top-level): artifact-quota.js
// pulls in core/entitlements.js -> shared/db.js -> mongoose. That chain is
// only needed for the server-side quota gate — the offline local-validate.ts
// CLI (myai-marketplace validate/pack) imports the pure checks from this
// module and must NOT drag mongoose into a package-creator's install.

// ── §5: the marketplace-exposable tool allowlist ──────────────────────────
//
// "marketplace-exposable tools = ALL_TOOL_DEFINITIONS − OPERATOR_ONLY_TOOLS −
// {tools whose minimum required role > 'member'}" (ADR-028 §5) is computed
// mechanically by `rbac.ts`'s `marketplaceExposableTools()` — the canonical,
// CLI-shared source (ADR-028 checklist #3) so this module and the local
// validator both consume the same allowlist instead of hand-copying it.
export function computeMarketplaceExposableTools(): ReadonlySet<string> {
  return new Set(marketplaceExposableTools());
}

// ── Manifest shape (mirrors architecture/schemas/marketplace-package-manifest.schema.json) ──

export interface PublishManifest {
  manifestVersion: 1;
  kind: ListingKind;
  slug: string;
  title: string;
  summary: string;
  version: string;
  changelog: string;
  category: string;
  tags: string[];
  author: { name: string; contact: string };
  license: string;
  compatibility: { minGatewayVersion: string };
  capabilities: {
    declaredTools: string[];
    networkAllowlist: string[];
    resourceLimits: { maxWallClockMs: number; maxToolCalls: number; maxOutputBytes: number };
  };
  manifestHash: string | null;
}

export interface PublishSubmission {
  /** The `pack()`-shaped request body (ADR-028 §2/§3). */
  manifest: unknown;
  /** Raw content of the packaged artifact (agent.md, or the concatenated
   *  skill/ tree) — hashed for the manifestHash integrity check and scanned
   *  for injection patterns. Never persisted as artifact bytes (ADR-029). */
  artifactContent: string;
  /**
   * The submitting tenant's plan tier — when present, the ADR-029 §6 quota
   * gate runs before anything else. Optional (and skipped when absent)
   * because this module is also exercised directly in tests that don't care
   * about quota; the real `marketplace_publish` MCP tool (mcp/tools.ts)
   * always supplies it from the caller's resolved `ToolContext.plan`.
   */
  plan?: TenantPlan;
}

export type PublishCheck =
  | 'quota'
  | 'schema'
  | 'capability_surface'
  | 'semver_immutability'
  | 'injection_scan'
  | 'artifact_upload';

export interface PublishRejection {
  check: PublishCheck;
  reason: string;
  details: string[];
}

export type PublishResult =
  | { ok: true; listingVersion: ListingVersion; warnings: string[] }
  | { ok: false; rejection: PublishRejection };

// ── Check 1: schema validity ───────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?(\+[0-9A-Za-z-.]+)?$/;
const GATEWAY_VERSION_RE = /^\d+\.\d+\.\d+$/;
const MANIFEST_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function computeArtifactHash(artifactContent: string): string {
  return `sha256:${createHash('sha256').update(artifactContent, 'utf8').digest('hex')}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateManifestSchema(
  raw: unknown,
  artifactContent: string,
): { ok: true; manifest: PublishManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }

  if (raw.manifestVersion !== 1) errors.push('manifestVersion must be the literal 1');
  if (raw.kind !== 'agent' && raw.kind !== 'skill') errors.push("kind must be 'agent' or 'skill'");

  if (typeof raw.slug !== 'string' || !SLUG_RE.test(raw.slug) || raw.slug.length < 3 || raw.slug.length > 64) {
    errors.push('slug must be a lowercase, hyphenated, url-safe string (3-64 chars)');
  }
  if (typeof raw.title !== 'string' || raw.title.length < 1 || raw.title.length > 80) {
    errors.push('title must be 1-80 chars');
  }
  if (typeof raw.summary !== 'string' || raw.summary.length < 1 || raw.summary.length > 280) {
    errors.push('summary must be 1-280 chars');
  }
  if (typeof raw.version !== 'string' || !SEMVER_RE.test(raw.version)) {
    errors.push('version must be valid semver');
  }
  if (typeof raw.changelog !== 'string' || raw.changelog.length < 1) {
    errors.push('changelog must be a non-empty string');
  }
  if (typeof raw.category !== 'string' || raw.category.length < 1) {
    errors.push('category must be a non-empty string');
  }
  if (
    !Array.isArray(raw.tags) ||
    raw.tags.length > 10 ||
    !raw.tags.every((t) => typeof t === 'string' && t.length >= 1) ||
    new Set(raw.tags as string[]).size !== (raw.tags as unknown[]).length
  ) {
    errors.push('tags must be an array of up to 10 unique, non-empty strings');
  }

  if (!isRecord(raw.author) || typeof raw.author.name !== 'string' || raw.author.name.length < 1 ||
      typeof raw.author.contact !== 'string' || raw.author.contact.length < 3) {
    errors.push('author.name and author.contact are required');
  }
  if (typeof raw.license !== 'string' || raw.license.length < 1) {
    errors.push('license (SPDX identifier) is required — unlicensed submissions are a review-reject');
  }
  if (!isRecord(raw.compatibility) || typeof raw.compatibility.minGatewayVersion !== 'string' ||
      !GATEWAY_VERSION_RE.test(raw.compatibility.minGatewayVersion)) {
    errors.push('compatibility.minGatewayVersion must be valid semver');
  }

  const caps = raw.capabilities;
  if (!isRecord(caps)) {
    errors.push('capabilities is required');
  } else {
    if (!Array.isArray(caps.declaredTools) || !caps.declaredTools.every((t) => typeof t === 'string' && t.length >= 1) ||
        new Set(caps.declaredTools as string[]).size !== (caps.declaredTools as unknown[]).length) {
      errors.push('capabilities.declaredTools must be an array of unique, non-empty strings');
    }
    if (!Array.isArray(caps.networkAllowlist) || !caps.networkAllowlist.every((d) => typeof d === 'string' && DOMAIN_RE.test(d))) {
      errors.push('capabilities.networkAllowlist must be an array of exact domains, no wildcards');
    }
    const limits = caps.resourceLimits;
    if (!isRecord(limits) ||
        typeof limits.maxWallClockMs !== 'number' || limits.maxWallClockMs < 1 || limits.maxWallClockMs > 30000 ||
        typeof limits.maxToolCalls !== 'number' || limits.maxToolCalls < 0 || limits.maxToolCalls > 20 ||
        typeof limits.maxOutputBytes !== 'number' || limits.maxOutputBytes < 1 || limits.maxOutputBytes > 262144) {
      errors.push('capabilities.resourceLimits out of bounds (max 30000ms / 20 calls / 262144 bytes)');
    }
  }

  // manifestHash: null is only legal at first-draft authoring time (ADR-028
  // §2); a submittable `pack()` request body must carry a real, matching hash.
  if (typeof raw.manifestHash !== 'string' || !MANIFEST_HASH_RE.test(raw.manifestHash)) {
    errors.push('manifestHash must be a "sha256:<hex>" string at submission time (absent/null fails validation)');
  } else {
    const recomputed = computeArtifactHash(artifactContent);
    if (raw.manifestHash !== recomputed) {
      errors.push('manifestHash does not match the recomputed hash of the submitted artifact bytes');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: raw as unknown as PublishManifest };
}

// ── Check 2: capability-surface bound ──────────────────────────────────────

export function validateDeclaredToolsAllowlist(
  declaredTools: string[],
): { ok: true } | { ok: false; offending: string[] } {
  const allowlist = computeMarketplaceExposableTools();
  const offending = declaredTools.filter((t) => !allowlist.has(t));
  if (offending.length > 0) return { ok: false, offending };
  return { ok: true };
}

// ── Check 3: semver / immutability rules ───────────────────────────────────

export function validateSemverImmutability(
  version: string,
  priorVersions: readonly ListingVersion[],
): { ok: true } | { ok: false; reason: string } {
  if (!SEMVER_RE.test(version)) {
    return { ok: false, reason: `'${version}' is not valid semver` };
  }
  const collision = priorVersions.find((v) => v.version === version && (v.status === 'published' || v.status === 'yanked'));
  if (collision) {
    return {
      ok: false,
      reason: `version ${version} is already ${collision.status} — re-publishing under the same version number is not supported, bump the version instead`,
    };
  }
  return { ok: true };
}

// ── Check 4: injection-pattern scan ────────────────────────────────────────
//
// Mirrors the security-integrity agent's existing scan (agents/security-integrity.md):
// raw `bash`, `eval()`, `exec()`, `base64`, or external URLs outside the
// platform's own domains. Per ADR-028 §3 item 4, a hit does not hard-fail —
// it is a "must-justify-in-changelog" warning; this server-side re-run
// enforces that literally: an unjustified hit fails the check, a hit whose
// changelog acknowledges it passes with the warning still surfaced.
const ALLOWED_DOC_DOMAINS = ['github.com', 'knofler.dev'];
const INJECTION_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'raw bash code fence', re: /```\s*bash/i },
  { label: 'eval()', re: /\beval\s*\(/i },
  { label: 'exec()', re: /\bexec\s*\(/i },
  { label: 'base64', re: /\bbase64\b/i },
];
const URL_RE = /https?:\/\/([a-z0-9.-]+)/gi;
const JUSTIFICATION_RE = /justif/i;

export function scanInjectionPatterns(
  artifactContent: string,
  changelog: string,
): { ok: true; warnings: string[] } | { ok: false; hits: string[] } {
  const hits: string[] = [];
  for (const { label, re } of INJECTION_PATTERNS) {
    if (re.test(artifactContent)) hits.push(label);
  }
  for (const match of artifactContent.matchAll(URL_RE)) {
    const domain = match[1].toLowerCase();
    if (!ALLOWED_DOC_DOMAINS.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`))) {
      hits.push(`external URL outside platform domain: ${domain}`);
    }
  }

  if (hits.length === 0) return { ok: true, warnings: [] };
  if (JUSTIFICATION_RE.test(changelog)) {
    return { ok: true, warnings: hits.map((h) => `unjustified-by-default but changelog acknowledges: ${h}`) };
  }
  return { ok: false, hits };
}

// ── Orchestration ──────────────────────────────────────────────────────────

/** Module-default backend: the local filesystem store (ADR-029 §2's self-hosted-tenant parity). */
const defaultArtifactStore = new LocalFilesystemArtifactStore();

/**
 * Re-run ADR-028 §3's four checks server-side, fail-fast in order; on a pass,
 * upload the artifact bytes to the `ArtifactStore`'s `staging/` keyspace
 * (ADR-029 §3 step 1), re-verify the round-tripped bytes hash to
 * `manifest.manifestHash` (ADR-029 §4's fetch-integrity re-check, applied at
 * upload time), and only then create/refresh the `in_review` `ListingVersion`
 * row with the real content-addressed `artifactUri`. `artifactStore` is
 * injectable for tests; defaults to the local filesystem backend.
 */
export async function publishSubmission(
  creatorTenantId: string,
  submission: PublishSubmission,
  artifactStore: ArtifactStore = defaultArtifactStore,
): Promise<PublishResult> {
  // ADR-029 §6: enforced server-side, before accepting the upload at all —
  // ahead of even schema validation, so an over-quota tenant never gets far
  // enough to have their bytes touch staging/.
  if (submission.plan) {
    const { checkArtifactUploadQuota } = await import('./artifact-quota.js');
    const newArtifactBytes = Buffer.byteLength(submission.artifactContent, 'utf8');
    const quotaVerdict = await checkArtifactUploadQuota(creatorTenantId, submission.plan, newArtifactBytes, artifactStore);
    if (!quotaVerdict.allowed) {
      return { ok: false, rejection: { check: 'quota', reason: quotaVerdict.message, details: [] } };
    }
  }

  const schemaResult = validateManifestSchema(submission.manifest, submission.artifactContent);
  if (!schemaResult.ok) {
    return { ok: false, rejection: { check: 'schema', reason: 'manifest failed schema validation', details: schemaResult.errors } };
  }
  const manifest = schemaResult.manifest;

  const allowlistResult = validateDeclaredToolsAllowlist(manifest.capabilities.declaredTools);
  if (!allowlistResult.ok) {
    return {
      ok: false,
      rejection: {
        check: 'capability_surface',
        reason: 'declaredTools includes tool(s) outside the marketplace-exposable allowlist',
        details: allowlistResult.offending,
      },
    };
  }

  const priorVersions = listListingVersions(creatorTenantId, manifest.slug);
  const semverResult = validateSemverImmutability(manifest.version, priorVersions);
  if (!semverResult.ok) {
    return { ok: false, rejection: { check: 'semver_immutability', reason: semverResult.reason, details: [] } };
  }

  const scanResult = scanInjectionPatterns(submission.artifactContent, manifest.changelog);
  if (!scanResult.ok) {
    return {
      ok: false,
      rejection: {
        check: 'injection_scan',
        reason: 'injection-pattern hit(s) require justification in the changelog',
        details: scanResult.hits,
      },
    };
  }

  // ADR-029 §3 step 1: upload to the staging/ keyspace, content-addressed by
  // manifestHash — not publicly fetchable, reachable only by the review
  // pipeline and the uploading creator's own tenant (enforced upstream by
  // RBAC on the review-queue reads, not by this store).
  const manifestHash = manifest.manifestHash as string;
  const stagingKey = artifactKey('staging', manifestHash);
  const artifactBytes = Buffer.from(submission.artifactContent, 'utf8');
  await artifactStore.put(stagingKey, artifactBytes);

  // ADR-029 §4's fetch-integrity re-check, run here at upload time: read the
  // bytes back and re-verify their hash against manifest.manifestHash before
  // ever marking the ListingVersion in_review. A mismatch (store corruption,
  // a backend bug) fails closed — never falls back to trusting the write.
  const roundTripped = await artifactStore.get(stagingKey);
  if (roundTripped === null || sha256Hex(roundTripped) !== normalizeManifestHash(manifestHash)) {
    return {
      ok: false,
      rejection: {
        check: 'artifact_upload',
        reason: 'stored artifact bytes did not round-trip to the manifestHash after upload to the staging artifact store',
        details: [],
      },
    };
  }

  const listingVersion = upsertInReviewListingVersion({
    creatorTenantId,
    listingId: manifest.slug,
    version: manifest.version,
    manifestHash,
    changelog: manifest.changelog,
    artifactUri: stagingKey,
    declaredTools: manifest.capabilities.declaredTools,
  });

  return { ok: true, listingVersion, warnings: scanResult.warnings };
}
