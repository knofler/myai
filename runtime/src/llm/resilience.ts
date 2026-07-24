/**
 * Production hardening — resilience layer for LLM provider calls.
 *
 * Composes three modules around every outbound API call:
 *   1. **Rate limiter** — token-bucket gate prevents burst overload
 *   2. **Circuit breaker** — fast-fails when a provider is consistently down
 *   3. **Retry** — exponential backoff with jitter for transient failures
 *
 * Call flow:  rate-limit check  →  circuit breaker  →  retry  →  actual API call
 *
 * Per-provider instances are lazily initialised and cached in Maps keyed by the
 * provider string (matching the mode names used in `dispatchByMode`: "api",
 * "deepseek", "moonshot", "ollama", "bridge", "direct").
 *
 * @example
 * ```ts
 * const result = await withResilience('deepseek', () => callDeepSeekApi(req));
 * ```
 */

import { createChildLogger } from '../shared/logger.js';
import { CircuitBreaker, CircuitOpenError } from '../shared/circuit-breaker.js';
import type { CircuitState, CircuitBreakerStats } from '../shared/circuit-breaker.js';
import { RateLimiter } from '../shared/rate-limiter.js';
import type { RateLimiterStats } from '../shared/rate-limiter.js';
import { withRetry } from '../shared/retry.js';
import type { RetryOptions } from '../shared/retry.js';
import {
  guardMaintenance,
  trackInFlightStart,
  trackInFlightEnd,
  getMaintenanceSnapshot,
  getAllMaintenanceSnapshots,
  ProviderMaintenanceError,
} from './provider-maintenance.js';
import type { MaintenanceStatus } from './provider-maintenance.js';

const log = createChildLogger({ module: 'llm-resilience' });

// Re-export so consumers can catch CircuitOpenError without a second import.
export { CircuitOpenError };
// Operator-initiated maintenance drain — distinct from the circuit breaker.
export {
  ProviderMaintenanceError,
  enterMaintenance,
  exitMaintenance,
  getMaintenanceSnapshot,
  getAllMaintenanceSnapshots,
  KNOWN_LLM_PROVIDERS,
  assertKnownProvider,
} from './provider-maintenance.js';
export type { MaintenanceState, MaintenanceStatus, MaintenanceSnapshot, KnownLlmProvider } from './provider-maintenance.js';

// ── Per-provider default configs ──────────────────────────────────

/** Circuit breaker defaults per provider.  Override via `configureProvider`. */
interface CBConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts: number;
}

/** Rate limiter defaults per provider.  Override via `configureProvider`. */
interface RLConfig {
  /** Bucket capacity (max concurrent "in-flight" tokens). */
  maxTokens: number;
  /** Tokens refilled per second. */
  refillRate: number;
}

/** Retry defaults per provider. */
interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

interface ProviderResilienceConfig {
  cb: CBConfig;
  rl: RLConfig;
  retry: RetryConfig;
}

/**
 * Sensible defaults for each known provider. Unknown providers get the
 * `_default` entry. Tweak these as real-world traffic informs better values.
 */
const PROVIDER_DEFAULTS: Record<string, ProviderResilienceConfig> = {
  api: {
    // Anthropic — generous rate limits, but expensive; moderate breaker.
    cb: { failureThreshold: 5, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 2 },
    rl: { maxTokens: 10, refillRate: 2 },
    retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
  },
  deepseek: {
    // DeepSeek — office network often ECONNRESET; trip faster, recover faster.
    cb: { failureThreshold: 3, resetTimeoutMs: 30_000, halfOpenMaxAttempts: 2 },
    rl: { maxTokens: 10, refillRate: 2 },
    retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 15_000 },
  },
  moonshot: {
    cb: { failureThreshold: 3, resetTimeoutMs: 30_000, halfOpenMaxAttempts: 2 },
    rl: { maxTokens: 8, refillRate: 2 },
    retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 15_000 },
  },
  ollama: {
    // Local — unlikely to circuit-trip but keep a breaker for e.g. OOM.
    cb: { failureThreshold: 10, resetTimeoutMs: 10_000, halfOpenMaxAttempts: 1 },
    rl: { maxTokens: 5, refillRate: 1 },
    retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5_000 },
  },
  bridge: {
    cb: { failureThreshold: 5, resetTimeoutMs: 30_000, halfOpenMaxAttempts: 2 },
    rl: { maxTokens: 3, refillRate: 1 },
    retry: { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 10_000 },
  },
  direct: {
    cb: { failureThreshold: 5, resetTimeoutMs: 30_000, halfOpenMaxAttempts: 2 },
    rl: { maxTokens: 2, refillRate: 1 },
    retry: { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 10_000 },
  },
  _default: {
    cb: { failureThreshold: 5, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 2 },
    rl: { maxTokens: 10, refillRate: 2 },
    retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
  },
};

