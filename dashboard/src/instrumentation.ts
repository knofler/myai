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

/** Warm the brain-read cache once the server is listening (see lib/warm.ts). */
function scheduleStartupWarm(): void {
  // Vercel has no long-lived process to warm, and no server on 127.0.0.1.
  if (process.env.MYAI_WARM_ON_START === '0' || process.env.VERCEL) return;
  setTimeout(() => {
    void (async () => {
      try {
        const { warmToken } = await import('@/lib/warm');
        const port = process.env.PORT ?? '3210';
        await fetch(`http://127.0.0.1:${port}/api/warm`, {
          headers: { 'x-warm-token': warmToken() },
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        // Gateway down or server not up yet — pages still work, just cold.
      }
    })();
  }, 3000);
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    scheduleStartupWarm();
    // Gateway → Atlas fallback for the cloud (no gateway on Vercel); server only.
    await import('@/lib/gateway-fallback-register');
  }
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
