import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'retry' });

// ── Network error codes considered retryable by default ────────────

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

// ── Types ──────────────────────────────────────────────────────────

/** Configuration for the retry behaviour of {@link withRetry}. */
export interface RetryOptions {
  /** Maximum number of attempts (including the first). @default 3 */
  maxAttempts?: number;
  /** Base delay in milliseconds before the first retry. @default 1000 */
  baseDelayMs?: number;
  /** Upper bound on the computed delay. @default 30000 */
  maxDelayMs?: number;
  /** Multiplier applied to `baseDelayMs` on each successive retry. @default 2 */
  backoffFactor?: number;
  /**
   * Predicate evaluated on every error. Return `true` to allow a retry,
   * `false` to throw immediately.
   *
   * The default predicate returns `true` for well-known transient network
   * error codes (ECONNRESET, ETIMEDOUT, ECONNREFUSED, EAI_AGAIN, ENOTFOUND)
   * and `false` for everything else.
   */
  retryOn?: (error: unknown) => boolean;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Extract a Node.js error code from an error of unknown shape. */
function extractErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code ?? undefined;
}

/**
 * Default retry predicate: returns `true` only for recognised transient
 * network error codes.
 */
function defaultRetryOn(err: unknown): boolean {
  const code = extractErrorCode(err);
  return code !== undefined && RETRYABLE_NETWORK_CODES.has(code);
}

/**
 * Compute the delay for a given attempt using exponential backoff with jitter.
 *
 * ```
 * delay = min(baseDelay * factor^attempt + random(0, baseDelay/2), maxDelay)
 * ```
 */
function computeDelay(
  attempt: number,
  baseDelayMs: number,
  backoffFactor: number,
  maxDelayMs: number,
): number {
  const exponential = baseDelayMs * Math.pow(backoffFactor, attempt);
  const jitter = Math.random() * (baseDelayMs / 2);
  return Math.min(exponential + jitter, maxDelayMs);
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Execute an async function with automatic retries using exponential backoff
 * and jitter.
 *
 * @typeParam T - The resolved type of the wrapped function.
 * @param fn   - The async operation to attempt.
 * @param opts - Optional retry configuration.
 * @returns The result of a successful invocation of `fn`.
 * @throws The last error if all attempts are exhausted, or the first error for
 *         which `retryOn` returns `false`.
 *
 * @example
 * ```ts
 * const data = await withRetry(() => fetch('https://api.example.com/data'), {
 *   maxAttempts: 5,
 *   baseDelayMs: 500,
 * });
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 1000;
  const maxDelayMs = opts?.maxDelayMs ?? 30000;
  const backoffFactor = opts?.backoffFactor ?? 2;
  const retryOn = opts?.retryOn ?? defaultRetryOn;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Check whether we should retry this particular error.
      if (!retryOn(err)) {
        log.warn(
          { attempt: attempt + 1, maxAttempts, err: (err as Error).message ?? String(err) },
          'Non-retryable error — throwing immediately',
        );
        throw err;
      }

      // If this was the last allowed attempt, don't sleep — just fall through
      // to the throw below.
      if (attempt + 1 >= maxAttempts) {
        break;
      }

      const delayMs = computeDelay(attempt, baseDelayMs, backoffFactor, maxDelayMs);

      log.warn(
        {
          attempt: attempt + 1,
          maxAttempts,
          delayMs: Math.round(delayMs),
          err: (err as Error).message ?? String(err),
        },
        `Retry attempt ${attempt + 1}/${maxAttempts} — waiting ${Math.round(delayMs)}ms`,
      );

      await sleep(delayMs);
    }
  }

  // All attempts exhausted.
  throw lastError;
}
