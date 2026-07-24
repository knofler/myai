/**
 * Web Push delivery — VAPID push to subscribed browsers when nobody has the
 * dashboard open (REALTIME_NOTIFICATIONS plan, Phase 6; pairs with the
 * dashboard PWA service worker).
 *
 * Configuration is via env (see docker-compose gateway service):
 *   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY  — `npx web-push generate-vapid-keys`
 *   VAPID_SUBJECT                          — mailto:/https: contact (optional)
 * Unset keys → the whole module is a silent no-op and the subscription API
 * reports push as not configured.
 *
 * The `web-push` library is loaded lazily on first send, so host-side CLI code
 * paths that import this module never pay for (or require) the dependency.
 * Dead subscriptions (HTTP 404/410 from the push service) are pruned from the
 * DB automatically.
 */
import { createChildLogger } from '../shared/logger.js';
import { isConnected } from '../shared/db.js';
import { tenantScope, withTenant } from '../shared/scoped-query.js';
import { sseManager } from './sse-manager.js';
import type { NotifyEvent } from './event-bus.js';

const log = createChildLogger({ module: 'web-push' });

/** The subscription JSON a browser's PushManager.subscribe() produces. */
export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSendResult {
  sent: number;
  failed: number;
  pruned: number;
  skipped?: 'not-configured' | 'active-sse' | 'no-subscriptions';
}

// ── Configuration ───────────────────────────────────────────

export function isPushConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function getVapidPublicKey(): string | undefined {
  return process.env.VAPID_PUBLIC_KEY || undefined;
}

// ── web-push loader (lazy, test-injectable) ─────────────────

interface WebPushLike {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(sub: PushSubscriptionJSON, payload: string): Promise<unknown>;
}

let webPushImpl: WebPushLike | null = null;
let loadFailed = false;

async function loadWebPush(): Promise<WebPushLike | null> {
  if (webPushImpl) return webPushImpl;
  if (loadFailed) return null;
  try {
    const mod = await import('web-push');
    webPushImpl = (mod.default ?? mod) as unknown as WebPushLike;
    return webPushImpl;
  } catch (err) {
    loadFailed = true; // log once, then stay silent — push simply won't deliver
    log.warn({ err }, 'web-push module unavailable — push delivery disabled');
    return null;
  }
}

/** Test hook: inject a fake web-push implementation (null resets to real). */
export function setWebPushImplForTests(impl: WebPushLike | null): void {
  webPushImpl = impl;
  loadFailed = false;
}

// ── Subscription store ──────────────────────────────────────

export function isValidSubscription(input: unknown): input is PushSubscriptionJSON {
  if (!input || typeof input !== 'object') return false;
  const sub = input as PushSubscriptionJSON;
  return (
    typeof sub.endpoint === 'string' && sub.endpoint.startsWith('https://') &&
    !!sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string'
  );
}

/** Upsert a browser subscription (keyed by its globally-unique endpoint). */
export async function saveSubscription(tenantId: string, sub: PushSubscriptionJSON, userAgent?: string): Promise<void> {
  if (!isConnected()) throw new Error('database unavailable');
  const { PushSubscriptionModel } = await import('../shared/db.js');
  if (!PushSubscriptionModel) throw new Error('database unavailable');
  await PushSubscriptionModel.findOneAndUpdate(
    { endpoint: sub.endpoint },
    { $set: { ...tenantScope(tenantId), keys: sub.keys, userAgent } },
    { upsert: true },
  );
}

/** Remove a subscription by endpoint (tenant-scoped). Returns true if removed. */
export async function removeSubscription(tenantId: string, endpoint: string): Promise<boolean> {
  if (!isConnected()) throw new Error('database unavailable');
  const { PushSubscriptionModel } = await import('../shared/db.js');
  if (!PushSubscriptionModel) throw new Error('database unavailable');
  const res = await PushSubscriptionModel.deleteOne(withTenant(tenantId, { endpoint }));
  return (res.deletedCount ?? 0) > 0;
}

/** Count of registered subscriptions for a tenant (settings UI). */
export async function countSubscriptions(tenantId: string): Promise<number> {
  if (!isConnected()) return 0;
  try {
    const { PushSubscriptionModel } = await import('../shared/db.js');
    if (!PushSubscriptionModel) return 0;
    return await PushSubscriptionModel.countDocuments(tenantScope(tenantId));
  } catch {
    return 0;
  }
}

// ── Delivery ────────────────────────────────────────────────

function buildPayload(event: NotifyEvent): string {
  return JSON.stringify({
    title: event.title,
    body: event.message ?? '',
    level: event.level,
    type: event.type,
    url: '/notifications',
    sentAt: event.timestamp,
  });
}

/**
 * Push an event to every subscription of the tenant. Never throws; dead
 * endpoints (404/410) are pruned.
 */
export async function sendPushToTenant(tenantId: string, event: NotifyEvent): Promise<PushSendResult> {
  if (!isPushConfigured()) return { sent: 0, failed: 0, pruned: 0, skipped: 'not-configured' };
  if (!isConnected()) return { sent: 0, failed: 0, pruned: 0, skipped: 'no-subscriptions' };

  let subs: Array<PushSubscriptionJSON> = [];
  try {
    const { PushSubscriptionModel } = await import('../shared/db.js');
    if (!PushSubscriptionModel) return { sent: 0, failed: 0, pruned: 0, skipped: 'no-subscriptions' };
    subs = await PushSubscriptionModel.find(tenantScope(tenantId)).lean<PushSubscriptionJSON[]>();
  } catch (err) {
    log.warn({ err, tenantId }, 'Failed to load push subscriptions');
    return { sent: 0, failed: 0, pruned: 0 };
  }
  if (subs.length === 0) return { sent: 0, failed: 0, pruned: 0, skipped: 'no-subscriptions' };

  const webpush = await loadWebPush();
  if (!webpush) return { sent: 0, failed: 0, pruned: 0, skipped: 'not-configured' };
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@localhost',
    process.env.VAPID_PUBLIC_KEY as string,
    process.env.VAPID_PRIVATE_KEY as string,
  );

  const payload = buildPayload(event);
  const result: PushSendResult = { sent: 0, failed: 0, pruned: 0 };
  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
      result.sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // Subscription expired or revoked — prune it.
        try {
          await removeSubscription(tenantId, sub.endpoint);
          result.pruned++;
        } catch {
          result.failed++;
        }
      } else {
        result.failed++;
        log.warn({ err, tenantId, status }, 'Web push send failed');
      }
    }
  }
  if (result.sent || result.pruned) {
    log.debug({ tenantId, ...result, type: event.type }, 'Web push delivered');
  }
  return result;
}

/**
 * Push only when the tenant has no live in-app connection — an open dashboard
 * already showed the toast, so a push would be a duplicate buzz.
 */
export async function sendPushIfInactive(tenantId: string, event: NotifyEvent): Promise<PushSendResult> {
  if (sseManager.hasClient(tenantId)) return { sent: 0, failed: 0, pruned: 0, skipped: 'active-sse' };
  return sendPushToTenant(tenantId, event);
}