// ── Lazy-initialized instance caches ──────────────────────────────

const circuitBreakers = new Map<string, CircuitBreaker>();
const rateLimiters = new Map<string, RateLimiter>();

function getOrCreateCB(provider: string): CircuitBreaker {
  let cb = circuitBreakers.get(provider);
  if (!cb) {
    const cfg = (PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS._default).cb;
    cb = new CircuitBreaker(provider, cfg);
    circuitBreakers.set(provider, cb);
    log.info({ provider, ...cfg }, `Circuit breaker created for "${provider}"`);
  }
  return cb;
}

function getOrCreateRL(provider: string): RateLimiter {
  let rl = rateLimiters.get(provider);
  if (!rl) {
    const cfg = (PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS._default).rl;
    rl = new RateLimiter(provider, cfg);
    rateLimiters.set(provider, rl);
    log.info({ provider, ...cfg }, `Rate limiter created for "${provider}"`);
  }
  return rl;
}

function getRetryConfig(provider: string): RetryOptions {
  const cfg = (PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS._default).retry;
  return {
    maxAttempts: cfg.maxAttempts,
    baseDelayMs: cfg.baseDelayMs,
    maxDelayMs: cfg.maxDelayMs,
    // Retry on transient network errors + HTTP 429/500/502/503/529
    retryOn: (err: unknown) => {
      if (!err || typeof err !== 'object') return false;
      const e = err as { code?: string; cause?: { code?: string }; message?: string; status?: number };
      const code = e.code ?? e.cause?.code ?? '';
      // Network-level transient errors
      if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) {
        return true;
      }
      // HTTP status codes worth retrying (rate-limit, server error, overloaded)
      if (e.status && [429, 500, 502, 503, 529].includes(e.status)) {
        return true;
      }
      // Anthropic SDK wraps HTTP errors with the status in the message
      const msg = e.message ?? '';
      if (/\b(429|500|502|503|529)\b/.test(msg) && /overloaded|rate|limit|server|unavailable|retry/i.test(msg)) {
        return true;
      }
      return false;
    },
  };
}

// ── Timeout for rate-limiter wait (don't block forever) ───────────

/** Maximum ms to wait for a rate-limiter token before giving up. */
const RATE_LIMIT_WAIT_MS = 30_000;

// ── Error type for rate-limit exhaustion ──────────────────────────

export class RateLimitExhaustedError extends Error {
  readonly provider: string;
  constructor(provider: string) {
    super(`Rate limiter "${provider}" — timed out waiting for token (${RATE_LIMIT_WAIT_MS}ms)`);
    this.name = 'RateLimitExhaustedError';
    this.provider = provider;
  }
}

// ── Main public API ───────────────────────────────────────────────

/**
 * Execute `fn` with the full resilience stack for the given provider:
 *   1. Wait for a rate-limiter token (up to 30 s)
 *   2. Run through the circuit breaker
 *   3. Inside the breaker, retry transient failures
 *
 * @param provider - Mode name: "api" | "deepseek" | "moonshot" | "ollama" | "bridge" | "direct"
 * @param fn       - The actual provider call (e.g. `() => callDeepSeekApi(req)`)
 * @returns The result of `fn` on success.
 * @throws {RateLimitExhaustedError} if the rate limiter times out
 * @throws {CircuitOpenError} if the circuit breaker is open
 * @throws The underlying error from `fn` after retries are exhausted
 */
