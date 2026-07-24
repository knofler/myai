/**
 * Connector OAuth auto-refresh — pure core. NO I/O and NO DB here so every
 * rule is unit-testable in isolation (see tests/unit/oauth-refresh.test.ts),
 * mirroring the outbound-webhooks split (webhooks/outbound-events.ts).
 *
 * Distinct from a connector-token expiry MONITOR (which only nudges the
 * user): this decides WHEN a token is due for proactive refresh, whether a
 * refresh is even possible (a refresh token exists), and how a provider's
 * token response normalizes into stored state. The actual HTTP refresh call
 * and DB writes live in oauth-refresh-worker.ts.
 */
import type { IConnectorOAuth } from '../shared/db.js';

/** How far ahead of expiry we proactively refresh. */
export const DEFAULT_REFRESH_WINDOW_MS = 15 * 60 * 1000; // 15 min

/** Minimum gap between two re-auth nudges for the same connector. */
export const DEFAULT_NUDGE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Does this connector's OAuth token need attention right now? True once
 * `expiresAt` falls within `windowMs` of `now` (including already expired).
 * A connector with no oauth state (static-credential connector) never does.
 */
export function needsRefresh(
  oauth: IConnectorOAuth | undefined,
  now: Date,
  windowMs: number = DEFAULT_REFRESH_WINDOW_MS,
): boolean {
  if (!oauth?.expiresAt) return false;
  return oauth.expiresAt.getTime() - now.getTime() <= windowMs;
}

/**
 * Given a connector that needs attention, is an actual refresh possible
 * (a refresh token is on file) or must we escalate to a re-auth nudge?
 */
export function classifyAction(oauth: IConnectorOAuth | undefined): 'refresh' | 'nudge' {
  return oauth?.refreshToken ? 'refresh' : 'nudge';
}

/** Has a re-auth nudge already fired within the cooldown window? */
export function shouldThrottleNudge(
  oauth: IConnectorOAuth | undefined,
  now: Date,
  cooldownMs: number = DEFAULT_NUDGE_COOLDOWN_MS,
): boolean {
  if (!oauth?.reauthNudgedAt) return false;
  return now.getTime() - oauth.reauthNudgedAt.getTime() < cooldownMs;
}

/** The normalized shape a provider's token response is reduced to. */
export interface RefreshedTokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  tokenType?: string;
  scope?: string;
}

/** Raw OAuth2 token-endpoint response shape (RFC 6749 §5.1, snake_case). */
export interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
}

const DEFAULT_EXPIRES_IN_SEC = 3600; // conservative fallback if a provider omits expires_in

/**
 * Normalize a raw OAuth2 refresh-grant response into stored token state.
 * Throws if the response has no access_token (a malformed/error response
 * should never silently produce a "successful" refresh).
 *
 * `refresh_token` is optional in the response — most providers reuse the same
 * refresh token across refreshes, so when omitted the caller must keep the
 * existing one (this function returns `undefined` and leaves that decision
 * to the caller, matching how a partial DB $set is built).
 */
export function normalizeTokenResponse(raw: RawTokenResponse, now: Date): RefreshedTokenBundle {
  if (typeof raw.access_token !== 'string' || !raw.access_token) {
    throw new Error('OAuth refresh response missing access_token');
  }
  const expiresInSec = typeof raw.expires_in === 'number' && raw.expires_in > 0
    ? raw.expires_in
    : DEFAULT_EXPIRES_IN_SEC;
  return {
    accessToken: raw.access_token,
    refreshToken: typeof raw.refresh_token === 'string' && raw.refresh_token ? raw.refresh_token : undefined,
    expiresAt: new Date(now.getTime() + expiresInSec * 1000),
    tokenType: typeof raw.token_type === 'string' ? raw.token_type : undefined,
    scope: typeof raw.scope === 'string' ? raw.scope : undefined,
  };
}
