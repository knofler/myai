/**
 * Provider failover chain — inter-hop backoff tuning + retry-budget observability.
 *
 * `resilience.ts` already retries the SAME provider (rate-limit -> circuit
 * breaker -> exponential-backoff retry, see `withResilience`). This module
 * covers the layer above it: the chain walker in `provider.ts::complete()`
 * hops from provider A to provider B immediately on a recoverable failure,
 * with no pause between hops — hammering B while A (and often the shared
 * network path to it) may still be mid-outage. Two things were still missing
 * per plan/MULTI_PROVIDER_ORCHESTRATION.md §4a:
 *
 *   1. Per-provider exponential backoff BETWEEN hops (distinct from, and much
 *      shorter than, the same-provider retry backoff in resilience.ts).
 *   2. An explicit, operator-tunable cap on how many hops a single call may
 *      attempt (the "retry budget"), plus observability into which hops got
 *      dropped and why — surfaced through `getProviderHealth` /
 *      `getAllProviderHealth` (resilience.ts) for the `provider_health` MCP
 *      tool and the dashboard's API Health page.
 *
 * Pure + IO-light by design (only a `setTimeout`-based sleep) so the backoff
 * math and stats bookkeeping are trivially unit-testable without fake timers.
 */

import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'llm-failover-backoff' });

export interface FailoverBackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

/**
 * Per-provider inter-hop backoff defaults. Deliberately much shorter than
 * `resilience.ts`'s same-provider retry delays (seconds) — this is a brief
 * pause before trying a DIFFERENT provider, not a wait for the same one to
 * recover. Override at runtime via `configureFailoverBackoff`.
 */
const FAILOVER_BACKOFF_DEFAULTS: Record<string, FailoverBackoffConfig> = {
  api: { baseDelayMs: 200, maxDelayMs: 3_000, backoffFactor: 2 },
  deepseek: { baseDelayMs: 150, maxDelayMs: 2_000, backoffFactor: 2 },
  moonshot: { baseDelayMs: 150, maxDelayMs: 2_000, backoffFactor: 2 },
  gemini: { baseDelayMs: 150, maxDelayMs: 2_000, backoffFactor: 2 },
  // Local — near-instant retry, small ceiling.
  ollama: { baseDelayMs: 50, maxDelayMs: 500, backoffFactor: 2 },
  bridge: { baseDelayMs: 200, maxDelayMs: 2_000, backoffFactor: 2 },
  direct: { baseDelayMs: 200, maxDelayMs: 2_000, backoffFactor: 2 },
  _default: { baseDelayMs: 200, maxDelayMs: 3_000, backoffFactor: 2 },
};

/** Current effective backoff config for `provider` (defaults + any override). */
export function getFailoverBackoffConfig(provider: string): FailoverBackoffConfig {
  return FAILOVER_BACKOFF_DEFAULTS[provider] ?? FAILOVER_BACKOFF_DEFAULTS._default;
}

/**
 * Override the default backoff config for a provider. Intended for operator
 * tuning or tests; takes effect on the next `computeFailoverBackoffMs` call.
 */
export function configureFailoverBackoff(
  provider: string,
  config: Partial<FailoverBackoffConfig>,
): void {
  const base = getFailoverBackoffConfig(provider);
  FAILOVER_BACKOFF_DEFAULTS[provider] = { ...base, ...config };
}

/**
 * Exponential backoff (with jitter) for the pause before trying the NEXT
 * provider after `provider` just failed. `hopAttempt` is the 0-indexed
 * position of the failed hop in the chain, so later hops in a long chain
 * back off more — capped at `maxDelayMs` so a long chain doesn't take
 * minutes to exhaust.
 */
export function computeFailoverBackoffMs(provider: string, hopAttempt: number): number {
  const cfg = getFailoverBackoffConfig(provider);
  const exponential = cfg.baseDelayMs * Math.pow(cfg.backoffFactor, Math.max(0, hopAttempt));
  const jitter = Math.random() * (cfg.baseDelayMs / 2);
  return Math.min(exponential + jitter, cfg.maxDelayMs);
}

/** Promise-based sleep — the only real IO in this module. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Retry-budget + dropped-hop observability ────────────────────────

export type DroppedHopReason = 'retry-budget' | 'cost-budget';

export interface DroppedHopEvent {
  mode: string;
  index: number;
  reason: DroppedHopReason;
  atIso: string;
  estimatedCostUsd?: number;
}

interface ProviderFailoverStats {
  hopsAttempted: number;
  hopsSucceededAsFallback: number;
  hopsDroppedForRetryBudget: number;
  hopsDroppedForCostBudget: number;
}

const providerStats = new Map<string, ProviderFailoverStats>();

/** Ring buffer of the most recent dropped hops (any provider, any reason). */
const MAX_RECENT_DROPPED = 20;
let recentDroppedHops: DroppedHopEvent[] = [];

function getOrCreateStats(provider: string): ProviderFailoverStats {
  let s = providerStats.get(provider);
  if (!s) {
    s = { hopsAttempted: 0, hopsSucceededAsFallback: 0, hopsDroppedForRetryBudget: 0, hopsDroppedForCostBudget: 0 };
    providerStats.set(provider, s);
  }
  return s;
}

/** Record that `provider` was actually dispatched as a hop at chain position `index`. */
export function recordHopAttempt(provider: string, index: number): void {
  void index;
  getOrCreateStats(provider).hopsAttempted++;
}

/** Record that `provider` won the call as a FALLBACK hop (index > 0 in the chain). */
export function recordHopSucceeded(provider: string, index: number): void {
  if (index === 0) return;
  getOrCreateStats(provider).hopsSucceededAsFallback++;
}

/** Record that a hop was dropped BEFORE being attempted (budget-filtered). */
export function recordHopDropped(event: DroppedHopEvent): void {
  const s = getOrCreateStats(event.mode);
  if (event.reason === 'retry-budget') s.hopsDroppedForRetryBudget++;
  else s.hopsDroppedForCostBudget++;
  recentDroppedHops = [event, ...recentDroppedHops].slice(0, MAX_RECENT_DROPPED);
  log.warn({ event }, 'Failover hop dropped before being attempted');
}

/** Most recent dropped-hop events across all providers, newest first. */
export function getRecentDroppedHops(): DroppedHopEvent[] {
  return recentDroppedHops;
}

export interface FailoverProviderHealth extends ProviderFailoverStats {
  backoff: FailoverBackoffConfig;
}

/** Per-provider failover snapshot for `ProviderHealth.failover` (resilience.ts). */
export function getFailoverProviderHealth(provider: string): FailoverProviderHealth {
  return { backoff: getFailoverBackoffConfig(provider), ...getOrCreateStats(provider) };
}

/**
 * Trim `chain` down to `maxHops`, always keeping index 0 (the primary — the
 * call you routed to is always attempted at least once). Hops cut off the
 * tail are recorded as dropped (reason: retry-budget) for dashboard
 * visibility. No-op when `maxHops` is unset or the chain already fits.
 */
export function applyRetryBudget(chain: string[], maxHops: number | null | undefined): string[] {
  if (maxHops === null || maxHops === undefined || chain.length <= maxHops) return chain;
  const kept = chain.slice(0, Math.max(1, Math.floor(maxHops)));
  const dropped = chain.slice(kept.length);
  const atIso = new Date().toISOString();
  dropped.forEach((mode, i) => {
    recordHopDropped({ mode, index: kept.length + i, reason: 'retry-budget', atIso });
  });
  return kept;
}

/** Test-only: reset all module-level stats/history. */
export function resetFailoverStats(): void {
  providerStats.clear();
  recentDroppedHops = [];
}
