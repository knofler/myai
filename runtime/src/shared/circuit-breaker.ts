import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'circuit-breaker' });

// ── Types ──────────────────────────────────────────────────────────

/** The three states of a circuit breaker. */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** Configuration for a {@link CircuitBreaker} instance. */
export interface CircuitBreakerOptions {
  /** Consecutive failures required to trip the breaker open. @default 5 */
  failureThreshold?: number;
  /** Milliseconds to remain open before transitioning to half-open. @default 60000 */
  resetTimeoutMs?: number;
  /** Consecutive successes in half-open state needed to close the breaker. @default 2 */
  halfOpenMaxAttempts?: number;
}

/** Snapshot of a circuit breaker's runtime counters. */
export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure?: Date;
  lastSuccess?: Date;
}

// ── Error ──────────────────────────────────────────────────────────

/**
 * Thrown when a call is attempted against a circuit that is currently open.
 * Callers can check `instanceof CircuitOpenError` to distinguish from
 * downstream failures.
 */
export class CircuitOpenError extends Error {
  /** Name of the circuit breaker that rejected the call. */
  readonly circuitName: string;

  constructor(circuitName: string) {
    super(`Circuit breaker "${circuitName}" is OPEN — call rejected`);
    this.name = 'CircuitOpenError';
    this.circuitName = circuitName;
  }
}

// ── Circuit Breaker ────────────────────────────────────────────────

/**
 * A simple circuit breaker for external service calls (LLM providers, APIs).
 *
 * **Closed** — requests flow through normally. After {@link failureThreshold}
 * consecutive failures the breaker trips **open**.
 *
 * **Open** — all calls are immediately rejected with {@link CircuitOpenError}.
 * After {@link resetTimeoutMs} the breaker transitions to **half-open**.
 *
 * **Half-open** — a limited number of probe requests are allowed through. If
 * {@link halfOpenMaxAttempts} consecutive successes are observed the breaker
 * **closes**. Any single failure sends it back to **open**.
 *
 * @example
 * ```ts
 * const breaker = new CircuitBreaker('anthropic-api', { failureThreshold: 3 });
 * const result = await breaker.execute(() => callAnthropicApi(request));
 * ```
 */
export class CircuitBreaker {
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxAttempts: number;

  private _state: CircuitState = 'closed';
  private _failures = 0;
  private _successes = 0;
  private _lastFailure: Date | undefined;
  private _lastSuccess: Date | undefined;
  private _openedAt: number | undefined;

  constructor(name: string, opts?: CircuitBreakerOptions) {
    this.name = name;
    this.failureThreshold = opts?.failureThreshold ?? 5;
    this.resetTimeoutMs = opts?.resetTimeoutMs ?? 60_000;
    this.halfOpenMaxAttempts = opts?.halfOpenMaxAttempts ?? 2;
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Execute `fn` through the circuit breaker.
   *
   * @typeParam T - The resolved type of `fn`.
   * @param fn - The async operation to protect.
   * @returns The result of a successful invocation of `fn`.
   * @throws {CircuitOpenError} If the circuit is currently open.
   * @throws Re-throws the original error from `fn` on failure (after updating
   *         internal counters).
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Possibly transition from open → half-open.
    this.checkOpenTimeout();

    if (this._state === 'open') {
      throw new CircuitOpenError(this.name);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /** Current circuit state. */
  get state(): CircuitState {
    // Re-evaluate in case the timeout has elapsed since the last call.
    this.checkOpenTimeout();
    return this._state;
  }

  /** Runtime statistics snapshot. */
  get stats(): CircuitBreakerStats {
    // Re-evaluate open timeout so the returned state is fresh.
    this.checkOpenTimeout();
    return {
      state: this._state,
      failures: this._failures,
      successes: this._successes,
      lastFailure: this._lastFailure,
      lastSuccess: this._lastSuccess,
    };
  }

  /** Manually reset the breaker to closed with zeroed counters. */
  reset(): void {
    const prev = this._state;
    this._state = 'closed';
    this._failures = 0;
    this._successes = 0;
    this._openedAt = undefined;

    if (prev !== 'closed') {
      log.info({ circuit: this.name, from: prev, to: 'closed' }, `Circuit "${this.name}" manually reset → closed`);
    }
  }

  // ── Internal state transitions ───────────────────────────────────

  /** If the breaker is open and the timeout has elapsed, transition to half-open. */
  private checkOpenTimeout(): void {
    if (this._state === 'open' && this._openedAt !== undefined) {
      if (Date.now() - this._openedAt >= this.resetTimeoutMs) {
        this.transitionTo('half-open');
      }
    }
  }

  private onSuccess(): void {
    this._lastSuccess = new Date();

    if (this._state === 'half-open') {
      this._successes += 1;
      if (this._successes >= this.halfOpenMaxAttempts) {
        this.transitionTo('closed');
      }
    } else {
      // In closed state a success resets the consecutive failure count.
      this._failures = 0;
      this._successes += 1;
    }
  }

  private onFailure(): void {
    this._lastFailure = new Date();

    if (this._state === 'half-open') {
      // Any failure in half-open sends us straight back to open.
      this.transitionTo('open');
    } else {
      // Closed state — accumulate failures.
      this._failures += 1;
      if (this._failures >= this.failureThreshold) {
        this.transitionTo('open');
      }
    }
  }

  private transitionTo(next: CircuitState): void {
    const prev = this._state;
    this._state = next;

    switch (next) {
      case 'open':
        this._openedAt = Date.now();
        this._successes = 0;
        log.warn(
          { circuit: this.name, from: prev, to: next, failures: this._failures },
          `Circuit "${this.name}" tripped → OPEN (${this._failures} consecutive failures)`,
        );
        break;

      case 'half-open':
        this._successes = 0;
        log.info(
          { circuit: this.name, from: prev, to: next, resetTimeoutMs: this.resetTimeoutMs },
          `Circuit "${this.name}" timeout elapsed → HALF-OPEN`,
        );
        break;

      case 'closed':
        this._failures = 0;
        this._successes = 0;
        this._openedAt = undefined;
        log.info(
          { circuit: this.name, from: prev, to: next },
          `Circuit "${this.name}" recovered → CLOSED`,
        );
        break;
    }
  }
}
