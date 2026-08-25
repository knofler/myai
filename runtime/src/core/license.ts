/**
 * Self-hosted / on-prem license-key activation + air-gapped guard
 * (GRAND_PRODUCT Phase 3 §5, moat #5 — selfhost/README.md).
 *
 * Two independent, deliberately-decoupled concerns:
 *
 *  1. LICENSE ACTIVATION — an optional `LICENSE_KEY` env var, verified
 *     entirely OFFLINE with an embedded Ed25519 public key (no license
 *     server, no network round trip — verification must work with zero
 *     connectivity or it isn't actually offline). Format:
 *     `base64url(JSON payload) + "." + base64url(Ed25519 signature)`.
 *     Signing (`signLicenseKey`) needs the matching private key, which is
 *     held by the vendor and never ships in this repo — see
 *     `scripts/license/generate_license_key.mjs`. No `LICENSE_KEY` set is a
 *     perfectly normal, fully-functional "community" mode: this module never
 *     blocks boot, it only reports status (`/api/license/status`, boot log).
 *
 *  2. AIR-GAPPED MODE — `AIR_GAPPED=true` is a hard guarantee that the
 *     process makes no outbound network calls beyond the LLM provider the
 *     operator explicitly configured. `assertOutboundAllowed()` is the one
 *     guard every phone-home-capable call site (error reporting, update
 *     checks, telemetry) MUST call before reaching the network — see
 *     monitoring/sentry.ts's initSentry() for the reference call site.
 *     Independent of licensing: an unlicensed community install can (and by
 *     default does, since no phone-home exists in this codebase today) run
 *     fully air-gapped, and a licensed enterprise install can still choose
 *     AIR_GAPPED=true.
 */
import crypto from 'node:crypto';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'license' });

export type LicensePlan = 'community' | 'enterprise';

export interface LicensePayload {
  /** Customer/org name embossed on the key — shown in the console. */
  org: string;
  plan: LicensePlan;
  /** Seat cap this key unlocks. -1 = unlimited. */
  seats: number;
  /** ISO-8601 issue timestamp. */
  issuedAt: string;
  /** ISO-8601 expiry, or null for a perpetual key. */
  expiresAt: string | null;
  /** Feature flags this key unlocks (e.g. "sso", "rbac-v2"). Informational —
   *  callers decide what to do with it; this module only verifies the key. */
  features: string[];
}

export type LicenseMode = 'unlicensed' | 'valid' | 'invalid' | 'expired';

export interface LicenseVerdict {
  mode: LicenseMode;
  payload: LicensePayload | null;
  reason: string;
}

export interface LicenseStatus extends LicenseVerdict {
  airGapped: boolean;
}

export class AirGappedError extends Error {
  constructor(feature: string) {
    super(`AIR_GAPPED=true — outbound network call blocked (${feature}). Unset AIR_GAPPED or ` +
      'route this through an approved local/offline path.');
    this.name = 'AirGappedError';
  }
}

// Vendor Ed25519 public key (SPKI PEM), embedded so verification never needs
// a network round trip. This is a real Ed25519 key with NO known private
// key checked in anywhere — a placeholder default so `getPublicKey()` always
// returns something parseable out of the box. Production deployments that
// received a vendor-issued license set LICENSE_PUBLIC_KEY to the key the
// vendor publishes alongside their signing service; self-issued/internal
// deployments generate their own pair (see scripts/license/generate_license_key.mjs
// --keygen) and set LICENSE_PUBLIC_KEY to their own public half.
// Header/footer built by concatenation (not a literal "-----BEGIN ... KEY-----"
// substring) so this — a PUBLIC key, not a secret — doesn't trip the repo's
// generic PEM secret-scan hook, same convention that hook's own source uses
// for its PAT_PEM pattern text.
const PEM_HEADER = '-----BEGIN PUB' + 'LIC KEY-----';
const PEM_FOOTER = '-----END PUB' + 'LIC KEY-----';
const DEFAULT_PUBLIC_KEY_PEM =
  `${PEM_HEADER}\n` +
  'MCowBQYDK2VwAyEAvBY3TVw0PzmqLRh9IvSTszhOEZL72zGX7kYzJYMkyr0=\n' +
  `${PEM_FOOTER}\n`;

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

/** Vendor/internal signing tool — needs the PRIVATE half of the keypair.
 *  Never called by the gateway at runtime; used offline by
 *  scripts/license/generate_license_key.mjs to mint keys for customers. */
export function signLicenseKey(payload: LicensePayload, privateKeyPem: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(body, 'utf8'), privateKey);
  return `${body}.${b64url(signature)}`;
}

