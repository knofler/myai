/**
 * Notification service — the glue between the event bus and its sinks.
 *
 * Subscribes once to {@link notifyBus} and, for every event:
 *   1. pushes it to the tenant's live SSE connections (real-time, in-app), and
 *   2. records it to the DB via the notifier (durable history — `/api/notifications`).
 *
 * It deliberately does NOT fan events out to Telegram/Discord: those are
 * external channels reserved for explicit `notifications_send` calls and health
 * alerts, not per-task activity (which would be noisy and costly).
 *
 * Delivery is gated by the tenant's notification preferences (Phase 7):
 *   - a muted event family skips SSE + push + email but is STILL recorded to history,
 *   - `inApp: false` silences SSE, `push: false` silences web push,
 *     `email: false` silences email (opt-in, off by default),
 *   - quiet hours suppress the out-of-app channels (push + email) only (no phone
 *     buzz or inbox ping overnight; the in-app feed and history are unaffected).
 * Web push (Phase 6) and email both fire only when the tenant has no live SSE
 * connection — an open dashboard already showed the toast.
 *
 * Storm control (see {@link ./dedup.js}): identical (tenantId, type, subject)
 * events within a window collapse into one history row with an "xN" counter,
 * and each channel is separately throttled to a per-tenant min-interval — a
 * retry loop or flapping runner can't flood SSE/push/email with duplicates.
 *
 * REALTIME_NOTIFICATIONS plan, Phases 3+4 wired to Phases 6+7.
 */
import { createChildLogger } from '../shared/logger.js';
import { notifyBus } from './event-bus.js';
import type { NotifyEvent } from './event-bus.js';
import { sseManager } from './sse-manager.js';
import { recordNotification } from './notifier.js';
import { getPreferences, eventEnabled, isQuietHours } from './preferences.js';
import { sendPushIfInactive } from './web-push.js';
import { sendEmailIfInactive } from './email-notify.js';
import { registerEvent, shouldDeliverToChannel } from './dedup.js';

const log = createChildLogger({ module: 'notify-service' });

/** Channel label for events that originate in-app (vs telegram/discord). */
export const SSE_CHANNEL = 'sse';

let unsubscribe: (() => void) | null = null;

/**
 * Start the service (idempotent). Safe to call from both `bootstrap()` and
 * `createHttpServer()` — only the first call subscribes.
 */
export function startNotificationService(): void {
  if (unsubscribe) return;
  unsubscribe = notifyBus.on(handleEvent);
  log.info('Notification service started — bus → SSE + DB');
}

/** Stop the service (test isolation / shutdown). */
export function stopNotificationService(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

async function handleEvent(event: NotifyEvent): Promise<void> {
  // Preferences gate (Phase 7). getPreferences never throws — defaults flow on
  // any DB hiccup so delivery is never blocked by the prefs lookup.
  const prefs = await getPreferences(event.tenantId);
  const allowed = eventEnabled(prefs, event.type);

  // Storm control: identical (tenantId, type, subject) events collapse into one
  // burst — repeats within the dedup window still get evaluated for delivery,
  // but each channel is throttled to its own min-interval, and the history
  // write below upserts onto the same row with an "xN" counter.
  const subject = (typeof event.data?.subject === 'string' ? (event.data.subject as string) : undefined) ?? event.title;
  const dedup = registerEvent(event.tenantId, event.type, subject);

  // 1. Real-time push to any open SSE connections for this tenant.
  if (allowed && prefs.inApp && shouldDeliverToChannel(event.tenantId, event.type, subject, 'sse')) {
    sseManager.send(event.tenantId, event);
  }

  // 2. Out-of-app channels (Phase 6+7) — only outside quiet hours and only when
  //    nobody has the app open. Each is a no-op unless configured (VAPID keys
  //    for push, SMTP for email).
  if (allowed && !isQuietHours(prefs)) {
    if (prefs.push && shouldDeliverToChannel(event.tenantId, event.type, subject, 'push')) {
      await sendPushIfInactive(event.tenantId, event);
    }
    if (prefs.email && shouldDeliverToChannel(event.tenantId, event.type, subject, 'email')) {
      await sendEmailIfInactive(event.tenantId, event);
    }
  }

  // 3. Durable history — even for muted events (mute silences delivery, not
  //    the record). Failures are swallowed inside recordNotification —
  //    persistence must never break the emitter or the SSE push above. Repeats
  //    in the same burst collapse onto one row via dedupKey, message suffixed
  //    with the running count.
  const baseMessage = event.message ?? event.title;
  await recordNotification(event.tenantId, {
    channel: SSE_CHANNEL,
    chatId: event.tenantId,
    message: dedup.count > 1 ? `${baseMessage} (x${dedup.count})` : baseMessage,
    level: event.level,
    title: event.title,
    source: event.source ?? event.type,
    sentAt: event.timestamp,
    success: true,
    dedupKey: dedup.burstId,
    count: dedup.count,
  });
}
