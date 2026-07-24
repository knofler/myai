/**
 * Per-tenant envelope-encryption service (ADR-010 §3.7) — the DB-touching
 * layer on top of the pure primitives in secret-crypto.ts. This is what
 * connector-store.ts (and any future BYOK-credential store) calls to encrypt
 * a secret VALUE before it's persisted, and decrypt it back on read.
 *
 * Distinct from tenant-api-keys.ts / tenant-keys.ts: those mint keys the
 * TENANT uses to call the gateway and only ever store a one-way hash (never
 * decryptable, by design). This module protects secrets the gateway ITSELF
 * stores on the tenant's behalf — third-party API keys and OAuth tokens —
 * which must be decryptable again to actually use them, so "never store the
 * plaintext" isn't an option; envelope encryption is the mitigation.
 */
import {
  isConnected,
  TenantSecretKeyModel,
  type ITenantSecretKey,
} from '../shared/db.js';
import {
  generateDek,
  wrapDek,
  unwrapDek,
  encryptWithDek,
  decryptWithDek,
  loadMasterKeyring,
  type MasterKeyring,
} from './secret-crypto.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'tenant-secrets' });

/** Prefix marking a value as an encrypted envelope, vs. legacy/plaintext. */
const ENC_PREFIX = 'enc:v1:';

let cachedKeyring: MasterKeyring | null = null;

/** Lazily loaded, process-lifetime keyring. `resetMasterKeyringCache` is test-only. */
function getKeyring(): MasterKeyring {
  if (!cachedKeyring) cachedKeyring = loadMasterKeyring();
  return cachedKeyring;
}

/** Test-only: force the next getKeyring() to re-read env (e.g. after a rotation). */
export function resetMasterKeyringCache(): void {
  cachedKeyring = null;
}

/**
 * Fetch this tenant's DEK, minting + wrapping a fresh one on first use.
 * Returns null when the DB isn't available (caller falls back to storing
 * plaintext rather than crashing — see encryptSecret/decryptSecret).
 */
async function getOrCreateDek(tenantId: string): Promise<Buffer | null> {
  if (!isConnected() || !TenantSecretKeyModel) {
    log.warn({ tenantId }, 'DB not connected — cannot load/create tenant DEK');
    return null;
  }
  const keyring = getKeyring();
  const existing = await TenantSecretKeyModel.findOne({ tenantId }).lean<ITenantSecretKey | null>();
  if (existing) {
    return unwrapDek({ wrappedDek: existing.wrappedDek, masterKeyVersion: existing.masterKeyVersion }, keyring);
  }

  const dek = generateDek();
  const { wrappedDek, masterKeyVersion } = wrapDek(dek, keyring);
  try {
    await TenantSecretKeyModel.create({ tenantId, wrappedDek, masterKeyVersion });
  } catch (err) {
    // Duplicate-key race: another request minted the DEK first — read theirs.
    if ((err as { code?: number }).code === 11000) {
      const winner = await TenantSecretKeyModel.findOne({ tenantId }).lean<ITenantSecretKey | null>();
      if (winner) {
        return unwrapDek({ wrappedDek: winner.wrappedDek, masterKeyVersion: winner.masterKeyVersion }, keyring);
      }
    }
    throw err;
  }
  log.info({ tenantId, masterKeyVersion }, 'tenant DEK created');
  return dek;
}

/**
 * Encrypt a secret value for storage. Falls back to returning the plaintext
 * unchanged when the DB is unavailable (matches every other store's
 * `!isConnected()` degrade-gracefully posture elsewhere in this codebase) —
 * callers that must never persist plaintext should check `isConnected()`
 * themselves first.
 */
export async function encryptSecret(tenantId: string, plaintext: string): Promise<string> {
  const dek = await getOrCreateDek(tenantId);
  if (!dek) return plaintext;
  return ENC_PREFIX + encryptWithDek(plaintext, dek);
}

/**
 * Decrypt a value previously produced by encryptSecret. A value without the
 * envelope prefix is passed through unchanged — this is what makes rollout
 * non-breaking: pre-existing plaintext rows (written before this feature
 * shipped, or migrated ones) keep working until they're next re-saved.
 */
export async function decryptSecret(tenantId: string, value: string): Promise<string> {
  if (!value.startsWith(ENC_PREFIX)) return value;
  const dek = await getOrCreateDek(tenantId);
  if (!dek) {
    throw new Error(`tenant-secrets: cannot decrypt for tenant "${tenantId}" — DB unavailable, DEK unreachable`);
  }
  return decryptWithDek(value.slice(ENC_PREFIX.length), dek);
}

/** Encrypt every value in a string map (e.g. a connector's `env` block). */
export async function encryptSecretMap(
  tenantId: string,
  values: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  if (!values) return values;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) out[k] = await encryptSecret(tenantId, v);
  return out;
}

/** Decrypt every value in a string map produced by encryptSecretMap. */
export async function decryptSecretMap(
  tenantId: string,
  values: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  if (!values) return values;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) out[k] = await decryptSecret(tenantId, v);
  return out;
}

export interface RotateMasterKeyResult {
  scanned: number;
  rewrapped: number;
  skippedAlreadyCurrent: number;
}

/**
 * Master-key rotation: re-wrap every tenant's DEK with the keyring's
 * CURRENT active master key. Deliberately does not touch any secret
 * ciphertext — only the small wrapped-DEK row per tenant is read + rewritten,
 * so this is cheap regardless of how many secrets a tenant has stored.
 *
 * Call this AFTER deploying a new `MASTER_KMS_KEY` (with the old one moved to
 * `MASTER_KMS_PREVIOUS_KEYS` so in-flight unwraps of not-yet-rotated rows
 * still succeed). Once every row reports `masterKeyVersion` equal to the new
 * active version, the old key can be dropped from env.
 */
export async function rotateMasterKey(): Promise<RotateMasterKeyResult> {
  if (!isConnected() || !TenantSecretKeyModel) {
    throw new Error('tenant-secrets: cannot rotate — DB not connected');
  }
  resetMasterKeyringCache();
  const keyring = getKeyring();
  const result: RotateMasterKeyResult = { scanned: 0, rewrapped: 0, skippedAlreadyCurrent: 0 };

  const rows = await TenantSecretKeyModel.find({}).lean<ITenantSecretKey[]>();
  for (const row of rows) {
    result.scanned++;
    if (row.masterKeyVersion === keyring.activeVersion) {
      result.skippedAlreadyCurrent++;
      continue;
    }
    const dek = unwrapDek({ wrappedDek: row.wrappedDek, masterKeyVersion: row.masterKeyVersion }, keyring);
    const { wrappedDek, masterKeyVersion } = wrapDek(dek, keyring);
    await TenantSecretKeyModel.updateOne({ tenantId: row.tenantId }, { $set: { wrappedDek, masterKeyVersion } });
    result.rewrapped++;
  }
  log.info(result, 'master key rotation complete');
  return result;
}
