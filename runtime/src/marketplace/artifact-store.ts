/**
 * ADR-029 §2/§3 — backend-agnostic artifact put/get-by-key interface, plus
 * the local filesystem backend for the single-operator self-hosted default
 * tenant (§2 "local/self-hosted parity", mirroring ADR-022's local/Atlas
 * dev-parity posture — one interface, no second independently-maintained
 * implementation of the same semantics, per the ADR's own named Risk).
 *
 * Implementation checklist item #1: this module gives a hosted
 * S3-compatible backend something to implement against, but does not
 * provision one (vendor TBD, §7 — out of scope). The local filesystem
 * backend below IS wired to `marketplace_publish`'s upload path
 * (`publish.ts`'s `publishSubmission` calls `put()`/`get()` against the
 * `staging/` keyspace and writes the resulting key as `artifactUri`) —
 * checklist item #2's staging-upload half. The `approved → published`
 * promotion copy (checklist item #2's other half, ADR-029 §3 step 3) is
 * still a separate follow-up.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { myaiHome } from '../core/brain.js';

/** ADR-029 §3's two-stage posture: unreviewed bytes never live under `published/`. */
export type ArtifactStage = 'staging' | 'published';

const HEX64_RE = /^[0-9a-f]{64}$/;
/** Exactly the key shape `artifactKey()` produces — a defense against a caller handing a raw key to a backend. */
const ARTIFACT_KEY_RE = /^(staging|published)\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

/**
 * Normalize a `manifestHash` to the bare 64-char lowercase hex digest used in
 * storage keys. Accepts either the `sha256:<hex>` form used elsewhere in the
 * marketplace code (`publish.ts`'s `computeArtifactHash`) or a bare hex
 * digest, so callers don't need to know which form they were handed.
 */
export function normalizeManifestHash(manifestHash: string): string {
  const hex = manifestHash.startsWith('sha256:') ? manifestHash.slice('sha256:'.length) : manifestHash;
  if (!HEX64_RE.test(hex)) {
    throw new Error(
      `invalid manifestHash: expected 64 lowercase hex chars (optionally prefixed "sha256:"), got "${manifestHash}"`,
    );
  }
  return hex;
}

/**
 * ADR-029 §2's content-addressed key scheme: `<stage>/sha256/<hh>/<manifestHash>`,
 * `<hh>` = first 2 hex chars of the hash (sharding, mirrors git's own
 * `.git/objects/xx/` convention — familiar, not borrowed machinery). Same
 * scheme for both `staging/` and `published/`; only the stage prefix differs.
 */
export function artifactKey(stage: ArtifactStage, manifestHash: string): string {
  const hex = normalizeManifestHash(manifestHash);
  return `${stage}/sha256/${hex.slice(0, 2)}/${hex}`;
}

/** One object under a stage prefix, as enumerated by `listStage()` — the
 *  primitive the staging TTL sweep (ADR-029 §5) and the per-tenant published-
 *  bytes quota accounting (ADR-029 §6) both need: a size to sum/compare and a
 *  last-modified time to age against a TTL. */
export interface ArtifactStoreEntry {
  key: string;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Backend-agnostic put/get-by-key contract (ADR-029 §2, implementation
 * checklist #1). Both the local filesystem backend below and a future
 * S3-compatible backend must satisfy this — one code path, two backends.
 */
export interface ArtifactStore {
  put(key: string, bytes: Buffer): Promise<void>;
  /** `null` when nothing is stored at `key` — never throws for a missing key. */
  get(key: string): Promise<Buffer | null>;
  /** Byte size at `key`, or `null` if absent — avoids reading full bytes into
   *  memory for a size-only check (quota accounting, artifact-quota.ts). */
  size(key: string): Promise<number | null>;
  /** Delete the object at `key` — a no-op if already absent. Used by the
   *  `staging/` TTL sweep (scheduler/marketplace-staging-sweep.ts, ADR-029 §5).
   *  `published/` objects are never passed here by that sweep — retention
   *  (§5) makes deletion of anything under `published/` a non-event by
   *  default; this method itself does not special-case the stage, the sweep
   *  simply never calls it on a published key. */
  delete(key: string): Promise<void>;
  /** Every key currently stored under `stage` (e.g. `'staging'`), with size +
   *  last-modified time — the enumeration primitive the TTL sweep and quota
   *  accounting need. A backend implements this over its own listing
   *  primitive (a directory walk locally; `ListObjectsV2` for an eventual
   *  S3-compatible backend, §7 — vendor TBD). */
  listStage(stage: ArtifactStage): Promise<ArtifactStoreEntry[]>;
}

function assertValidKey(key: string): void {
  if (!ARTIFACT_KEY_RE.test(key)) {
    throw new Error(`invalid artifact key "${key}" — expected the artifactKey() shape "<staging|published>/sha256/<hh>/<hash>"`);
  }
}

/**
 * Local filesystem backend for the single-operator self-hosted default
 * tenant — "not entitled to (and does not need) a cloud bucket" (ADR-029
 * §2). Rooted at `<myai home>/marketplace-artifacts/`, the same `~/.myai`
 * root the brain store and obf-map-store already use (`myaiHome()` in
 * `core/brain.ts`).
 */
export class LocalFilesystemArtifactStore implements ArtifactStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private rootDir(): string {
    return join(myaiHome(this.env), 'marketplace-artifacts');
  }

  private pathFor(key: string): string {
    assertValidKey(key);
    return join(this.rootDir(), key);
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const path = this.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }

  async get(key: string): Promise<Buffer | null> {
    const path = this.pathFor(key);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }

  async size(key: string): Promise<number | null> {
    const path = this.pathFor(key);
    if (!existsSync(path)) return null;
    return statSync(path).size;
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    if (existsSync(path)) unlinkSync(path);
  }

  async listStage(stage: ArtifactStage): Promise<ArtifactStoreEntry[]> {
    const shardsRoot = join(this.rootDir(), stage, 'sha256');
    if (!existsSync(shardsRoot)) return [];

    const entries: ArtifactStoreEntry[] = [];
    for (const shard of readdirSync(shardsRoot)) {
      const shardDir = join(shardsRoot, shard);
      if (!statSync(shardDir).isDirectory()) continue;
      for (const file of readdirSync(shardDir)) {
        const filePath = join(shardDir, file);
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;
        entries.push({ key: `${stage}/sha256/${shard}/${file}`, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
    return entries;
  }
}

/** Convenience: SHA-256 of `bytes` in the same `sha256:<hex>` form `publish.ts`'s `computeArtifactHash` produces. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
