import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'rate-limiter' });

// ── Types ──────────────────────────────────────────────────────────

/** Configuration for a {@link RateLimiter} instance. */
export interface RateLimiterOptions {
  /** Maximum number of tokens the bucket can hold (its capacity). */
  maxTokens: number;
  /** Number of tokens added to the bucket per second. */
  refillRate: number;
  /** Interval in milliseconds between refill ticks. @default 1000 */
  refillIntervalMs?: number;
}

/** Runtime statistics snapshot for a {@link RateLimiter}. */
export interface RateLimiterStats {
  /** Tokens currently available. */
  available: number;
  /** Bucket capacity. */
  maxTokens: number;
  /** Tokens added per second. */
  refillRate: number;
  /** Cumulative tokens successfully acquired. */
  totalAcquired: number;
  /** Cumulative tokens rejected (insufficient budget). */
  totalRejected: number;
}

// ── Rate Limiter ───────────────────────────────────────────────────

/**
 * A token-bucket rate limiter for protecting external API calls.
 *
 * The bucket starts full at {@link maxTokens}. Each {@link acquire} call
 * consumes tokens; tokens refill at {@link refillRate} per second (applied in
 * discrete ticks every {@link refillIntervalMs}).
 *
 * This implementation is designed for a single Node.js event loop — no mutex
 * is required.
 *
 * @example
 * ```ts
 * const limiter = new RateLimiter('anthropic', { maxTokens: 10, refillRate: 2 });
 *
 * if (limiter.acquire()) {
 *   await callApi();
 * }
 *
 * // Or wait for a token (with timeout):
 * if (await limiter.waitForToken(1, 5000)) {
 *   await callApi();
 * }
 * ```
 */
export class RateLimiter {
  private readonly name: string;
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private readonly refillIntervalMs: number;

  private _tokens: number;
  private _lastRefillTime: number;
  private _totalAcquired = 0;
  private _totalRejected = 0;

  /**
   * Tracks whether the limiter is currently in a "rejecting" streak. Used to
   * log only the first rejection after a period of successful acquires,
   * avoiding log spam under sustained load.
   */
  private _rejectingStreak = false;

  constructor(name: string, opts: RateLimiterOptions) {
    this.name = name;
    this.maxTokens = opts.maxTokens;
    this.refillRate = opts.refillRate;
    this.refillIntervalMs = opts.refillIntervalMs ?? 1000;

    // Start with a full bucket.
    this._tokens = this.maxTokens;
    this._lastRefillTime = Date.now();
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Try to consume `tokens` from the bucket.
   *
   * @param tokens - Number of tokens to consume. @default 1
   * @returns `true` if the tokens were successfully consumed, `false` if the
   *          bucket has insufficient tokens.
   */
  acquire(tokens = 1): boolean {
    this.refill();

    if (this._tokens >= tokens) {
      this._tokens -= tokens;
      this._totalAcquired += tokens;
      this._rejectingStreak = false;
      return true;
    }

    this._totalRejected += tokens;

    // Log only the first rejection in a streak.
    if (!this._rejectingStreak) {
      this._rejectingStreak = true;
      log.warn(
        {
          limiter: this.name,
          requested: tokens,
          available: Math.floor(this._tokens),
          maxTokens: this.maxTokens,
        },
        `Rate limiter "${this.name}" — insufficient tokens (${Math.floor(this._tokens)}/${this.maxTokens})`,
      );
    }

    return false;
  }

  /**
   * Wait until `tokens` are available, polling every 100 ms.
   *
   * @param tokens    - Number of tokens to consume. @default 1
   * @param timeoutMs - Maximum time to wait in milliseconds. When `undefined`,
   *                    waits indefinitely.
   * @returns `true` if the tokens were acquired within the timeout, `false` if
   *          the timeout was reached.
   */
  async waitForToken(tokens = 1, timeoutMs?: number): Promise<boolean> {
    const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
    const pollIntervalMs = 100;

    while (true) {
      if (this.acquire(tokens)) {
        return true;
      }

      if (deadline !== undefined && Date.now() >= deadline) {
        return false;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  /** Number of tokens currently available (after applying pending refills). */
  get available(): number {
    this.refill();
    return Math.floor(this._tokens);
  }

  /** Runtime statistics snapshot. */
  get stats(): RateLimiterStats {
    this.refill();
    return {
      available: Math.floor(this._tokens),
      maxTokens: this.maxTokens,
      refillRate: this.refillRate,
      totalAcquired: this._totalAcquired,
      totalRejected: this._totalRejected,
    };
  }

  // ── Internal ─────────────────────────────────────────────────────

  /**
   * Apply pending token refills based on elapsed wall-clock time since the
   * last refill tick. Tokens are added proportionally and capped at
   * {@link maxTokens}.
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this._lastRefillTime;

    if (elapsed < this.refillIntervalMs) {
      return;
    }

    // Compute fractional intervals elapsed to add a proportional number of
    // tokens. This avoids drift when `refill()` is called at irregular times.
    const intervals = elapsed / this.refillIntervalMs;
    const tokensPerInterval = this.refillRate * (this.refillIntervalMs / 1000);
    const tokensToAdd = intervals * tokensPerInterval;

    this._tokens = Math.min(this._tokens + tokensToAdd, this.maxTokens);
    this._lastRefillTime = now;
  }
}
