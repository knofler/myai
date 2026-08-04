# Observability — Sentry, Status Page & Uptime

Production observability for the myAI platform (a paid product): error tracking
with Sentry, a public `/status` page, and rolling uptime. All three are
**opt-in** — the platform runs identically with them off, so self-hosted and
local installs are unaffected.

---

## 1. Sentry error tracking

Error tracking is enabled by setting `SENTRY_DSN`. It covers both the gateway
(`@sentry/node`) and the dashboard (`@sentry/nextjs`), and both scrub PII/secrets
before any event leaves the process.

### Gateway (`runtime`)

- Module: `runtime/src/monitoring/sentry.ts`
- Initialised once at startup (`core/index.ts` → `initSentry()`), flushed on
  graceful shutdown (`flushSentry()`).
- Unhandled Express errors are reported from the error handler
  (`core/middleware.ts` → `captureException(err, { method, path })`).
- `@sentry/node` is loaded via a **dynamic import guarded by `SENTRY_DSN`** — the
  package is only touched when a DSN is present, so no DSN = zero overhead and no
  hard dependency at runtime.

### Dashboard (`dashboard`)

- Hook: `dashboard/src/instrumentation.ts` → `register()` (Next.js instrumentation).
- Loads `@sentry/nextjs` via a dynamic import guarded by `SENTRY_DSN`. Not added
  to `package.json` by default (keeps `npm ci` green); install it to activate:
  `npm install @sentry/nextjs`.

### PII scrubbing (data-locality)

Both integrations set `sendDefaultPii: false` and run a `beforeSend` scrubber
(`scrubEvent` / `scrubDashboardEvent`) that:

- **Drops** request bodies, cookies, and query strings.
- **Strips** sensitive headers (`authorization`, `cookie`, `x-api-key`, …).
- **Reduces** `user` to an opaque `id` — no email, IP, or username.
- **Redacts** secret-shaped strings anywhere in the event (`sk-…` API keys,
  DSNs / URLs with embedded credentials, `mongodb://` strings, JWTs, AWS keys).

`scrubEvent` is a pure function, unit-tested in `runtime/tests/unit/sentry.test.ts`.

### Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `SENTRY_DSN` | gateway + dashboard | Enable error tracking (absent = off). |
| `SENTRY_ENVIRONMENT` | both | Tag events (falls back to `NODE_ENV`, then `production`). |
| `SENTRY_RELEASE` | both | Release/version tag for regression tracking. |
| `SENTRY_TRACES_SAMPLE_RATE` | both | APM trace sampling (default `0` — errors only). |

---

## 2. Public status page

- Page: `/status` (dashboard) — `dashboard/src/app/status/page.tsx`
- API: `/api/status` — `dashboard/src/app/api/status/route.ts` (returns HTTP 503
  when the overall status is `down`, so an external probe can alert on it).
- Both use the shared aggregator `dashboard/src/lib/status.ts` so the UI and the
  JSON feed never drift.

Both `/status` and `/api/status` are **public** (added to `PUBLIC_PREFIXES` in
`dashboard/src/middleware.ts`) — a status page must be reachable when the
product is degraded and without a login.

### Components reported

| Component | Source |
|---|---|
| API Gateway | gateway `GET /health/deep` (`healthy`/`degraded`/`unhealthy`). |
| Dashboard | dashboard's own MongoDB reachability. |
| Database (MongoDB) | `checks.mongodb` from the gateway deep health. |
| CLI Task Runner | `state/runner-health.json` (stall flag → degraded). |

Overall status is the worst component, escalated to `degraded` whenever an
unresolved incident is present.

### Incident log

- Store: `state/incidents.json` (committed → versioned, survives restarts, no
  extra datastore). Reader: `dashboard/src/lib/incidents.ts`.
- Absent/empty file renders as "No incidents reported" (a healthy state, not an
  error). Malformed JSON degrades to empty rather than breaking the page.
- Entry shape: `{ id, title, status, impact, startedAt, resolvedAt, components[], updates[] }`
  where `status ∈ investigating|identified|monitoring|resolved` and
  `impact ∈ none|minor|major|critical`. Append entries during/after an incident.

---

## 3. Uptime

- Tracker: `runtime/src/monitoring/uptime.ts` — an in-process ring buffer fed by
  the periodic deep health check (`health-alerter` → `recordSample`).
- Endpoint: `GET /api/status/uptime` (public) — rolling availability over the
  last hour / 24 h / 7 days. "Up" counts `healthy` **and** `degraded`; only
  `unhealthy` samples count against uptime.
- The `/status` page renders these three windows.
- In-memory by design (resets on restart — a restart is itself downtime an
  external probe records). For contractual SLA numbers, point an external probe
  (UptimeRobot / Better Stack) at `GET /health` or `GET /api/status`; the
  in-process tracker gives an at-a-glance figure without a second service.

Unit-tested in `runtime/tests/unit/uptime.test.ts`.

---

## Deploy notes

The gateway changes (Sentry init, uptime tracking, `/api/status/uptime`) take
effect only after the gateway image is rebuilt — a MASTER-checkout / selfheal
op, never run from a workspace clone. No dashboard dependency was added, so the
dashboard build stays green without any lockfile change.

If the health/status data you're looking at is stale or `degraded` for one of
the recurring reasons (disk-full mongo crash-loop, a gateway image that
predates a merged `runtime/` change, Atlas unreachable, or a task-queue
pileup), see [`RUNBOOK.md`](./RUNBOOK.md) for the copy-pasteable
verify/fix/confirm/rollback procedure.
