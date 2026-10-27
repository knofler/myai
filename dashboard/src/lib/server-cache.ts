// Server data cache for slow, READ-ONLY gateway tools (perceived-performance
// playbook, layer 2 — brain memory `web-app-perceived-performance-playbook`).
//
// Measured 2026-09-29 on the local stack: every data route answered in 6-34ms
// EXCEPT the reads behind the brain tools — /api/brain/badge (in the shell, so
// on EVERY page) took ~400ms every time, /brain ~2-3s, /context ~2s. The
// gateway's own perf_stats agreed: brain_health p95 3.2s, brain_status 4.7s.
// Those tools walk the brain git store; their answers change only when an atom
// is committed, so a short TTL costs nothing in freshness.
//
// Why a wrapper instead of `fetch(..., { next: { revalidate } })`: callGateway
// POSTs JSON-RPC with `cache: 'no-store'`, and a POST body is not a fetch-cache
// key anyway. This caches the parsed RESULT, keyed by tool + args.
//
// Safe to share across viewers: callGateway always calls with the dashboard's
// one fixed service identity (x-gateway-local-token), never the viewer's, so
// the answer is already identical for everyone. Tenant-scoped calls go through
// callGatewayAsTenant and must NEVER be cached here.
//
// Stale-while-revalidate, done in-process (2026-10-04). The first version
// leaned on unstable_cache's `revalidate`, which was meant to serve the stale
// copy and refresh in the background — measured on the prod build it did not:
// the first request after each 30 s TTL BLOCKED on brain_explore (~700 ms),
// so /brain was slow once every ~35 s. Now a request never waits on the
// gateway once ANY copy exists: past the TTL it gets the stale copy at once and
// ONE background refresh (deduped across concurrent requests) replaces it. A
// failed read is never stored — an outage never overwrites the last good copy,
// and a cold key's next request retries. One dashboard container per machine,
// so a module-level Map is the whole cache; /api/warm fills it at startup.
import { callGateway } from '@/lib/gateway';

/** TTLs (seconds) per read-only tool. Anything not listed is not cacheable. */
export const GATEWAY_READ_TTL: Readonly<Record<string, number>> = {
  brain_explore: 30,
  brain_health: 60,
  brain_host_status: 60,
  brain_bandit_stats: 300,
  brain_router_train_readiness: 300,
};

/** Stable cache-key part for tool args (key order independent). */
export function argsKey(args: Record<string, unknown>): string {
  const norm = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(norm)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(norm(args));
}

interface Entry {
  value: unknown;
  at: number; // ms epoch of the last successful read
  refreshing?: Promise<void>;
}

const MAX_ENTRIES = 200;
const entries = new Map<string, Entry>();

function remember(key: string, value: unknown) {
  entries.delete(key); // re-insert → newest; Map order doubles as LRU order
  entries.set(key, { value, at: Date.now() });
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
}

/** Test hook: drop every cached read. */
export function clearGatewayReadCache() {
  entries.clear();
}

/**
 * callGateway for a read-only tool, through the server data cache.
 * Same contract as callGateway: resolves to the result, or null on any failure.
 */
export async function cachedGatewayRead<T>(tool: string, args: Record<string, unknown> = {}): Promise<T | null> {
  const ttl = Object.hasOwn(GATEWAY_READ_TTL, tool) ? GATEWAY_READ_TTL[tool] : undefined;
  if (!ttl) return callGateway<T>(tool, args);
  const key = `${tool}\u0000${argsKey(args)}`;
  const hit = entries.get(key);

  if (!hit) {
    const value = await callGateway<T>(tool, args);
    if (value !== null && value !== undefined) remember(key, value);
    return value;
  }

  if (Date.now() - hit.at > ttl * 1000 && !hit.refreshing) {
    // Promise.resolve().then: a synchronous throw must not escape to the page.
    hit.refreshing = Promise.resolve()
      .then(() => callGateway<T>(tool, args))
      .then((value) => {
        if (value !== null && value !== undefined) remember(key, value);
      })
      .catch(() => {})
      .finally(() => {
        const cur = entries.get(key);
        if (cur) cur.refreshing = undefined;
      });
  }
  return hit.value as T;
}
