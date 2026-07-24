import express from 'express';
import type { Request, Response, NextFunction, Express } from 'express';
import { randomUUID } from 'node:crypto';
import { createChildLogger } from '../shared/logger.js';
import { authenticate } from './auth.js';
import { tenantQuota } from './tenant-quota.js';
import { regionGuard } from './region-guard.js';
import { getConfig } from '../shared/config.js';
import { captureException } from '../monitoring/sentry.js';
import { recordLog } from '../monitoring/log-store.js';
import { verifyJwt } from './user-auth.js';
import { isSessionRevoked, touchSession } from './user-sessions.js';

const log = createChildLogger({ module: 'middleware' });

// Augment Express Request with the per-request correlation id (OBSERVABILITY).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId?: string;
    }
  }
}

// ── Types ─────────────────────────────────────────────────────────

interface RateLimitEntry {
  timestamps: number[];
}

// ── 1. Security Headers ──────────────────────────────────────────

/**
 * Sets common security headers on every response.
 *
 * - Removes `X-Powered-By` (information leakage)
 * - Sets `X-Content-Type-Options: nosniff` (MIME-sniffing prevention)
 * - Sets `X-Frame-Options: DENY` (clickjacking prevention)
 * - Sets `X-XSS-Protection: 0` (modern recommendation — disable legacy XSS auditor)
 * - Sets `Strict-Transport-Security` when not on localhost (HSTS)
 * - Sets `Cache-Control: no-store` for API responses
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  // Remove Express fingerprint
  res.removeHeader('X-Powered-By');

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');

  // HSTS only for non-localhost origins
  const host = req.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // Prevent caching of API responses
  res.setHeader('Cache-Control', 'no-store');

  next();
}

// ── 2. CORS ──────────────────────────────────────────────────────

const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization, Accept, x-admin-token';

/**
 * Simple CORS handler without external dependencies.
 *
 * Allowed origins come from the `CORS_ORIGINS` env var (comma-separated)
 * or default to `http://localhost:3210` (the dashboard).
 */
export function cors(req: Request, res: Response, next: NextFunction): void {
  const originsRaw = process.env.CORS_ORIGINS || 'http://localhost:3210';
  const allowedOrigins = originsRaw.split(',').map((o) => o.trim());
  const requestOrigin = req.headers.origin;

  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  res.setHeader('Access-Control-Max-Age', '86400');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}

// ── 2b. Correlation ID ───────────────────────────────────────────

/**
 * Stamps every request with a correlation id — the thread that ties a
 * gateway request to the runner/agent processes it may fan out to (see
 * monitoring/log-store.ts header comment for the cross-process model).
 *
 * Honours an incoming `x-correlation-id` (a caller — e.g. the runner acting
 * on a task — that already has one, typically the task id) and always echoes
 * it back on the response so the caller can log the same id on its side.
 * Falls back to a fresh UUID when absent/oversized.
 */
export function correlationId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-correlation-id');
  const id = incoming && incoming.length > 0 && incoming.length <= 200 ? incoming : randomUUID();
  req.correlationId = id;
  res.setHeader('x-correlation-id', id);
  next();
}

// ── 3. Request Logging ───────────────────────────────────────────

const reqLog = createChildLogger({ module: 'http-request' });

/**
 * Logs method, path, status code, and response time for each request as
 * structured JSON (via pino) AND records the same entry into the in-memory
 * log-store ring buffer (monitoring/log-store.ts) that backs the dashboard's
 * tenant-scoped `/logs` live-tail viewer. Every entry carries the request's
 * `correlationId` (see the `correlationId` middleware above).
 *
 * - Skips `/health` (too noisy for polling clients)
 * - `info` for 2xx/3xx, `warn` for 4xx, `error` for 5xx
 */
export function requestLogging(req: Request, res: Response, next: NextFunction): void {
  // Skip health endpoint to avoid log noise
  if (req.path === '/health') {
    next();
    return;
  }

  const start = process.hrtime.bigint();

  // Hook into the response finish event — by then every earlier middleware
  // (incl. authenticate()) has run, so req.tenant is populated if resolvable.
  res.on('finish', () => {
    const durationNs = process.hrtime.bigint() - start;
    const durationMs = Number(durationNs / 1_000_000n);
    const statusCode = res.statusCode;
    const correlationIdValue = req.correlationId ?? 'unknown';

    const logData = {
      correlationId: correlationIdValue,
      method: req.method,
      path: req.path,
      statusCode,
      durationMs,
    };
    const message = `${req.method} ${req.path} ${statusCode} ${durationMs}ms`;
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';

    if (level === 'error') reqLog.error(logData, message);
    else if (level === 'warn') reqLog.warn(logData, message);
    else reqLog.info(logData, message);

    recordLog({
      // Literal fallback (not shared/db.js's DEFAULT_TENANT_ID) — this module is
      // imported by a wide swath of unit tests that mock shared/db.js minimally;
      // pulling in that export there would ripple a mock-shape requirement across
      // every one of them for a rare fallback path (requests that error out before
      // authenticate() resolves req.tenant).
      tenantId: req.tenant?.tenantId ?? 'default',
      correlationId: correlationIdValue,
      service: 'gateway',
      level,
      message,
      attributes: { method: req.method, path: req.path, statusCode, durationMs },
    });
  });

  next();
}

