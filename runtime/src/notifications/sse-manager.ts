/**
 * Server-Sent Events client manager.
 *
 * Tracks open SSE connections keyed by tenant so a real-time event is delivered
 * only to that tenant's browsers. The transport detail (how bytes reach the
 * socket) is abstracted behind a `send` callback the HTTP route supplies, which
 * keeps this module free of Express types and trivially unit-testable.
 *
 * REALTIME_NOTIFICATIONS plan, Phase 4 (SSE real-time stream).
 */
import { createChildLogger } from '../shared/logger.js';
import type { NotifyEvent } from './event-bus.js';

const log = createChildLogger({ module: 'sse-manager' });

/** Per-connection sender. Implementations must never throw. */
export type SseSend = (event: NotifyEvent) => void;

class SSEManager {
  private clients = new Map<string, Set<SseSend>>();

  /** Register a connection for a tenant. */
  addClient(tenantId: string, send: SseSend): void {
    let set = this.clients.get(tenantId);
    if (!set) {
      set = new Set();
      this.clients.set(tenantId, set);
    }
    set.add(send);
    log.debug({ tenantId, clients: set.size }, 'SSE client added');
  }

  /** Deregister a connection. Drops the tenant bucket once empty. */
  removeClient(tenantId: string, send: SseSend): void {
    const set = this.clients.get(tenantId);
    if (!set) return;
    set.delete(send);
    if (set.size === 0) this.clients.delete(tenantId);
    log.debug({ tenantId, clients: set.size }, 'SSE client removed');
  }

  /** Push an event to every connection of the event's tenant. */
  send(tenantId: string, event: NotifyEvent): void {
    const set = this.clients.get(tenantId);
    if (!set || set.size === 0) return;
    for (const send of set) {
      try {
        send(event);
      } catch (err) {
        // A dead socket shouldn't take down the fan-out — drop it.
        log.warn({ err, tenantId }, 'SSE send failed — removing client');
        set.delete(send);
      }
    }
    if (set.size === 0) this.clients.delete(tenantId);
  }

  /** True when the tenant has at least one open connection. */
  hasClient(tenantId: string): boolean {
    return (this.clients.get(tenantId)?.size ?? 0) > 0;
  }

  /** Connection count — total across all tenants, or for one tenant. */
  clientCount(tenantId?: string): number {
    if (tenantId !== undefined) return this.clients.get(tenantId)?.size ?? 0;
    let total = 0;
    for (const set of this.clients.values()) total += set.size;
    return total;
  }

  /** Drop every connection — test isolation helper. */
  clear(): void {
    this.clients.clear();
  }
}

/** Process-wide singleton. */
export const sseManager = new SSEManager();
