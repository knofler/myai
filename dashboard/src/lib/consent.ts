// Cookie-consent model (GDPR/ePrivacy groundwork for the public site).
//
// Reality check, so the banner stays honest: the dashboard sets ONLY
// functional cookies today — `myai_token` / `myai_operator` (auth sessions),
// `myai_tenant` (workspace scoping) and `myai_locale` (language). There is no
// analytics or marketing tracker anywhere in the codebase. Strictly-necessary
// cookies never require consent; the `preferences` and `analytics` categories
// exist so that (a) the locale cookie is set with an explicit, recorded
// choice, and (b) IF an analytics tool is ever added it MUST check
// `consentFor(state, 'analytics')` before loading — consent-first by
// construction, not retrofitted.
//
// Pure functions only (no document/window) so both the client banner
// (components/cookie-consent.tsx) and any server reader can share them, and
// so the whole model is unit-testable (consent.test.ts).

export const CONSENT_COOKIE = 'myai_consent';

/** Bump when the categories/meaning change — old cookies re-prompt. */
export const CONSENT_VERSION = 1;

/** Re-prompt cadence: consent is not forever (CNIL/EDPB guidance ~6–12 months). */
export const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export type ConsentCategory = 'necessary' | 'preferences' | 'analytics';

export interface ConsentState {
  version: number;
  /** Auth/session/tenant cookies — exempt from consent, always on. */
  necessary: true;
  /** Functional preference cookies (e.g. `myai_locale`). */
  preferences: boolean;
  /** No analytics exist today; recorded so a future tool is consent-gated. */
  analytics: boolean;
  /** ISO timestamp of the recorded choice — the audit trail of consent. */
  decidedAt: string;
}

export function acceptAll(decidedAt: string): ConsentState {
  return { version: CONSENT_VERSION, necessary: true, preferences: true, analytics: true, decidedAt };
}

export function necessaryOnly(decidedAt: string): ConsentState {
  return { version: CONSENT_VERSION, necessary: true, preferences: false, analytics: false, decidedAt };
}

/** Serialize for the cookie value (URI-encoded JSON — survives `; ,` rules). */
export function encodeConsent(state: ConsentState): string {
  return encodeURIComponent(JSON.stringify(state));
}

/**
 * Parse a raw cookie value back into a ConsentState.
 * Returns null (→ re-prompt) on anything malformed, tampered, or from an
 * older CONSENT_VERSION — failing closed is the compliant direction.
 */
export function decodeConsent(raw: string | null | undefined): ConsentState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as Partial<ConsentState>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== CONSENT_VERSION ||
      parsed.necessary !== true ||
      typeof parsed.preferences !== 'boolean' ||
      typeof parsed.analytics !== 'boolean' ||
      typeof parsed.decidedAt !== 'string'
    ) {
      return null;
    }
    return {
      version: CONSENT_VERSION,
      necessary: true,
      preferences: parsed.preferences,
      analytics: parsed.analytics,
      decidedAt: parsed.decidedAt,
    };
  } catch {
    return null;
  }
}

/** Full Set-Cookie-style string for document.cookie writes. */
export function buildConsentCookie(state: ConsentState): string {
  return `${CONSENT_COOKIE}=${encodeConsent(state)}; path=/; max-age=${CONSENT_MAX_AGE_SECONDS}; SameSite=Lax`;
}

/** Extract this cookie's raw value from a `document.cookie` string. */
export function consentFromCookieHeader(cookieHeader: string | null | undefined): ConsentState | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${CONSENT_COOKIE}=([^;]*)`));
  return decodeConsent(m ? m[1] : null);
}

/**
 * The single gate future integrations must call: is this category allowed?
 * No recorded choice → only `necessary` is allowed (opt-in, never opt-out).
 */
export function consentFor(state: ConsentState | null, category: ConsentCategory): boolean {
  if (category === 'necessary') return true;
  if (!state) return false;
  return state[category];
}
