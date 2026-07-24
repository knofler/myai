// Server-only per-tenant API-key helpers — an EXACT mirror of the gateway's
// `runtime/src/core/auth.ts` + `runtime/src/core/tenant-keys.ts` (ADR-010 §3.1,
// §3.6) so keys minted / validated by the dashboard interoperate 1:1 with the
// gateway's per-tenant auth middleware.
//
//   key   = `myai_{live|test}_<43 base62 chars>`  (256-bit CSPRNG secret)
//   prefix = first 18 chars (indexed, non-secret lookup key)
//   hash   = sha256hex(raw)   ← what is stored; the raw key is shown ONCE
//
// NEVER import this from a Client Component — it pulls in `node:crypto`.
import crypto from 'node:crypto';

/** `myai_` (5) + `live_`|`test_` (5) + 8 secret chars = 18. Matches gateway. */
export const KEY_PREFIX_LEN = 18;

/** Accepts both live + test keys; mirrors the gateway's KEY_RE. */
export const KEY_RE = /^myai_(live|test)_[0-9A-Za-z]{20,}$/;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** base62-encode a buffer (big-endian) — identical to the gateway impl.
 *  Uses the `BigInt()` constructor (not `0n` literals) so it typechecks under
 *  the dashboard's ES2017 target. */
function base62Encode(bytes: Buffer): string {
  let num = BigInt('0x' + (bytes.toString('hex') || '0'));
  const zero = BigInt(0);
  const base = BigInt(62);
  if (num === zero) return '0';
  let out = '';
  while (num > zero) {
    out = BASE62[Number(num % base)] + out;
    num = num / base;
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
  const secret = base62Encode(crypto.randomBytes(32)).padEnd(43, '0').slice(0, 43);
  const raw = `myai_${env}_${secret}`;
  return { raw, prefix: raw.slice(0, KEY_PREFIX_LEN), hash: sha256Hex(raw) };
}

/** Constant-time compare of two hex digests — mirrors the gateway helper. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  let ba: Buffer;
  let bb: Buffer;
  try {
    ba = Buffer.from(a, 'hex');
    bb = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Derive a stable, URL-safe tenantId slug from a display name + a short random
 * suffix. The suffix keeps two tenants named "Acme" distinct and gives the
 * provision retry loop a fresh id on the rare collision.
 */
export function slugifyTenantId(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'tenant';
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}
