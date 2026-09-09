/**
 * GATEWAY_LOCAL_TOKEN self-rotation (ADR-010 §3.6 sibling — the bridge
 * credential, not a tenant key).
 *
 * Unlike tenant-keys.ts (rotateApiKey), the local token is not DB-backed —
 * it lives only in the running process's config.tenancy. `rotateLocalToken`
 * mutates that live object in place (config.tenancy is read fresh on every
 * auth check — see core/auth.ts tenancyConfig()) so the new token is valid
 * immediately and, for the configured grace window, so is the OLD one
 * (core/auth.ts resolveNoKey's dual-valid check) — zero-downtime rotation
 * with no restart required.
 *
 * This only updates the IN-MEMORY config. It does not touch .env — the
 * process's env vars are what re-seed config.tenancy.localToken on the next
 * restart, so an operator or scheduled job calling this must also persist
 * the returned token (GATEWAY_LOCAL_TOKEN=<token>, plus
 * GATEWAY_LOCAL_TOKEN_PREVIOUS/_EXPIRES_AT for the grace window) into .env,
 * or a restart silently reverts to the pre-rotation token. `myai rotate-keys
 * local` (cli/main.ts) does this for the common host-CLI case.
 */
import crypto from 'node:crypto';
import { getConfig, KNOWN_DEFAULT_LOCAL_TOKEN } from '../shared/config.js';

/** Default rotation grace window — the old local token keeps working this long. */
const DEFAULT_GRACE_MINUTES = Number(process.env.GATEWAY_LOCAL_TOKEN_ROTATION_GRACE_MINUTES) || 60;
const MAX_GRACE_MINUTES = 7 * 24 * 60; // 7 days — generous but bounded ceiling

export interface LocalTokenRotationResult {
  /** The new token — show-once, same convention as tenant/API key rotation. */
  token: string;
  /** The token that keeps authenticating until previousExpiresAt (absent when graceMinutes is 0, there was no prior token to grace, or the prior token was the published KNOWN_DEFAULT_LOCAL_TOKEN — a public value gets no grace). */
  previousToken?: string;
  previousExpiresAt?: number;
  graceMinutes: number;
}

/** Generate a fresh local-bridge token. `crypto.randomBytes` — never Math.random. */
function generateLocalToken(): string {
  return `myai_local_${crypto.randomBytes(32).toString('base64url')}`;
}

/**
 * Rotate GATEWAY_LOCAL_TOKEN with a dual-valid grace overlap: the OLD token
 * moves to config.tenancy.previousLocalToken and keeps authenticating
 * (auth.ts resolveNoKey) until previousLocalTokenExpiresAt.
 * `graceMinutes: 0` is an immediate cutover (no previous token kept), same
 * convention as tenant-keys.ts rotateApiKey.
 */
export function rotateLocalToken(graceMinutes?: number): LocalTokenRotationResult {
  const config = getConfig();
  const graceMin = Math.min(Math.max(graceMinutes ?? DEFAULT_GRACE_MINUTES, 0), MAX_GRACE_MINUTES);
  const oldToken = config.tenancy.localToken;
  const newToken = generateLocalToken();

  config.tenancy.localToken = newToken;
  // The published compose/.mcp.json default is PUBLIC KNOWLEDGE (it ships in
  // the npm package) — rotating away from it is a credential CUT-OFF, not a
  // migration, so it never gets a grace window (config.ts loadConfig refuses
  // it as previousLocalToken on restart for the same reason).
  if (graceMin > 0 && oldToken && oldToken !== KNOWN_DEFAULT_LOCAL_TOKEN) {
    config.tenancy.previousLocalToken = oldToken;
    config.tenancy.previousLocalTokenExpiresAt = Date.now() + graceMin * 60_000;
  } else {
    config.tenancy.previousLocalToken = undefined;
    config.tenancy.previousLocalTokenExpiresAt = undefined;
  }

  return {
    token: newToken,
    previousToken: config.tenancy.previousLocalToken,
    previousExpiresAt: config.tenancy.previousLocalTokenExpiresAt,
    graceMinutes: graceMin,
  };
}
