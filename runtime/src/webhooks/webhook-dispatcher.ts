/**
 * Outbound-webhook dispatcher — the glue between the in-process notify bus and
 * tenant-registered HTTP endpoints, plus the retry worker that drains the
 * delivery queue with at-least-once semantics.
 *
 * Two moving parts:
 *   1. Bus subscriber — on every activity event, derive the canonical webhook
 *      event(s), and for each active endpoint subscribed to a matching event,
 *      enqueue a WebhookDelivery (fire-and-forget; never blocks the emitter).
 *   2. Retry worker — a setInterval that claims due deliveries, POSTs an
 *      HMAC-signed payload, and on failure reschedules with exponential backoff
 *      or dead-letters once attempts are exhausted.
 *
 * INERT until endpoints exist: a tenant with no webhooks enqueues nothing, and
 * the worker is a no-op when the queue is empty. Disable entirely with
 * WEBHOOKS_DISABLED=1.
 *
 * OUTBOUND_WEBHOOKS plan, Phase 3 (dispatch + delivery).
 */
import { createChildLogger } from '../shared/logger.js';
import { notifyBus } from '../notifications/event-bus.js';
import type { NotifyEvent } from '../notifications/event-bus.js';
import {
  deriveWebhookEvents,
  eventMatches,
  signPayload,
  nextFailureState,
  isDeliverySuccess,
  SIGNATURE_HEADER,
  EVENT_HEADER,
  DELIVERY_HEADER,
} from './outbound-events.js';
import {
  activeEndpoints,
  enqueueDelivery,
  claimDueDelivery,
  markDelivered,
  markFailedAttempt,
} from './webhook-store.js';
import type { IWebhookDelivery } from '../shared/db.js';

const log = createChildLogger({ module: 'webhook-dispatcher' });

export const DEFAULT_WORKER_INTERVAL_MS = 5_000;
const DELIVERY_TIMEOUT_MS = 10_000;

let unsubscribe: (() => void) | null = null;
let workerId: ReturnType<typeof setInterval> | null = null;
let draining = false;

// ── Bus subscriber ───────────────────────────────────────────────────

/**
 * Handle one bus event: fan it out to matching endpoints as enqueued
 * deliveries. Async but never awaited by the bus — errors are isolated so a
 * broken enqueue can never break a task write.
 */
export async function handleBusEvent(event: NotifyEvent): Promise<void> {
  const webhookEvents = deriveWebhookEvents(event);
  if (webhookEvents.length === 0) return;

  const endpoints = await activeEndpoints(event.tenantId);
  if (endpoints.length === 0) return;

  for (const wev of webhookEvents) {
    for (const ep of endpoints) {
      if (!eventMatches(ep.events, wev)) continue;
      const payload = {
        event: wev,
        tenantId: event.tenantId,
        timestamp: event.timestamp.toISOString(),
        title: event.title,
        message: event.message,
        source: event.source,
        data: event.data ?? {},
      };
      try {
        await enqueueDelivery(event.tenantId, {
          endpointId: ep.endpointId,
          url: ep.url,
          event: wev,
          payload,
        });
      } catch (err) {
        log.warn({ err, endpointId: ep.endpointId, event: wev }, 'failed to enqueue webhook delivery');
      }
    }
  }
}

// ── HTTP delivery ────────────────────────────────────────────────────

/**
 * Attempt one HTTP POST. Returns the status code on an HTTP response (even
 * 4xx/5xx) or throws on a network/timeout error. Isolated so the worker can
 * translate the outcome into delivered / retry / dead uniformly.
 */
export async function deliverOnce(
  url: string,
  secret: string,
  event: string,
  deliveryId: string,
  body: string,
  nowSec: number,
): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'myai-webhooks/1',
        [EVENT_HEADER]: event,
        [DELIVERY_HEADER]: deliveryId,
        [SIGNATURE_HEADER]: signPayload(secret, body, nowSec),
      },
      body,
      signal: controller.signal,
    });
    // Drain the body so the socket can be reused / closed cleanly.
    await res.text().catch(() => undefined);
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Process ONE claimed delivery end-to-end. `secretFor` resolves the endpoint's
 * signing secret (injected for testability). Records the outcome via the store.
 */
