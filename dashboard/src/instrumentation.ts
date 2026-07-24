// Next.js instrumentation hook — runs once when the server process boots.
//
// Initialises Sentry error tracking for the dashboard. Fully OPT-IN: does
// nothing unless SENTRY_DSN (server) is set, and loads @sentry/nextjs via a
// dynamic, non-literal import so the package is NOT a hard build dependency.
// To activate on a hosted deployment: `npm install @sentry/nextjs` and set
// SENTRY_DSN. Local/self-hosted installs run untouched with no DSN.
//
// PII: sendDefaultPii is false and a beforeSend hook drops request cookies,
// auth headers, and user email/IP — matching the gateway's data-locality
// posture (see runtime/src/monitoring/sentry.ts).

interface DashboardSentryEvent {
  request?: { cookies?: unknown; headers?: Record<string, unknown>; data?: unknown };
  user?: { id?: unknown };
  [k: string]: unknown;
}

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'x-myai-key']);

/** Drop cookies, auth headers, request body, and user PII before an event is sent. */
export function scrubDashboardEvent(event: DashboardSentryEvent | null): DashboardSentryEvent | null {
  if (!event) return null;
  const out: DashboardSentryEvent = { ...event };
  if (out.request) {
    const req = { ...out.request };
    delete req.cookies;
    delete req.data;
    if (req.headers && typeof req.headers === 'object') {
      const headers: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!SENSITIVE_HEADERS.has(k.toLowerCase())) headers[k] = v;
      }
      req.headers = headers;
    }
    out.request = req;
  }
  if (out.user && typeof out.user === 'object') {
    const { id } = out.user;
    out.user = id != null ? { id } : {};
  }
  return out;
}

export async function register(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  if (process.env.NEXT_RUNTIME !== 'nodejs') return; // server runtime only
  try {
    const specifier = '@sentry/nextjs';
    const Sentry = (await import(specifier)) as { init: (opts: Record<string, unknown>) => void };
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
      release: process.env.SENTRY_RELEASE,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0'),
      sendDefaultPii: false,
      beforeSend: (event: DashboardSentryEvent) => scrubDashboardEvent(event),
    });
  } catch {
    // @sentry/nextjs not installed → run without error tracking. Never break
    // startup because the optional dependency is absent.
  }
}
