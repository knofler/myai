/**
 * Inbound-webhook support: per-tenant signing-secret resolution + delivery-id
 * dedup guard. Complements the outbound side (webhook-store.ts enqueues
 * *our* signed deliveries out to a tenant's endpoint); this is the receive
 * direction — GitHub (or another sender) posts to us and we verify + dedupe
 * per tenant.
 *
 * GATEWAY inbound-webhook task.
 */
import { TenantModel, InboundWebhookDeliveryModel, isConnected, DEFAULT_TENANT_ID } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'inbound-webhook-store' });

/**
 * Resolve the GitHub webhook signing secret for `tenantId`. Prefers the
 * tenant's own `githubWebhookSecret` (set via tenant admin, not yet exposed
 * over REST); falls back to the process-wide `GITHUB_WEBHOOK_SECRET` env var
 * ONLY for the default (single-operator/self-host) tenant, so existing
 * self-host setups keep working unchanged. Returns '' when no secret is
 * configured — callers treat that as "skip verification" (self-host dev
 * default), matching the pre-existing behaviour of the legacy route.
 */
export async function resolveGithubWebhookSecret(tenantId: string): Promise<string> {
  if (isConnected()) {
    const tenant = await TenantModel.findOne({ tenantId })
      .select('+githubWebhookSecret')
      .lean<{ githubWebhookSecret?: string } | null>();
    if (tenant?.githubWebhookSecret) return tenant.githubWebhookSecret;
  }
  if (tenantId === DEFAULT_TENANT_ID) return process.env.GITHUB_WEBHOOK_SECRET || '';
  return '';
}

/**
 * Record `deliveryId` as seen for (tenantId, source). Returns true if it was
 * ALREADY seen (a duplicate — GitHub redelivering, or a receiver-side retry
 * racing itself) and false if this is the first time. The unique index on
 * (tenantId, source, deliveryId) is the actual dedupe guard — this is an
 * insert-and-check-for-conflict, not a racy read-then-write.
 */
export async function isDuplicateDelivery(
  tenantId: string,
  source: string,
  deliveryId: string,
): Promise<boolean> {
  if (!deliveryId) return false; // no delivery id to dedupe on — let it through
  if (!isConnected()) return false; // best-effort only; never block processing on DB absence

  try {
    await InboundWebhookDeliveryModel.create({ tenantId, source, deliveryId });
    return false;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return true;
    log.warn({ err, tenantId, source, deliveryId }, 'delivery-dedup insert failed (non-duplicate error) — allowing through');
    return false;
  }
}