export async function processDelivery(
  delivery: IWebhookDelivery,
  secretFor: (tenantId: string, endpointId: string) => Promise<string | null>,
  now: Date = new Date(),
): Promise<'delivered' | 'retrying' | 'dead'> {
  const secret = await secretFor(delivery.tenantId, delivery.endpointId);
  if (!secret) {
    // Endpoint deleted mid-flight — nothing to sign with; dead-letter it.
    await markFailedAttempt(delivery.tenantId, delivery.deliveryId, {
      next: { status: 'dead' },
      error: 'endpoint no longer exists',
    });
    return 'dead';
  }

  const body = JSON.stringify(delivery.payload);
  const nowSec = Math.floor(now.getTime() / 1000);
  try {
    const statusCode = await deliverOnce(
      delivery.url,
      secret,
      delivery.event,
      delivery.deliveryId,
      body,
      nowSec,
    );
    if (isDeliverySuccess(statusCode)) {
      await markDelivered(delivery.tenantId, delivery.deliveryId, statusCode, now);
      return 'delivered';
    }
    const next = nextFailureState(delivery.attempts, delivery.maxAttempts);
    await markFailedAttempt(delivery.tenantId, delivery.deliveryId, {
      next,
      error: `HTTP ${statusCode}`,
      statusCode,
      now,
    });
    return next.status;
  } catch (err) {
    const next = nextFailureState(delivery.attempts, delivery.maxAttempts);
    await markFailedAttempt(delivery.tenantId, delivery.deliveryId, {
      next,
      error: (err as Error).message ?? 'network error',
      now,
    });
    return next.status;
  }
}

// ── Worker ───────────────────────────────────────────────────────────

/** Resolve an endpoint's secret from the store (worker path). */
async function endpointSecret(tenantId: string, endpointId: string): Promise<string | null> {
  const { WebhookEndpointModel } = await import('../shared/db.js');
  const doc = await WebhookEndpointModel.findOne({ tenantId, endpointId })
    .select('secret')
    .lean<{ secret: string }>();
  return doc?.secret ?? null;
}

/**
 * Drain all currently-due deliveries. Claims one at a time (atomic) until the
 * queue is empty, so a burst is worked down within a single tick. Re-entrancy
 * guarded — a long drain won't overlap the next interval.
 */
export async function drainDeliveries(now: Date = new Date(), max = 100): Promise<number> {
  if (draining) return 0;
  draining = true;
  let processed = 0;
  try {
    while (processed < max) {
      const delivery = await claimDueDelivery(now);
      if (!delivery) break;
      await processDelivery(delivery, endpointSecret, now).catch(err =>
        log.error({ err, deliveryId: delivery.deliveryId }, 'delivery processing threw'),
      );
      processed++;
    }
  } finally {
    draining = false;
  }
  if (processed > 0) log.debug({ processed }, 'webhook deliveries drained');
  return processed;
}

/**
 * Start the dispatcher (idempotent): subscribe to the bus and launch the retry
 * worker. No-op when WEBHOOKS_DISABLED=1.
 */
export function startWebhookDispatcher(intervalMs = DEFAULT_WORKER_INTERVAL_MS): void {
  if (process.env.WEBHOOKS_DISABLED === '1') {
    log.info('Webhook dispatcher disabled by WEBHOOKS_DISABLED=1');
    return;
  }
  if (unsubscribe) return;
  unsubscribe = notifyBus.on(event => {
    void handleBusEvent(event).catch(err =>
      log.warn({ err, type: event.type }, 'webhook bus handler failed'),
    );
  });
  workerId = setInterval(() => {
    void drainDeliveries().catch(err => log.error({ err }, 'webhook drain tick failed'));
  }, intervalMs);
  workerId.unref?.();
  log.info({ intervalMs }, 'Webhook dispatcher started — bus → delivery queue → HTTP');
}

/** Stop the dispatcher (shutdown / test isolation). */
export function stopWebhookDispatcher(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (workerId) {
    clearInterval(workerId);
    workerId = null;
  }
}
