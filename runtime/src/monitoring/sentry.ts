/**
 * Sentry error tracking for the myAI gateway.
 *
 * Production observability for a paid product. Sentry is fully OPT-IN: it does
 * nothing until `SENTRY_DSN` is set in the environment, and `@sentry/node` is
 * loaded via a dynamic import so the dependency is only touched when a DSN is
 * present. With no DSN every export here is a cheap no-op — the gateway runs
 * identically whether or not Sentry is configured.
 *
 * PII scrubbing (`scrubEvent`) runs as Sentry's `beforeSend` hook and honours
 * the framework's data-locality stance: no request bodies, no headers that can
 * carry credentials, no user email/IP, and any DSN/token/secret-shaped string
 * anywhere in the event is redacted before it leaves the process. `scrubEvent`
 * is a pure function so it can be unit-tested without the SDK installed.
 */

import { createChildLogger } from '../shared/logger.js';
import { SENSITIVE_HEADERS, redactString, deepRedact } from '../shared/redact.js';

const log = createChildLogger({ module: 'sentry' });

// ── Types (structural — avoid a hard dependency on @sentry/node types) ──

/** The subset of a Sentry event we inspect/mutate. Loosely typed on purpose. */
export interface SentryEventLike {
  request?: {
    data?: unknown;
    cookies?: unknown;
    headers?: Record<string, unknown>;
    query_string?: unknown;
    [k: string]: unknown;
  };
  user?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  [k: string]: unknown;
}

// ── PII scrubbing ─────────────────────────────────────────

/**
 * Strip PII and secrets from a Sentry event. Pure function — returns a new
 * event and never mutates the input. Returns `null` to drop the event entirely
 * (Sentry treats a `null` from `beforeSend` as "do not send").
 *
 * Removals:
 *   - `request.data` / `request.cookies` / `request.query_string` (bodies + query)
 *   - sensitive request headers (auth, cookies, api keys)
 *   - `user` identifiers (email, ip_address, username) — keep only a coarse id
 *   - any secret-shaped string anywhere in `extra` / `contexts` / message
 */
export function scrubEvent(event: SentryEventLike | null): SentryEventLike | null {
  if (!event) return null;
  // Shallow clone then selectively rebuild the sensitive sub-trees.
  const scrubbed: SentryEventLike = { ...event };

  if (scrubbed.request) {
    const req = { ...scrubbed.request };
    delete req.data;
    delete req.cookies;
    delete req.query_string;
    if (req.headers && typeof req.headers === 'object') {
      const headers: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!SENSITIVE_HEADERS.has(k.toLowerCase())) headers[k] = v;
      }
      req.headers = headers;
    }
    scrubbed.request = req;
  }

  if (scrubbed.user && typeof scrubbed.user === 'object') {
    // Keep an opaque id (useful for "how many users hit this") but drop
    // everything that identifies a person.
    const { id } = scrubbed.user as { id?: unknown };
    scrubbed.user = id != null ? { id } : {};
  }

  if (scrubbed.extra) scrubbed.extra = deepRedact(scrubbed.extra) as Record<string, unknown>;
  if (scrubbed.contexts) scrubbed.contexts = deepRedact(scrubbed.contexts) as Record<string, unknown>;
  if (typeof scrubbed.message === 'string') scrubbed.message = redactString(scrubbed.message);

  return scrubbed;
}

// ── Init / capture (dynamic — no static @sentry/node dependency) ──

let enabled = false;
// The loaded @sentry/node module, or null when not configured/available.
let sentry: {
  captureException: (err: unknown, hint?: unknown) => void;
  captureMessage: (msg: string, level?: string) => void;
  flush: (timeout?: number) => Promise<boolean>;
} | null = null;

/** Whether Sentry is initialised and actively reporting. */
export function isSentryEnabled(): boolean {
  return enabled;
}

/**
 * Initialise Sentry from the environment. No-op (returns false) when
 * `SENTRY_DSN` is unset or the SDK cannot be loaded. Safe to call once at
 * gateway startup; idempotent.
 */
export async function initSentry(): Promise<boolean> {
  if (enabled) return true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    log.debug('SENTRY_DSN not set — error tracking disabled');
    return false;
  }
  try {
    // Dynamic import so @sentry/node is only required when a DSN is present.
    // A non-literal specifier keeps `tsc` from resolving the module at build
    // time — the package is only installed in the runtime image, not here.
    const specifier = '@sentry/node';
    const mod = (await import(specifier)) as {
      init: (opts: Record<string, unknown>) => void;
      captureException: (err: unknown, hint?: unknown) => void;
      captureMessage: (msg: string, level?: string) => void;
      flush: (timeout?: number) => Promise<boolean>;
    };
    mod.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
      release: process.env.SENTRY_RELEASE,
      // Keep trace sampling low by default — errors are the priority, not APM.
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0'),
      // Never let the SDK attach request bodies / IPs itself; we scrub anyway.
      sendDefaultPii: false,
      beforeSend: (event: SentryEventLike) => scrubEvent(event),
    });
    sentry = mod as unknown as typeof sentry;
    enabled = true;
    log.info(
      { environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production' },
      'Sentry error tracking initialised (PII-scrubbed)',
    );
    return true;
  } catch (err) {
    // Most commonly: @sentry/node not installed. Degrade silently — the
    // gateway must never fail to boot because Sentry is missing.
    log.warn({ err: (err as Error).message }, 'Sentry init failed — continuing without error tracking');
    return false;
  }
}

/** Report an exception to Sentry. No-op when disabled. */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled || !sentry) return;
  try {
    sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    /* never let error reporting throw into the caller */
  }
}

/** Report a message to Sentry. No-op when disabled. */
export function captureMessage(message: string, level = 'info'): void {
  if (!enabled || !sentry) return;
  try {
    sentry.captureMessage(message, level);
  } catch {
    /* swallow */
  }
}

/** Flush buffered events (call before process exit). No-op when disabled. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!enabled || !sentry) return;
  try {
    await sentry.flush(timeoutMs);
  } catch {
    /* swallow */
  }
}
