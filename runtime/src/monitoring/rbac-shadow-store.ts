/**
 * In-memory ring buffer for RBAC shadow-mode denials (ADR-013 §6).
 *
 * `rbac.ts`'s `assertCapability` / `requireRole`, with `RBAC_ENFORCE` off (the
 * default), only structured-logged a would-be denial (`rbac.shadow`) and let
 * the caller through — there was zero durable record of what would 403 if
 * enforcement were flipped on. This store gives an operator a queryable
 * answer to "if I flip RBAC_ENFORCE=true today, which callers/tools would
 * suddenly 403?" without grepping raw logs across every gateway process.
 *
 * Same tradeoff monitoring/log-store.ts and tracing/tracer.ts make: a single
 * self-hosted gateway process with no external store wired up, so the ring
 * buffer + REST endpoint + dashboard panel IS the persistence layer for this
 * signal. Once `RBAC_ENFORCE` flips on, denials instead go through the
 * durable hash-chained audit trail (`rbac.denied` via core/audit-log.ts) —
 * this store is shadow-mode-only soak data, not a replacement for that trail.
 */
import { randomUUID } from 'node:crypto';
import type { CtxRole } from '../core/tenant-context.js';
import type { Capability } from '../core/rbac.js';

export interface ShadowDenialEntry {
  id: string;
  /** Epoch ms. */
  ts: number;
  tenantId: string;
  role: CtxRole;
  capability: Capability;
  /** Tool name or `METHOD /path` label — the would-be-blocked caller/route. */
  action: string;
  userId?: string;
}

export interface RawShadowDenialInput {
  tenantId: string;
  role: CtxRole;
  capability: Capability;
  action: string;
  userId?: string;
  /** Injectable clock for deterministic tests; defaults to Date.now(). */
  ts?: number;
}

/** Cap on in-memory entries — a ring buffer, not a durable store. */
export const MAX_SHADOW_DENIALS = 5000;

let entries: ShadowDenialEntry[] = [];

/** Test/ops helper: wipe the ring buffer. */
export function clearShadowDenials(): void {
  entries = [];
}

export interface ShadowDenialFilter {
  /** REQUIRED — fail-closed, same discipline as audit-log.ts / log-store.ts. */
  tenantId: string;
  role?: CtxRole;
  capability?: Capability;
  action?: string;
  /** Only entries at/after this epoch-ms timestamp. */
  since?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

/**
 * Record one shadow-mode denial. Never throws — recording a soak signal must
 * never break the request/tool call it's observing. Returns null on invalid
 * input or failure.
 */
export function recordShadowDenial(input: RawShadowDenialInput): ShadowDenialEntry | null {
  try {
    if (!input.tenantId || !input.role || !input.capability || !input.action) return null;
    const entry: ShadowDenialEntry = {
      id: randomUUID(),
      ts: Number.isFinite(input.ts) ? (input.ts as number) : Date.now(),
      tenantId: input.tenantId,
      role: input.role,
      capability: input.capability,
      action: input.action,
      ...(input.userId ? { userId: input.userId } : {}),
    };
    entries.push(entry);
    if (entries.length > MAX_SHADOW_DENIALS) entries = entries.slice(entries.length - MAX_SHADOW_DENIALS);
    return entry;
  } catch {
    return null;
  }
}

/** Query the ring buffer. Newest first, capped at `limit`. */
export function getShadowDenials(filter: ShadowDenialFilter): ShadowDenialEntry[] {
  if (!filter?.tenantId) return [];
  let out = entries.filter((e) => e.tenantId === filter.tenantId);
  if (filter.role) out = out.filter((e) => e.role === filter.role);
  if (filter.capability) out = out.filter((e) => e.capability === filter.capability);
  if (filter.action) out = out.filter((e) => e.action === filter.action);
  if (typeof filter.since === 'number') out = out.filter((e) => e.ts >= (filter.since as number));
  out = [...out].sort((a, b) => b.ts - a.ts);
  const limit = Math.min(Math.max(Math.trunc(filter.limit || DEFAULT_LIMIT), 1), MAX_LIMIT);
  return out.slice(0, limit);
}

export interface ShadowDenialSummaryRow {
  action: string;
  capability: Capability;
  /** Per-role hit counts for this action — which roles would 403. */
  roles: Partial<Record<CtxRole, number>>;
  count: number;
  /** Epoch ms of the most recent hit. */
  lastAt: number;
}

/**
 * Aggregate a tenant's shadow denials by (action, capability) — the "which
 * tools/routes would 403, and for which roles" view the dashboard panel
 * renders. `since` bounds the lookback (defaults to everything in the buffer).
 */
export function summarizeShadowDenials(tenantId: string, since?: number): ShadowDenialSummaryRow[] {
  const events = getShadowDenials({ tenantId, since, limit: MAX_LIMIT });
  const byAction = new Map<string, ShadowDenialSummaryRow>();
  for (const e of events) {
    let row = byAction.get(e.action);
    if (!row) {
      row = { action: e.action, capability: e.capability, roles: {}, count: 0, lastAt: e.ts };
      byAction.set(e.action, row);
    }
    row.count += 1;
    row.roles[e.role] = (row.roles[e.role] ?? 0) + 1;
    if (e.ts > row.lastAt) row.lastAt = e.ts;
  }
  return [...byAction.values()].sort((a, b) => b.count - a.count);
}
