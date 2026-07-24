/**
 * TOTP (RFC 6238) two-factor auth — enrolment secret/URI, code + recovery-code
 * verification, and the sliding-window rate limit for the verify step.
 *
 * No external TOTP library: this is RFC 4226 HOTP (HMAC-SHA1, dynamic
 * truncation) stepped every 30s per RFC 6238 — small enough to hand-roll and
 * audit directly rather than trust a dependency for a security-critical path.
 *
 * Enrolment hands back the `otpauth://` URI (the industry-standard scan
 * target every authenticator app understands) plus the raw base32 secret for
 * manual entry. Rendering that URI as an actual QR *image* is a client-side
 * concern deliberately left to the dashboard (no QR-rendering dependency
 * here) — the manual-entry secret is a fully supported fallback in every
 * authenticator app, so enrolment works end-to-end without it.
 */
import crypto from 'node:crypto';
import { sha256Hex } from './auth.js';
import { checkRate, type RatePolicy } from './auth-rate-limit.js';

const ALGORITHM = 'sha1';
const DIGITS = 6;
const PERIOD_SECONDS = 30;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ── Base32 (RFC 4648, no padding) — secrets travel as base32 in the
// otpauth:// URI and in every authenticator app's manual-entry field. ──

export function base32Encode(buf: Buffer): string {
  let bits = '';
  for (const byte of buf) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  const remainder = bits.length % 5;
  if (remainder > 0) {
    const chunk = bits.slice(bits.length - remainder).padEnd(5, '0');
    out += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** Fresh 160-bit secret (base32) — the recommended TOTP key length. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function buildOtpauthUri(opts: { secret: string; email: string; issuer?: string }): string {
  const issuer = opts.issuer || 'myAI';
  const label = encodeURIComponent(`${issuer}:${opts.email}`);
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function hotp(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);
  const counterBuf = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer; Number is safe up to 2^53, far
  // beyond any realistic TOTP counter (2^53 * 30s is billions of years).
  counterBuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac(ALGORITHM, key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

function timingSafeStrEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // keep timing shape consistent on length mismatch
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify a 6-digit code against the secret, allowing +/-`windowSteps` (90s of
 * clock drift either side by default) — standard TOTP leniency so a slightly
 * skewed device clock doesn't lock the user out.
 */
export function verifyTotpCode(secretBase32: string, code: string, windowSteps = 1, now = Date.now()): boolean {
  const trimmed = (code || '').trim();
  if (!/^\d{6}$/.test(trimmed)) return false;
  const counter = Math.floor(now / 1000 / PERIOD_SECONDS);
  for (let errorWindow = -windowSteps; errorWindow <= windowSteps; errorWindow++) {
    if (timingSafeStrEqual(hotp(secretBase32, counter + errorWindow), trimmed)) return true;
  }
  return false;
}

// ── Recovery codes — one-time-use fallback when the authenticator device is
// unavailable. Only sha256 hashes are ever persisted (same posture as API
// keys); raw codes are returned to the caller exactly once, at generation. ──

export interface RecoveryCodeSet {
  /** Raw codes — show once, never persisted. */
  raw: string[];
  /** sha256 hashes — what gets stored on the user doc. */
  hashed: string[];
}

const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): RecoveryCodeSet {
  const raw: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(5).toString('hex'); // 10 hex chars
    raw.push(`${bytes.slice(0, 5)}-${bytes.slice(5, 10)}`);
  }
  return { raw, hashed: raw.map((c) => sha256Hex(normalizeRecoveryCode(c))) };
}

export function normalizeRecoveryCode(code: string): string {
  return (code || '').trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * Check a raw recovery code against the stored hash list. Returns the index
 * to remove (single-use — the caller must delete it from the persisted list)
 * or -1 if no match. Constant-time per-entry compare; still short-circuits
 * across entries (list length isn't secret).
 */
export function matchRecoveryCode(rawCode: string, hashedCodes: string[]): number {
  const candidate = sha256Hex(normalizeRecoveryCode(rawCode));
  return hashedCodes.findIndex((h) => timingSafeStrEqual(h, candidate));
}

// ── Rate limiting — same sliding-window primitive as login/reset/etc
// (auth-rate-limit.ts), keyed by userId since TOTP verify happens mid-login
// before a session exists (no email in scope at that call site sometimes —
// userId is always known, from the pending-MFA token). ──

export const TOTP_VERIFY_POLICY: RatePolicy = {
  max: Number(process.env.AUTH_TOTP_VERIFY_MAX) || 8,
  windowMs: (Number(process.env.AUTH_TOTP_VERIFY_WINDOW_MIN) || 15) * 60_000,
};

const totpVerifyStore = new Map<string, { hits: number[] }>();

export function checkTotpVerifyRate(userId: string): { ok: boolean; retryAfter: number } {
  return checkRate(totpVerifyStore, `totp-verify:${userId}`, TOTP_VERIFY_POLICY, Date.now());
}

/** Test helper — clear the verify rate-limit store. */
export function _resetTotpVerifyRate(): void {
  totpVerifyStore.clear();
}