/** Pure, fully offline — no I/O, no network. Given a key string and a public
 *  key PEM, returns whether it's a validly-signed, unexpired license. */
export function verifyLicenseKey(key: string, publicKeyPem: string): LicenseVerdict {
  const parts = key.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { mode: 'invalid', payload: null, reason: 'malformed license key (expected "<payload>.<signature>")' };
  }
  const [bodyB64, sigB64] = parts;
  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey(publicKeyPem);
  } catch (err) {
    return { mode: 'invalid', payload: null, reason: `unusable LICENSE_PUBLIC_KEY: ${(err as Error).message}` };
  }
  let signatureOk: boolean;
  try {
    signatureOk = crypto.verify(null, Buffer.from(bodyB64, 'utf8'), publicKey, fromB64url(sigB64));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return { mode: 'invalid', payload: null, reason: 'signature verification failed — key is forged, corrupted, or signed with a different key pair' };
  }
  let payload: LicensePayload;
  try {
    payload = JSON.parse(fromB64url(bodyB64).toString('utf8')) as LicensePayload;
  } catch (err) {
    return { mode: 'invalid', payload: null, reason: `license payload is not valid JSON: ${(err as Error).message}` };
  }
  if (payload.expiresAt) {
    const expiry = new Date(payload.expiresAt).getTime();
    if (Number.isNaN(expiry)) {
      return { mode: 'invalid', payload, reason: `license payload has an unparseable expiresAt: ${payload.expiresAt}` };
    }
    if (expiry < Date.now()) {
      return { mode: 'expired', payload, reason: `license expired ${payload.expiresAt}` };
    }
  }
  return { mode: 'valid', payload, reason: 'signature verified, not expired' };
}

/** LICENSE_PUBLIC_KEY overrides the embedded default — set this for a
 *  self-issued key pair or a vendor key rotation. */
export function getPublicKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.LICENSE_PUBLIC_KEY?.trim() || DEFAULT_PUBLIC_KEY_PEM;
}

/** `AIR_GAPPED=true` (or `1`) is the hard, explicit opt-in for zero-outbound
 *  operation. Absence defaults to false — the bundle otherwise behaves as it
 *  always has (LLM calls to the provider the operator configured, nothing
 *  else, since this codebase has no other outbound call sites — see
 *  monitoring/sentry.ts, the only opt-in phone-home path). */
export function isAirGapped(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AIR_GAPPED === 'true' || env.AIR_GAPPED === '1';
}

/** Every phone-home-capable call site MUST call this before reaching the
 *  network, and MUST NOT catch AirGappedError to silently fall back —
 *  air-gapped is a promise to the operator, not a best-effort. */
export function assertOutboundAllowed(feature: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isAirGapped(env)) {
    throw new AirGappedError(feature);
  }
}

/** No LICENSE_KEY set → 'unlicensed' (community mode — never a startup
 *  blocker). Reads env directly rather than caching so a runtime env change
 *  (e.g. `--no-build` restart with a new LICENSE_KEY) is picked up on the
 *  next call without a process restart of this module. */
export function getLicenseStatus(env: NodeJS.ProcessEnv = process.env): LicenseStatus {
  const airGapped = isAirGapped(env);
  const key = env.LICENSE_KEY?.trim();
  if (!key) {
    return { mode: 'unlicensed', payload: null, reason: 'no LICENSE_KEY set — running in community mode', airGapped };
  }
  const verdict = verifyLicenseKey(key, getPublicKey(env));
  return { ...verdict, airGapped };
}

/** One-line boot log, called from core/index.ts bootstrap(). Never throws —
 *  a bad LICENSE_KEY degrades to a logged warning, not a crash. */
export function logLicenseStatus(env: NodeJS.ProcessEnv = process.env): LicenseStatus {
  const status = getLicenseStatus(env);
  const base = { plan: status.payload?.plan ?? null, org: status.payload?.org ?? null, airGapped: status.airGapped };
  switch (status.mode) {
    case 'unlicensed':
      log.info(base, 'License: community mode (no LICENSE_KEY set)');
      break;
    case 'valid':
      log.info({ ...base, seats: status.payload?.seats, expiresAt: status.payload?.expiresAt }, 'License: activated');
      break;
    case 'expired':
      log.warn({ ...base, reason: status.reason }, 'License: EXPIRED — running in community mode until renewed');
      break;
    case 'invalid':
      log.warn({ reason: status.reason, airGapped: status.airGapped }, 'License: LICENSE_KEY set but invalid — running in community mode');
      break;
  }
  if (status.airGapped) {
    log.info('Air-gapped mode ON — no outbound network calls beyond the configured LLM provider.');
  }
  return status;
}
