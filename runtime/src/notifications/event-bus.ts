/**
 * In-memory notification event bus (pub/sub).
 *
 * Distinct from `hooks/event-bus.ts` — that bus runs blocking lifecycle hooks
 * (a hook can veto an action). THIS bus is a fire-and-forget fan-out for
 * real-time activity events (task created, dispatch finished, message routed).
 * Subscribers (SSE push, DB persistence via the notifier) react to events but
 * can never block or fail the emitter.
 *
 * Emitting is synchronous and never throws: handler errors are isolated and
 * logged so a slow/broken SSE subscriber can't crash a task write.
 *
 * REALTIME_NOTIFICATIONS plan, Phase 1 (event bus) + Phase 2 (emit points).
 */
import { createChildLogger } from '../shared/logger.js';
import type { NotificationLevel } from './notifier.js';

const log = createChildLogger({ module: 'notify-bus' });

/**
 * A real-time notification event. `tenantId` scopes delivery — SSE clients only
 * receive events for their own tenant. `level` reuses the notifier's enum so
 * events persist cleanly into the existing Notification model.
 */
export interface NotifyEvent {
  /** Dotted event type, e.g. "task.created", "dispatch.completed". */
  type: string;
  tenantId: string;
  title: string;
  message?: string;
  level: NotificationLevel;
  /** Where the event originated (e.g. "task-store", "dispatch-worker"). */
  source?: string;
  /** Arbitrary structured context (taskId, repo, agent, counts, …). */
  data?: Record<string, unknown>;
  timestamp: Date;
}

/** Fields the caller supplies; `timestamp` is stamped by the bus if omitted. */
export type NotifyEventInput = Omit<NotifyEvent, 'timestamp'> & { timestamp?: Date };

export type NotifyHandler = (event: NotifyEvent) => void | Promise<void>;

class NotifyBus {
  private handlers = new Set<NotifyHandler>();

  /** Subscribe. Returns an unsubscribe function. */
  on(handler: NotifyHandler): () => void {
    this.handlers.add(handler);
    return () => this.off(handler);
  }

  off(handler: NotifyHandler): void {
    this.handlers.delete(handler);
  }

  /**
   * Fan an event out to every subscriber. Never throws and never blocks the
   * caller: each handler runs inside a try/catch, and async handlers are not
   * awaited (rejections are caught and logged).
   */
  emit(event: NotifyEvent): void {
    for (const handler of this.handlers) {
      try {
        const ret = handler(event);
        if (ret && typeof (ret as Promise<void>).catch === 'function') {
          (ret as Promise<void>).catch(err =>
            log.warn({ err, type: event.type }, 'Async notify handler failed'),
          );
        }
      } catch (err) {
        log.warn({ err, type: event.type }, 'Notify handler threw');
      }
    }
  }

  handlerCount(): number {
    return this.handlers.size;
  }

  /** Remove all subscribers — test isolation helper. */
  clear(): void {
    this.handlers.clear();
  }
}

/** Process-wide singleton. */
export const notifyBus = new NotifyBus();

/**
 * Convenience emitter — stamps `timestamp` if the caller didn't.
 * Prefer this over `notifyBus.emit` at call sites.
 */
export function emitNotifyEvent(input: NotifyEventInput): void {
  notifyBus.emit({ ...input, timestamp: input.timestamp ?? new Date() });
}