export async function withResilience<T>(
  provider: string,
  fn: () => Promise<T>,
): Promise<T> {
  // ── Step 0: Operator maintenance gate ───────────────────────
  // Queues while draining/in-maintenance; throws ProviderMaintenanceError
  // (recoverable — see provider.ts::isRecoverableNetworkError) if the queue
  // wait times out before the operator ends maintenance.
  await guardMaintenance(provider);

  const rl = getOrCreateRL(provider);
  const cb = getOrCreateCB(provider);
  const retryOpts = getRetryConfig(provider);

  // ── Step 1: Rate-limit gate ─────────────────────────────────
  const acquired = await rl.waitForToken(1, RATE_LIMIT_WAIT_MS);
  if (!acquired) {
    log.error({ provider, stats: rl.stats }, `Rate limiter "${provider}" exhausted — rejecting call`);
    throw new RateLimitExhaustedError(provider);
  }

  // ── Step 2+3: Circuit breaker wrapping retry ────────────────
  trackInFlightStart(provider);
  try {
    return await cb.execute(() => withRetry(fn, retryOpts));
  } finally {
    trackInFlightEnd(provider);
  }
}

// ── Health / observability ────────────────────────────────────────

export interface ProviderHealth {
  provider: string;
  circuit: CircuitBreakerStats;
  rateLimiter: RateLimiterStats;
  /** Operator-initiated maintenance state — distinct from `circuit`, which trips automatically on errors. */
  maintenance: MaintenanceStatus;
}

/**
 * Return the current health snapshot for a provider.
 * If the provider has never been used, returns default "healthy" values by
 * creating the instances lazily so the returned shape is always complete.
 */
export function getProviderHealth(provider: string): ProviderHealth {
  const { provider: _provider, ...maintenance } = getMaintenanceSnapshot(provider);
  return {
    provider,
    circuit: getOrCreateCB(provider).stats,
    rateLimiter: getOrCreateRL(provider).stats,
    maintenance,
  };
}

/**
 * Return health for every provider that has been initialized so far.
 */
export function getAllProviderHealth(): ProviderHealth[] {
  // Union of keys across all three registries — a provider placed into
  // maintenance before its first real call has no circuit/rate-limiter
  // instance yet, but must still show up for the dashboard banner.
  const providers = new Set<string>();
  circuitBreakers.forEach((_v, k) => providers.add(k));
  rateLimiters.forEach((_v, k) => providers.add(k));
  getAllMaintenanceSnapshots().forEach((s) => providers.add(s.provider));
  return Array.from(providers).map(getProviderHealth);
}

/**
 * Manually reset a provider's circuit breaker to closed.
 * Useful for operator intervention when a provider has recovered but the
 * breaker hasn't timed out yet.
 */
export function resetProvider(provider: string): void {
  const cb = circuitBreakers.get(provider);
  if (cb) {
    cb.reset();
    log.info({ provider }, `Circuit breaker for "${provider}" manually reset`);
  } else {
    log.warn({ provider }, `resetProvider called for unknown provider "${provider}" — no-op`);
  }
}

/**
 * Override the default config for a provider. Must be called BEFORE the first
 * `withResilience` call for that provider (instances are cached after creation).
 * Intended for tests or runtime reconfiguration.
 */
export function configureProvider(
  provider: string,
  config: Partial<ProviderResilienceConfig>,
): void {
  const base = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS._default;
  PROVIDER_DEFAULTS[provider] = {
    cb: { ...base.cb, ...config.cb },
    rl: { ...base.rl, ...config.rl },
    retry: { ...base.retry, ...config.retry },
  };
  // Clear cached instances so the next call picks up new config.
  circuitBreakers.delete(provider);
  rateLimiters.delete(provider);
}
