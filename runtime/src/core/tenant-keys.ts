/**
 * Per-tenant API-key lifecycle (ADR-010 §3.6).
 *
 * - generate: 256-bit CSPRNG secret → `myai_{live|test}_<base62>`; persist only
 *   the prefix (indexed, non-secret) + sha256 hash; return the raw key EXACTLY
 *   once (dashboard "copy your key"). Never stored/logged/re-derivable.
 * - rotate: new pair; the OLD pair is kept (in `apiKeyHashPrevious`/
 *   `apiKeyPrefixPrevious`) and stays valid until `apiKeyPreviousExpiresAt`
 *   (default 60 min, env TENANT_KEY_ROTATION_GRACE_MINUTES) — zero-downtime
 *   self-rotation (`myai rotate-keys tenant <id>`). `graceMinutes: 0` is an
 *   immediate cutover (no previous key kept), same as the old MVP behavior.
 * - revoke: status='suspended' (instant across transports) / 'deleted' (tombstone).
 *
 * Never log a full key — only `apiKeyPrefix` + `{ tenantId }`.
 */
import crypto from 'node:crypto';
import { TenantModel, type ITenant, type TenantPlan, type TenantRegion } from '../shared/db.js';
import { sha256Hex, KEY_PREFIX_LEN } from './auth.js';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** base62-encode a buffer (big-endian). */
function base62Encode(bytes: Buffer): string {
  let num = BigInt('0x' + (bytes.toString('hex') || '0'));
  if (num === 0n) return '0';
  const base = 62n;
  let out = '';
  while (num > 0n) {
    out = BASE62[Number(num % base)] + out;
    num /= base;
  }
  return out;
}

export interface GeneratedKey {
  /** The raw key — returned to the caller exactly once, never persisted. */
  raw: string;
  /** Indexed, non-secret lookup prefix. */
  prefix: string;
  /** sha256(raw) hex — what gets stored. */
  hash: string;
}

/** Generate a fresh API key. `crypto.randomBytes` — never Math.random. */
export function generateApiKey(env: 'live' | 'test' = 'live'): GeneratedKey {
  // 32 bytes → ~43 base62 chars (256-bit entropy). Pad defensively if a small
  // random value encodes shorter; trim to a stable 43-char secret.
  const secret = base62Encode(crypto.randomBytes(32)).padEnd(43, '0').slice(0, 43);
  const raw = `myai_${env}_${secret}`;
  return { raw, prefix: raw.slice(0, KEY_PREFIX_LEN), hash: sha256Hex(raw) };
}

function isDuplicateKeyError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: number }).code === 11000;
}

/** Default rotation grace window — the old bootstrap key keeps working this long. */
const DEFAULT_GRACE_MINUTES = Number(process.env.TENANT_KEY_ROTATION_GRACE_MINUTES) || 60;
const MAX_GRACE_MINUTES = 7 * 24 * 60; // 7 days — generous but bounded ceiling

export interface ProvisionOptions {
  tenantId: string;
  name: string;
  plan?: TenantPlan;
  /**
   * Data-residency region to pin this tenant to (ADR-023). Defaults to 'us'
   * (matches the schema default) — the signup flow should surface this as an
   * explicit "choose your data region" choice for sovereignty-sensitive
   * customers rather than relying on the silent default.
   */
  region?: TenantRegion;
  ownerEmail?: string;
  env?: 'live' | 'test';
  metadata?: Record<string, unknown>;
}

/**
 * Create a tenant + its first key. Returns the tenant doc and the raw key
 * (show-once). Retries on the rare prefix-uniqueness collision.
 */
export async function provisionTenant(
  opts: ProvisionOptions,
): Promise<{ tenant: ITenant; rawKey: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = generateApiKey(opts.env ?? 'live');
    try {
      const tenant = await TenantModel.create({
        tenantId: opts.tenantId,
        name: opts.name,
        apiKeyHash: key.hash,
        apiKeyPrefix: key.prefix,
        plan: opts.plan ?? 'free',
        region: opts.region ?? 'us',
        status: 'active',
        ownerEmail: opts.ownerEmail,
        metadata: opts.metadata ?? {},
      });
      return { tenant, rawKey: key.raw };
    } catch (err) {
      // Regenerate only on a prefix collision; a tenantId collision is a real
      // caller error and must surface.
      if (isDuplicateKeyError(err) && attempt < 4) {
        const dupTenantId = await TenantModel.exists({ tenantId: opts.tenantId });
        if (dupTenantId) throw err;
        continue;
      }
      throw err;
    }
  }
  throw new Error('failed to provision tenant key after retries');
}

/**
 * Rotate a tenant's bootstrap key with a grace overlap: the OLD hash/prefix
 * move to `apiKeyHashPrevious`/`apiKeyPrefixPrevious` and keep authenticating
 * (auth.ts resolveTenantByKey) until `apiKeyPreviousExpiresAt`, so a self- or
 * scheduled rotation has zero downtime. `graceMinutes: 0` clears the previous
 * fields for an immediate cutover. Returns the new raw key (show-once).
 */
export async function rotateApiKey(
  tenantId: string,
  env: 'live' | 'test' = 'live',
  graceMinutes?: number,
): Promise<string> {
  const graceMin = Math.min(Math.max(graceMinutes ?? DEFAULT_GRACE_MINUTES, 0), MAX_GRACE_MINUTES);
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await TenantModel.findOne({ tenantId })
      .select('+apiKeyHash')
      .lean<ITenant>()
      .exec();
    if (!existing) throw new Error(`tenant not found: ${tenantId}`);

    const key = generateApiKey(env);
    const update =
      graceMin > 0
        ? {
            $set: {
              apiKeyHash: key.hash,
              apiKeyPrefix: key.prefix,
              apiKeyHashPrevious: existing.apiKeyHash,
              apiKeyPrefixPrevious: existing.apiKeyPrefix,
              apiKeyPreviousExpiresAt: new Date(Date.now() + graceMin * 60_000),
            },
          }
        : {
            $set: { apiKeyHash: key.hash, apiKeyPrefix: key.prefix },
            $unset: { apiKeyHashPrevious: '', apiKeyPrefixPrevious: '', apiKeyPreviousExpiresAt: '' },
          };
    try {
      const res = await TenantModel.updateOne({ tenantId }, update);
      if (res.matchedCount === 0) throw new Error(`tenant not found: ${tenantId}`);
      return key.raw;
    } catch (err) {
      if (isDuplicateKeyError(err) && attempt < 4) continue;
      throw err;
    }
  }
  throw new Error('failed to rotate tenant key after retries');
}

/** Suspend (revoke) or restore a tenant. 'deleted' is an offboarding tombstone. */
export async function setTenantStatus(
  tenantId: string,
  status: 'active' | 'suspended' | 'deleted',
): Promise<boolean> {
  const res = await TenantModel.updateOne({ tenantId }, { $set: { status } });
  return res.matchedCount > 0;
}

/**
 * Idempotently ensure the default tenant exists (used by the migration / seed).
 * Creates it with a placeholder key the rotation flow later replaces; never
 * overwrites an existing default's key.
 */
export async function ensureDefaultTenant(tenantId: string, name = 'Default (local operator)'): Promise<void> {
  const existing = await TenantModel.exists({ tenantId });
  if (existing) return;
  const key = generateApiKey('live');
  await TenantModel.updateOne(
    { tenantId },
    {
      $setOnInsert: {
        tenantId,
        name,
        apiKeyHash: key.hash,
        apiKeyPrefix: key.prefix,
        plan: 'scale',
        status: 'active',
        metadata: { seeded: true },
      },
    },
    { upsert: true },
  );
}
