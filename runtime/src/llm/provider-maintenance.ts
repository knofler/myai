/**
 * Operator-initiated maintenance mode for LLM providers.
 *
 * Distinct from the circuit breaker (`../shared/circuit-breaker.ts`), which
 * trips automatically on consecutive failures: this module is a deliberate,
 * operator-driven drain for planned provider maintenance (e.g. "DeepSeek is
 * getting redeployed at 2am, keep the fleet off it until it's back").
 *
 * Lifecycle for a provider placed into maintenance:
 *   1. `enterMaintenance` — state becomes 'draining' if calls are currently
 *      in flight (they are left to finish untouched), or 'maintenance'
 *      immediately if none are in flight.
 *   2. In-flight calls complete normally; once the last one finishes the
 *      state flips from 'draining' to 'maintenance' automatically.
 *   3. While draining or in maintenance, new calls routed through
 *      `guardMaintenance` queue (so a caller with no failover chain still
 *      gets served once maintenance ends) rather than hit the provider. If
 *      the queue wait exceeds `queueTimeoutMs`, the call rejects with
 *      {@link ProviderMaintenanceError} — a recoverable error the chain
 *      walker in `provider.ts` uses to fail over to the next provider.
 *   4. `exitMaintenance` — resumes normal dispatch and releases every queued
 *      call immediately.
 *
 * `getMaintenanceSnapshot` / `getAllMaintenanceSnapshots` feed the health
 * endpoints so a dashboard can render a maintenance banner.
 */

import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'provider-maintenance' });

// ── Types ──────────────────────────────────────────────────────────

export type MaintenanceState = 'active' | 'draining' | 'maintenance';

/** Maintenance status for a single provider, without the redundant `provider` key. */
export interface MaintenanceStatus {
  state: MaintenanceState;
  reason?: string;
  operator?: string;
  /** ISO timestamp of when `enterMaintenance` was called. */
  enteredAt?: string;
  /** Calls currently past the maintenance gate and executing against the provider. */
  inFlight: number;
  /** Calls currently queued behind the maintenance gate, waiting to resume or time out. */
  queued: number;
}

export interface MaintenanceSnapshot extends MaintenanceStatus {
  provider: string;
}

/**
 * Thrown when a call queued behind a provider's maintenance window times out
 * before the operator ends maintenance. Treated as a recoverable network
 * error by `isRecoverableNetworkError` (provider.ts) so the chain walker
 * fails over to the next provider rather than hanging indefinitely.
 */
export class ProviderMaintenanceError extends Error {
  readonly provider: string;
  constructor(provider: string, state: MaintenanceState) {
    super(`Provider "${provider}" is in ${state} — queued call timed out waiting for maintenance to end`);
    this.name = 'ProviderMaintenanceError';
    this.provider = provider;
  }
}

// ── Internal registry ──────────────────────────────────────────────

/**
 * The complete set of provider IDs `dispatchByMode` (provider.ts) actually
 * dispatches through `withResilience` — i.e. the only values `enterMaintenance`
 * / `exitMaintenance` can meaningfully act on. Mirrors `config.llm.mode`
 * (types.ts). A typo'd provider string would otherwise silently create a
 * maintenance entry for a provider nothing ever calls `guardMaintenance` for.
 */
export const KNOWN_LLM_PROVIDERS = ['api', 'deepseek', 'moonshot', 'ollama', 'bridge', 'direct'] as const;

export type KnownLlmProvider = (typeof KNOWN_LLM_PROVIDERS)[number];

/**
 * Guard for untrusted callers (MCP tool handlers) accepting an operator-typed
 * provider string. Not enforced inside `enterMaintenance`/`exitMaintenance`
 * themselves, since resilience.ts and this module's own tests deliberately
 * exercise the registry with synthetic provider names.
 */
export function assertKnownProvider(provider: string): void {
  if (!(KNOWN_LLM_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `Unknown provider "${provider}" — must be one of: ${KNOWN_LLM_PROVIDERS.join(', ')}`,
    );
  }
}

/** Default max time (ms) a new call queues behind maintenance before giving up. */
const DEFAULT_QUEUE_TIMEOUT_MS = 5 * 60_000;

interface MaintenanceRecord {
  state: MaintenanceState;
  reason?: string;
  operator?: string;
  enteredAt?: Date;
  inFlight: number;
  queued: number;
  resumeWaiters: Array<() => void>;
  queueTimeoutMs: number;
}

const registry = new Map<string, MaintenanceRecord>();

function getOrCreate(provider: string): MaintenanceRecord {
  let rec = registry.get(provider);
  if (!rec) {
    rec = {
      state: 'active',
      inFlight: 0,
      queued: 0,
      resumeWaiters: [],
      queueTimeoutMs: DEFAULT_QUEUE_TIMEOUT_MS,
    };
    registry.set(provider, rec);
  }
  return rec;
}

