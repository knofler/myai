/**
 * Connector OAuth auto-refresh worker — background job that proactively
 * refreshes a tenant connector's OAuth token before it expires, so a
 * scheduled run never fails on a dead credential.
 *
 * Distinct from a connector-token expiry MONITOR (which would only nudge the
 * user): this actually performs the refresh where a refresh token exists on
 * file, and only escalates to a re-auth nudge when refresh is impossible
 * (no refresh token, or the provider rejects it — e.g. it was revoked).
 *
 * Same setInterval-worker shape as webhooks/webhook-dispatcher.ts: a periodic
 * tick sweeps every tenant for connectors whose token is due (cross-tenant,
 * like the schedule tick), never blocking on a single slow/broken refresh.
 * Disable with CONNECTOR_OAUTH_REFRESH_DISABLED=1.
 */
import { createChildLogger } from '../shared/logger.js';
import { recordAuditEvent } from '../core/audit-log.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';
import {
  findExpiringOAuthConnectors,
  setConnectorOAuthTokens,
  recordConnectorRefreshFailure,
  markConnectorReauthNudged,
  type ExpiringOAuthConnector,
} from '../repos/connector-store.js';
import {
  needsRefresh,
  classifyAction,
  shouldThrottleNudge,
  normalizeTokenResponse,
  DEFAULT_REFRESH_WINDOW_MS,
  type RefreshedTokenBundle,
  type RawTokenResponse,
} from './oauth-refresh-core.js';

const log = createChildLogger({ module: 'oauth-refresh-worker' });

export const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 min

/** Per-connector-key OAuth2 refresh-grant endpoint + app credential env vars. */
interface ProviderConfig {
  tokenUrl: string;
  clientIdEnv: string;
  clientSecretEnv: string;
}

/** Only the bundled connectors that "authenticate in-app (OAuth)" need this. */
const PROVIDER_CONFIG: Record<string, ProviderConfig> = {
  vercel: {
    tokenUrl: 'https://api.vercel.com/v2/oauth/access_token',
    clientIdEnv: 'VERCEL_OAUTH_CLIENT_ID',
    clientSecretEnv: 'VERCEL_OAUTH_CLIENT_SECRET',
  },
  dropbox: {
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    clientIdEnv: 'DROPBOX_OAUTH_CLIENT_ID',
    clientSecretEnv: 'DROPBOX_OAUTH_CLIENT_SECRET',
  },
};

/** True if we know how to refresh this connector's provider at all. */
export function isRefreshableProvider(key: string): boolean {
  return key in PROVIDER_CONFIG;
}

/**
 * Call the provider's token endpoint with a refresh_token grant. Injectable
 * `fetchImpl` for tests; real callers use the global fetch.
 */
