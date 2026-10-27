// Background MongoDB reconnect after a failed boot connect.
//
// The 2026-10-23 incident (an office Mac): the Atlas connect timed out at container
// start (secureConnect 5007ms), bootstrap recorded the boot failure and moved
// on — and nothing ever tried again. Mail, leases and plan_set were dead for
// three days until a manual restart. The mongo driver only auto-reconnects a
// connection that was established once; a FAILED INITIAL connect needs its
// own retry, which is this module.
//
// Capped exponential backoff with jitter, every attempt logged. On success
// the boot-failure record is cleared and the DB-dependent boot steps run, so
// /readyz (the Docker healthcheck) turns healthy on its own. No silent
// failover: connectDB() still decides that, only when MYAI_DB_FAILOVER is set.

import type pino from 'pino';

export interface MongoReconnectState {
  active: boolean;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  connectedAt: string | null;
}

export interface MongoReconnectOptions {
  /** One connect attempt; throws on failure (connectDB). */
  connect: () => Promise<unknown>;
  /** DB-dependent boot steps to run once connected (seeds, migrations, sync). */
  onConnected: () => Promise<void>;
  /** Called after every failed attempt (e.g. to refresh the boot-failure record). */
  onAttemptFailed?: (err: Error, attempt: number) => void;
  log: Pick<pino.Logger, 'info' | 'warn' | 'error'>;
  /** First retry delay; doubles each attempt up to maxDelayMs. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
}

const DEFAULT_INITIAL_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;

const state: MongoReconnectState = {
  active: false, attempts: 0, lastError: null, lastAttemptAt: null, nextRetryAt: null, connectedAt: null,
};
let stopRequested = false;

/** Snapshot for /health/deep. */
export function getMongoReconnectState(): MongoReconnectState {
  return { ...state };
}

/** Delay before retry `attempt` (1-based): initial·2^(attempt-1), capped, ±20% jitter. */
export function backoffDelayMs(attempt: number, initialMs: number, maxMs: number, random: () => number): number {
  const base = Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt - 1));
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.max(0, Math.round(Math.min(maxMs, base * jitter)));
}

/** Stop the retry loop (gateway shutdown). Safe to call when not running. */
export function stopMongoReconnect(): void {
  stopRequested = true;
}

/**
 * Retry the connect in the background until it succeeds or stop is called.
 * Resolves true once connected and onConnected has run, false when stopped.
 * Never rejects: a failing onConnected is logged, the connection stays up.
 */
export async function startMongoReconnect(opts: MongoReconnectOptions): Promise<boolean> {
  const initial = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const max = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const random = opts.random ?? Math.random;
  const now = opts.now ?? (() => new Date());

  stopRequested = false;
  Object.assign(state, { active: true, attempts: 0, lastError: null, lastAttemptAt: null, nextRetryAt: null, connectedAt: null });

  for (let attempt = 1; ; attempt++) {
    const delayMs = backoffDelayMs(attempt, initial, max, random);
    state.nextRetryAt = new Date(now().getTime() + delayMs).toISOString();
    await sleep(delayMs);
    if (stopRequested) {
      state.active = false;
      state.nextRetryAt = null;
      opts.log.info({ attempts: state.attempts }, 'MongoDB reconnect stopped (shutdown)');
      return false;
    }

    state.attempts = attempt;
    state.lastAttemptAt = now().toISOString();
    try {
      await opts.connect();
    } catch (err) {
      const e = err as Error;
      state.lastError = e.message;
      const nextMs = backoffDelayMs(attempt + 1, initial, max, random);
      opts.log.warn(
        { attempt, err: e.message, nextRetryInMs: nextMs },
        `MongoDB reconnect attempt ${attempt} failed — retrying in ${Math.round(nextMs / 1000)}s`,
      );
      opts.onAttemptFailed?.(e, attempt);
      continue;
    }

    state.active = false;
    state.nextRetryAt = null;
    state.lastError = null;
    state.connectedAt = now().toISOString();
    opts.log.info({ attempt }, `MongoDB reconnected on attempt ${attempt} — running the DB-dependent boot steps`);
    try {
      await opts.onConnected();
      opts.log.info('MongoDB reconnect complete — persistence restored');
    } catch (err) {
      opts.log.error({ err }, 'MongoDB reconnected, but a DB-dependent boot step failed — see the error above');
    }
    return true;
  }
}