// ── 4. Rate Limiter ──────────────────────────────────────────────

/** Paths exempt from rate limiting. */
const RATE_LIMIT_EXEMPT = new Set(['/health', '/health/deep', '/status', '/api/status/uptime']);

/** Per-IP request timestamps for the sliding window. */
const rateLimitStore = new Map<string, RateLimitEntry>();

/** Periodic cleanup interval reference (for shutdown). */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Removes expired entries from the rate-limit store.
 * Called every 60 seconds to prevent unbounded memory growth.
 */
function cleanupRateLimitStore(windowMs: number): void {
  const cutoff = Date.now() - windowMs;
  for (const [ip, entry] of rateLimitStore) {
    // Remove timestamps older than the window
    entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);
    if (entry.timestamps.length === 0) {
      rateLimitStore.delete(ip);
    }
  }
}

/**
 * Simple in-memory per-IP sliding-window rate limiter.
 *
 * - Configurable via `RATE_LIMIT_RPM` env var (default: 120 requests/minute)
 * - Returns 429 with `Retry-After` header when exceeded
 * - Exempt paths: `/health`, `/status`
 * - Periodic cleanup every 60s to prevent memory leaks
 */
export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  // Skip exempt paths
  if (RATE_LIMIT_EXEMPT.has(req.path)) {
    next();
    return;
  }

  const maxRequests = parseInt(process.env.RATE_LIMIT_RPM || '120', 10);
  const windowMs = 60_000; // 1 minute sliding window
  const now = Date.now();
  const cutoff = now - windowMs;

  // req.ip is the direct socket address by default; it only reflects
  // X-Forwarded-For when `trust proxy` is enabled (via TRUST_PROXY, set in
  // applyMiddleware). We keep it spoof-safe: XFF is honoured only behind a
  // trusted proxy, otherwise we fall back to the raw remote address.
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  let entry = rateLimitStore.get(ip);
  if (!entry) {
    entry = { timestamps: [] };
    rateLimitStore.set(ip, entry);
  }

  // Prune timestamps outside the window
  entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);

  if (entry.timestamps.length >= maxRequests) {
    // Calculate when the oldest request in the window will expire
    const oldestInWindow = entry.timestamps[0];
    const retryAfterSeconds = Math.ceil(((oldestInWindow ?? now) + windowMs - now) / 1000);

    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({
      error: 'Too many requests',
      code: 'RATE_LIMITED',
      retryAfter: retryAfterSeconds,
    });
    return;
  }

  entry.timestamps.push(now);
  next();
}

/**
 * Start the periodic rate-limit store cleanup.
 * Call once during server setup. Returns a teardown function.
 */
export function startRateLimitCleanup(): () => void {
  const windowMs = 60_000;
  cleanupInterval = setInterval(() => cleanupRateLimitStore(windowMs), 60_000);
  // Allow the process to exit even if the interval is active
  cleanupInterval.unref();

  return () => {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
  };
}

// ── 4b. Session revocation guard (active session / device management) ────

/**
 * Rejects requests carrying a JWT whose session (`sid` claim) has been
 * revoked — via the dashboard's "revoke session"/"revoke all" actions, or a
 * password reset (core/password-reset.ts revokes every session on change).
 * HS256 JWTs are otherwise stateless and would stay valid until natural
 * expiry (≤24h) even after a revoke; this is the one choke point that makes
 * revocation actually take effect immediately, without every route handler
 * needing to know about it.
 *
 * Tokens with no `sid` (minted before this feature shipped) and tokens that
 * fail structural verification are passed through untouched — verifyJwt()
 * itself (called again inside each route via jwtFromReq) is what rejects a
 * malformed/expired token; this guard only ever narrows further.
 */
export async function sessionRevocationGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.myai_token || req.header('authorization')?.replace('Bearer ', '');
  if (!token) { next(); return; }

  let payload;
  try {
    payload = verifyJwt(token);
  } catch {
    next(); // invalid/expired — downstream route-level verifyJwt() will 401
    return;
  }

  if (!payload.sid) { next(); return; }

  if (await isSessionRevoked(payload.sid)) {
    res.clearCookie('myai_token', { path: '/' });
    res.status(401).json({ error: 'session revoked — please log in again', code: 'SESSION_REVOKED' });
    return;
  }

  touchSession(payload.sid, { userAgent: req.header('user-agent'), ip: req.ip || req.socket.remoteAddress });
  next();
}