export async function callProviderRefresh(
  key: string,
  refreshToken: string,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshedTokenBundle> {
  const provider = PROVIDER_CONFIG[key];
  if (!provider) throw new Error(`no OAuth refresh provider configured for connector "${key}"`);
  const clientId = process.env[provider.clientIdEnv];
  const clientSecret = process.env[provider.clientSecretEnv];
  if (!clientId || !clientSecret) {
    throw new Error(`missing ${provider.clientIdEnv}/${provider.clientSecretEnv} — cannot refresh "${key}"`);
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetchImpl(provider.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const raw = (await res.json().catch(() => ({}))) as RawTokenResponse & { error?: string; error_description?: string };
  if (!res.ok) {
    throw new Error(raw.error_description || raw.error || `HTTP ${res.status}`);
  }
  return normalizeTokenResponse(raw, now);
}

/** True for a provider error that means the refresh token itself is dead (never retryable). */
function isTerminalRefreshError(message: string): boolean {
  return /invalid_grant|invalid_token|unauthorized_client/i.test(message);
}

export type RefreshOutcome = 'refreshed' | 'nudged' | 'failed' | 'skipped';

/**
 * Process ONE expiring connector end-to-end: refresh if possible, else
 * escalate a throttled re-auth nudge. `refresher` is injected for testability
 * (defaults to the real provider call).
 */
export async function processExpiringConnector(
  row: ExpiringOAuthConnector,
  now: Date = new Date(),
  refresher: typeof callProviderRefresh = callProviderRefresh,
): Promise<RefreshOutcome> {
  if (!needsRefresh(row.oauth, now)) return 'skipped';

  const action = classifyAction(row.oauth);
  if (action === 'nudge' || !isRefreshableProvider(row.key)) {
    return nudgeReauth(row, now);
  }

  try {
    const tokens = await refresher(row.key, row.oauth.refreshToken as string, now);
    await setConnectorOAuthTokens(row.tenantId, row.key, tokens, now);
    recordAuditEvent({
      tenantId: row.tenantId,
      actor: { role: 'system', via: 'system' },
      action: 'connector.change',
      target: row.key,
      detail: { reason: 'oauth-auto-refresh', expiresAt: tokens.expiresAt.toISOString() },
    });
    return 'refreshed';
  } catch (err) {
    const message = (err as Error).message ?? 'refresh failed';
    await recordConnectorRefreshFailure(row.tenantId, row.key, message);
    log.warn({ tenantId: row.tenantId, key: row.key, err: message }, 'connector OAuth refresh failed');
    if (isTerminalRefreshError(message)) {
      return nudgeReauth(row, now);
    }
    return 'failed';
  }
}

/** Escalate to a re-auth nudge, throttled so a stuck connector doesn't spam the tenant. */
async function nudgeReauth(row: ExpiringOAuthConnector, now: Date): Promise<RefreshOutcome> {
  if (shouldThrottleNudge(row.oauth, now)) return 'skipped';

  await markConnectorReauthNudged(row.tenantId, row.key, now);
  emitNotifyEvent({
    type: 'connector.reauth_required',
    tenantId: row.tenantId,
    title: `${row.label} needs re-authentication`,
    message: `The connection to ${row.label} is expiring and can't be refreshed automatically — reconnect it in the connector manager.`,
    level: 'warning',
    source: 'oauth-refresh-worker',
    data: { key: row.key },
  });
  recordAuditEvent({
    tenantId: row.tenantId,
    actor: { role: 'system', via: 'system' },
    action: 'connector.change',
    target: row.key,
    detail: { reason: 'oauth-reauth-nudge' },
  });
  return 'nudged';
}

export interface SweepResult {
  due: number;
  refreshed: number;
  nudged: number;
  failed: number;
  skipped: number;
}

/**
 * Sweep every tenant for connectors whose OAuth token is due (within the
 * refresh window) and process each. Cross-tenant, like the cron scheduler's
 * `tick` — each row carries its own tenantId.
 */
export async function sweepOnce(
  now: Date = new Date(),
  windowMs: number = DEFAULT_REFRESH_WINDOW_MS,
): Promise<SweepResult> {
  const result: SweepResult = { due: 0, refreshed: 0, nudged: 0, failed: 0, skipped: 0 };
  const due = await findExpiringOAuthConnectors(new Date(now.getTime() + windowMs));
  result.due = due.length;
  if (!due.length) return result;

  for (const row of due) {
    try {
      const outcome = await processExpiringConnector(row, now);
      result[outcome]++;
    } catch (err) {
      log.error({ err, tenantId: row.tenantId, key: row.key }, 'oauth refresh sweep entry threw');
      result.failed++;
    }
  }
  if (result.refreshed || result.nudged || result.failed) {
    log.info(result, 'connector OAuth refresh sweep complete');
  }
  return result;
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let ticking = false;

async function safeTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await sweepOnce();
  } catch (err) {
    log.error({ err }, 'oauth refresh tick failed');
  } finally {
    ticking = false;
  }
}

/** Start the worker (idempotent). No-op when CONNECTOR_OAUTH_REFRESH_DISABLED=1. */
export function startOAuthRefreshWorker(intervalMs = DEFAULT_TICK_INTERVAL_MS): void {
  if (process.env.CONNECTOR_OAUTH_REFRESH_DISABLED === '1') {
    log.info('Connector OAuth auto-refresh disabled by CONNECTOR_OAUTH_REFRESH_DISABLED=1');
    return;
  }
  if (intervalId) return;
  intervalId = setInterval(() => { void safeTick(); }, intervalMs);
  intervalId.unref?.();
  log.info({ intervalMs }, 'Connector OAuth auto-refresh worker started');
}

/** Stop the worker (shutdown / test isolation). */
export function stopOAuthRefreshWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
