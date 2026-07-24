import * as Sentry from "@sentry/nextjs";

// No-op when NEXT_PUBLIC_SENTRY_DSN is unset (local dev without Sentry).
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,
});