// ── 5. Error Handlers ────────────────────────────────────────────

/**
 * 404 handler for unmatched routes. Mount AFTER all route definitions.
 */
export function notFoundHandler(req: Request, res: Response, _next: NextFunction): void {
  res.status(404).json({
    error: 'Not found',
    code: 'NOT_FOUND',
    path: req.path,
  });
}

/**
 * Catch-all error handler for unhandled errors. Mount LAST in the middleware stack.
 * Logs the full error internally but returns a sanitized message to the client.
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  log.error(
    { err, method: req.method, path: req.path },
    `Unhandled error: ${err.message}`,
  );

  // Report to Sentry (no-op when SENTRY_DSN unset). Path/method only — never
  // the request body; the beforeSend scrubber strips any residual PII.
  captureException(err, { method: req.method, path: req.path });

  // Don't leak internal error details to clients
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
}

// ── 6. Apply All Middleware ──────────────────────────────────────

/**
 * Wires all production middleware onto the Express app in the correct order.
 *
 * Call **before** route definitions for pre-route middleware.
 * Returns functions to add error handlers (call **after** routes).
 */
export function applyMiddleware(app: Express): {
  /** Mount 404 + 500 error handlers. Call after all routes are defined. */
  applyErrorHandlers: () => void;
  /** Stop the rate-limit cleanup interval. Call on shutdown. */
  stopRateLimitCleanup: () => void;
} {
  // Pre-route middleware (order matters)

  // 0. Trust proxy — opt-in so req.ip honours X-Forwarded-For only when the
  //    gateway sits behind a known reverse proxy. Off by default (direct socket
  //    address) so clients can't spoof XFF to dodge the rate limiter.
  //    TRUST_PROXY accepts "true", a hop count, or a subnet/IP list (Express semantics).
  //    Digit-only values are parsed to a number so Express treats them as a hop
  //    count (a bare string like "1" would otherwise be read as a subnet/IP, not a count).
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    const trustProxyValue =
      trustProxy === 'true' ? true : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy;
    app.set('trust proxy', trustProxyValue);
    log.info({ trustProxy: trustProxyValue }, 'trust proxy enabled — req.ip will honour X-Forwarded-For');
  }

  // 1. Security headers first — every response gets them
  app.use(securityHeaders);

  // 2. CORS before body parsing — preflight must respond before other middleware
  app.use(cors);

  // 3. Request body parsing with size limit (replaces bare express.json())
  app.use(express.json({ limit: '1mb' }));

  // 3b. Cookie parsing (M2 dashboard auth — JWT in httpOnly cookie). Minimal
  // parser so we don't pull in cookie-parser; only populates if not already set.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (!req.cookies) {
      req.cookies = {};
      const header = req.headers.cookie;
      if (header) {
        for (const pair of header.split(';')) {
          const [name, ...rest] = pair.trim().split('=');
          if (name) req.cookies[name.trim()] = decodeURIComponent(rest.join('=').trim());
        }
      }
    }
    next();
  });

  // 3c. Correlation id — before request logging so every log line carries it
  app.use(correlationId);

  // 4. Request logging — after body parse so we capture the full lifecycle
  app.use(requestLogging);

  // 5. Rate limiting — after logging so rejected requests are still logged
  app.use(rateLimiter);

  // 6. Tenant auth (ADR-010 §3.2a) — after rate-limit, before routes. Resolves
  //    req.tenant from a per-tenant key, or the loopback/local-token default
  //    tenant. /health, /status, /api/openapi.json, /api/docs are exempt.
  //    Under tenancy.enforce=false this never rejects local callers.
  app.use(authenticate());

  // 7. Per-tenant rate limit + monthly request quota (abuse/DoS guard) — after
  //    auth so req.tenant is resolved. Inert for local/loopback callers and
  //    unlimited (scale) plans, so the single-operator deployment is unaffected.
  app.use(tenantQuota());

  // 7b. Data-residency region guard (ADR-023) — after auth so req.tenant is
  //     resolved; rejects a tenant pinned to a different region than this
  //     gateway serves. Inert unless GATEWAY_REGION + REGION_ENFORCE are set.
  app.use(regionGuard(() => getConfig().region));

  // 8. Session revocation guard — after tenant auth, before routes. A no-op
  //    for requests without a myai_token cookie/Bearer JWT (API-key traffic).
  app.use(sessionRevocationGuard);

  // Start periodic cleanup
  const stopRateLimitCleanup = startRateLimitCleanup();

  log.info('Production middleware applied');

  return {
    applyErrorHandlers: () => {
      app.use(notFoundHandler);
      // Express identifies error handlers by their 4-parameter signature
      app.use(errorHandler);
    },
    stopRateLimitCleanup,
  };
}