function toSnapshot(provider: string, rec: MaintenanceRecord): MaintenanceSnapshot {
  return {
    provider,
    state: rec.state,
    reason: rec.reason,
    operator: rec.operator,
    enteredAt: rec.enteredAt?.toISOString(),
    inFlight: rec.inFlight,
    queued: rec.queued,
  };
}

// ── Operator API ───────────────────────────────────────────────────

/**
 * Begin a planned maintenance window for `provider`. Idempotent — calling
 * again while already draining/in-maintenance is a no-op that returns the
 * existing snapshot (the original reason/operator/enteredAt are preserved).
 */
export function enterMaintenance(
  provider: string,
  opts?: { reason?: string; operator?: string },
): MaintenanceSnapshot {
  const rec = getOrCreate(provider);
  if (rec.state !== 'active') {
    return toSnapshot(provider, rec);
  }
  rec.reason = opts?.reason;
  rec.operator = opts?.operator;
  rec.enteredAt = new Date();
  rec.state = rec.inFlight > 0 ? 'draining' : 'maintenance';
  log.warn(
    { provider, state: rec.state, reason: rec.reason, operator: rec.operator, inFlight: rec.inFlight },
    `Provider "${provider}" entering maintenance (${rec.state})`,
  );
  return toSnapshot(provider, rec);
}

/** End maintenance for `provider`, resuming normal dispatch and releasing every queued call. */
export function exitMaintenance(provider: string): MaintenanceSnapshot {
  const rec = getOrCreate(provider);
  if (rec.state === 'active') {
    return toSnapshot(provider, rec);
  }
  rec.state = 'active';
  rec.reason = undefined;
  rec.operator = undefined;
  rec.enteredAt = undefined;
  const waiters = rec.resumeWaiters;
  rec.resumeWaiters = [];
  log.info({ provider, releasedQueued: waiters.length }, `Provider "${provider}" maintenance ended — resuming normal calls`);
  waiters.forEach((resume) => resume());
  return toSnapshot(provider, rec);
}

export function getMaintenanceSnapshot(provider: string): MaintenanceSnapshot {
  return toSnapshot(provider, getOrCreate(provider));
}

export function getAllMaintenanceSnapshots(): MaintenanceSnapshot[] {
  return Array.from(registry.entries()).map(([provider, rec]) => toSnapshot(provider, rec));
}

/** Test-only escape hatch to shrink the queue timeout, mirroring `configureProvider` in resilience.ts. */
export function configureMaintenanceQueueTimeout(provider: string, queueTimeoutMs: number): void {
  getOrCreate(provider).queueTimeoutMs = queueTimeoutMs;
}

// ── Gate + in-flight tracking (called from resilience.ts) ─────────

/**
 * Gate a call against `provider`'s maintenance state. Resolves immediately
 * when active. When draining or in maintenance, queues until
 * `exitMaintenance` is called or `queueTimeoutMs` elapses — whichever comes
 * first — rejecting with {@link ProviderMaintenanceError} on timeout.
 */
export function guardMaintenance(provider: string): Promise<void> {
  const rec = registry.get(provider);
  if (!rec || rec.state === 'active') return Promise.resolve();

  // Rebind as a definitely-assigned const — a nested `function` declaration
  // (unlike an arrow function) doesn't inherit the narrowing TS just applied
  // to `rec`, so it would otherwise see `MaintenanceRecord | undefined`.
  const record: MaintenanceRecord = rec;
  record.queued += 1;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = record.resumeWaiters.indexOf(onResume);
      if (idx >= 0) record.resumeWaiters.splice(idx, 1);
      record.queued -= 1;
      reject(new ProviderMaintenanceError(provider, record.state));
    }, record.queueTimeoutMs);

    function onResume() {
      clearTimeout(timer);
      record.queued -= 1;
      resolve();
    }

    record.resumeWaiters.push(onResume);
  });
}

/** Marks the start of a call actually dispatched to the provider (drain tracking). */
export function trackInFlightStart(provider: string): void {
  getOrCreate(provider).inFlight += 1;
}

/**
 * Marks the end of a dispatched call. If the provider was draining and this
 * was the last in-flight call, flips it to fully 'maintenance'.
 */
export function trackInFlightEnd(provider: string): void {
  const rec = registry.get(provider);
  if (!rec) return;
  rec.inFlight = Math.max(0, rec.inFlight - 1);
  if (rec.state === 'draining' && rec.inFlight === 0) {
    rec.state = 'maintenance';
    log.info({ provider }, `Provider "${provider}" fully drained — now in maintenance`);
  }
}
