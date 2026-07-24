/**
 * Envelope encryption primitives (ADR-010 §3.7) — pure, no DB/I/O so every
 * rule is unit-testable in isolation, mirroring the oauth-refresh-core split.
 *
 * Two layers, both AES-256-GCM:
 *   - a per-tenant Data Encryption Key (DEK) encrypts the actual secret
 *     VALUES (connector env vars, OAuth tokens);
 *   - a master KMS-style key encrypts ("wraps") each tenant's DEK before it
 *     is persisted.
 *
 * This is what makes master-key rotation cheap: rotating means re-wrapping
 * every tenant's (small, fixed-size) DEK with the new master key — the
 * secret ciphertext itself, which can be arbitrarily large and numerous,
 * never needs to be touched or re-encrypted.
 *
 * The master key never lives in the database — only in gateway process env
 * — so a Mongo dump alone (ciphertext + wrapped DEKs) cannot decrypt anything.
 */
import crypto from 'node:crypto';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'secret-crypto' });

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12;  // GCM standard nonce size
const TAG_BYTES = 16;

/** Generate a fresh 256-bit Data Encryption Key. */
export function generateDek(): Buffer {
  return crypto.randomBytes(KEY_BYTES);
}

/** AES-256-GCM encrypt: returns base64(iv || authTag || ciphertext). */
function aesGcmEncrypt(plaintext: Buffer, key: Buffer): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Inverse of aesGcmEncrypt. Throws on a truncated blob or auth-tag mismatch (tamper/wrong key). */
function aesGcmDecrypt(blob: string, key: Buffer): Buffer {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error('secret-crypto: ciphertext too short to be a valid envelope');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Encrypt a secret VALUE with a tenant's (unwrapped) DEK. */
export function encryptWithDek(plaintext: string, dek: Buffer): string {
  return aesGcmEncrypt(Buffer.from(plaintext, 'utf8'), dek);
}

/** Decrypt a secret VALUE previously produced by encryptWithDek. */
export function decryptWithDek(blob: string, dek: Buffer): string {
  return aesGcmDecrypt(blob, dek).toString('utf8');
}

export interface WrappedDek {
  wrappedDek: string;
  masterKeyVersion: string;
}

/** Wrap (encrypt) a DEK with the keyring's currently-active master key. */
export function wrapDek(dek: Buffer, keyring: MasterKeyring): WrappedDek {
  const masterKey = keyring.keys.get(keyring.activeVersion);
  if (!masterKey) throw new Error(`secret-crypto: active master key version "${keyring.activeVersion}" not loaded`);
  return { wrappedDek: aesGcmEncrypt(dek, masterKey), masterKeyVersion: keyring.activeVersion };
}

/** Unwrap (decrypt) a DEK using the master key version it was wrapped with. */
export function unwrapDek(wrapped: WrappedDek, keyring: MasterKeyring): Buffer {
  const masterKey = keyring.keys.get(wrapped.masterKeyVersion);
  if (!masterKey) {
    throw new Error(
      `secret-crypto: master key version "${wrapped.masterKeyVersion}" is not loaded — ` +
      'it must stay in MASTER_KMS_PREVIOUS_KEYS until every DEK wrapped with it has been rotated',
    );
  }
  return aesGcmDecrypt(wrapped.wrappedDek, masterKey);
}

export interface MasterKeyring {
  /** Version label of the key new wraps use. */
  activeVersion: string;
  /** version label -> raw 32-byte key. Includes retired versions still needed to unwrap old DEKs. */
  keys: Map<string, Buffer>;
}

function decodeKey(b64: string, label: string): Buffer {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(`secret-crypto: master key "${label}" must decode to ${KEY_BYTES} bytes, got ${buf.length}`);
  }
  return buf;
}

let ephemeralWarned = false;

/**
 * Load the master keyring from env. `MASTER_KMS_KEY` (base64, 32 bytes) is
 * the active key; `MASTER_KMS_KEY_VERSION` labels it (default "v1").
 * `MASTER_KMS_PREVIOUS_KEYS` is an optional JSON map of retired
 * version -> base64 key, kept around only until `rotateMasterKey` has
 * re-wrapped every tenant DEK that used them.
 *
 * Same posture as user-auth.ts's JWT_SECRET fallback: with no key configured
 * (dev/test), generate an ephemeral per-process key and warn loudly — secrets
 * encrypted this way do not survive a restart and MUST NOT be used in
 * production.
 */
export function loadMasterKeyring(env: NodeJS.ProcessEnv = process.env): MasterKeyring {
  const keys = new Map<string, Buffer>();
  let activeVersion = env.MASTER_KMS_KEY_VERSION || 'v1';

  if (env.MASTER_KMS_KEY) {
    keys.set(activeVersion, decodeKey(env.MASTER_KMS_KEY, activeVersion));
  } else {
    activeVersion = 'ephemeral';
    keys.set(activeVersion, crypto.randomBytes(KEY_BYTES));
    if (!ephemeralWarned) {
      ephemeralWarned = true;
      log.warn(
        'MASTER_KMS_KEY is not set — using an ephemeral per-process master key. Every ' +
        'tenant DEK wrapped with it becomes unreadable on restart. Set MASTER_KMS_KEY ' +
        '(32 random bytes, base64) in production.',
      );
    }
  }

  if (env.MASTER_KMS_PREVIOUS_KEYS) {
    let previous: Record<string, string>;
    try {
      previous = JSON.parse(env.MASTER_KMS_PREVIOUS_KEYS);
    } catch {
      throw new Error('secret-crypto: MASTER_KMS_PREVIOUS_KEYS must be valid JSON ({"version": "base64key"})');
    }
    for (const [version, b64] of Object.entries(previous)) {
      if (!keys.has(version)) keys.set(version, decodeKey(b64, version));
    }
  }

  return { activeVersion, keys };
}
