/**
 * Request idempotency for the MCP `tools/call` surface — dedups
 * `tasks_create` / `plan_set` retries and double-clicks (a flaky connection or
 * an impatient client re-sending the same call must not create a second task
 * or plan). The client sends an `Idempotency-Key` header; the first response
 * for a (tenant, tool, key) triple is cached for a short TTL and replayed
 * verbatim on repeat instead of re-running the tool.
 *
 * In-memory + lazy expiry, same shape as auth-rate-limit.ts / tenant-quota.ts
 * — per-process is acceptable for the single-instance gateway; a hosted
 * multi-instance deploy would move this to a shared store (same caveat noted
 * there).
 */
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'idempotency-store' });

/** Tools where a client retry/double-click must not create a duplicate resource. */
export const IDEMPOTENT_TOOLS = new Set(['tasks_create', 'plan_set']);

/** Default cache lifetime for a stored response — short by design. */
export const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS) || 10 * 60_000;

interface Entry {
  requestHash: string;
  response: unknown;
  expiresAt: number;
}

const store = new Map<string, Entry>();

function cacheKey(tenantId: string, toolName: string, idempotencyKey: string): string {
  return `${tenantId}:${toolName}:${idempotencyKey}`;
}

/**
 * Cheap, deterministic hash of the tool args so a key reused with a DIFFERENT
 * payload is flagged instead of silently replaying an unrelated response.
 */
function hashArgs(args: unknown): string {
  const json = JSON.stringify(args ?? {});
  let h = 0;
  for (let i = 0; i < json.length; i++) {
    h = (Math.imul(31, h) + json.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

export type IdempotencyLookup =
  | { status: 'miss' }
  | { status: 'hit'; response: unknown }
  | { status: 'conflict' };

/**
 * Look up a cached response for this (tenant, tool, key). Expired entries are
 * pruned lazily on read. `now` is injectable for tests.
 */
export function lookupIdempotency(
  tenantId: string,
  toolName: string,
  idempotencyKey: string,
  args: unknown,
  now: number = Date.now(),
): IdempotencyLookup {
  const key = cacheKey(tenantId, toolName, idempotencyKey);
  const entry = store.get(key);
  if (!entry) return { status: 'miss' };
  if (entry.expiresAt <= now) {
    store.delete(key);
    return { status: 'miss' };
  }
  if (entry.requestHash !== hashArgs(args)) {
    log.warn({ tenantId, toolName, idempotencyKey }, 'Idempotency-Key reused with a different request payload');
    return { status: 'conflict' };
  }
  return { status: 'hit', response: entry.response };
}

/**
 * Cache a completed response for replay. `now`/`ttlMs` are injectable for
 * tests. Only call this for a response that should be replayed verbatim on
 * retry — callers should skip caching on a thrown/transient failure so a
 * retry can genuinely re-attempt the operation.
 */
export function storeIdempotency(
  tenantId: string,
  toolName: string,
  idempotencyKey: string,
  args: unknown,
  response: unknown,
  now: number = Date.now(),
  ttlMs: number = IDEMPOTENCY_TTL_MS,
): void {
  const key = cacheKey(tenantId, toolName, idempotencyKey);
  store.set(key, { requestHash: hashArgs(args), response, expiresAt: now + ttlMs });
}

/** Test helper — clear the in-memory store. */
export function _resetIdempotencyStore(): void {
  store.clear();
}
