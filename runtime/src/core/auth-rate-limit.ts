// Dedicated rate limiting for the PUBLIC auth surface (/api/auth/login,
// /api/auth/signup). The global rateLimiter (middleware.ts) allows 120 req/min
// per IP — far too loose for credential brute-forcing. This adds a tight,
// per-account limiter on top.
//
// Why key by EMAIL, not IP: the dashboard proxies auth calls to the gateway, so
// the gateway sees a single source IP for every tenant's login. IP-keying would
// throttle all users together (and miss a distributed brute-force). Keying by
// the targeted email limits per-account guessing regardless of source. Falls
// back to IP only when no email is supplied (malformed request).
//
// In-memory + sliding window, same shape as the global limiter. Per-process is
// acceptable for the single-instance gateway; a hosted multi-instance deploy
// would move this to a shared store (Redis/Mongo) — tracked, not built here.
import type { Request, Response, NextFunction } from 'express';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'auth-rate-limit' });

export interface RatePolicy {
  max: number;
  windowMs: number;
}

interface Bucket {
  hits: number[];
}

// Defaults tuned for a human auth surface; override via env for hosted scale.
export const LOGIN_POLICY: RatePolicy = {
  max: Number(process.env.AUTH_LOGIN_MAX) || 10,
  windowMs: (Number(process.env.AUTH_LOGIN_WINDOW_MIN) || 15) * 60_000,
};
export const SIGNUP_POLICY: RatePolicy = {
  max: Number(process.env.AUTH_SIGNUP_MAX) || 5,
  windowMs: (Number(process.env.AUTH_SIGNUP_WINDOW_MIN) || 60) * 60_000,
};
// Forgot/reset password: email-keyed like login (the request body carries the
// target email; the confirm body carries only the token, so it falls back to
// IP — fine, since a valid token is required anyway).
export const RESET_POLICY: RatePolicy = {
  max: Number(process.env.AUTH_RESET_MAX) || 5,
  windowMs: (Number(process.env.AUTH_RESET_WINDOW_MIN) || 60) * 60_000,
};
// Magic-link request/consume: email-keyed like reset (request carries the
// target email; consume carries only the token and falls back to IP — fine,
// since a valid single-use token is required anyway).
export const MAGIC_LINK_POLICY: RatePolicy = {
  max: Number(process.env.AUTH_MAGIC_LINK_MAX) || 5,
  windowMs: (Number(process.env.AUTH_MAGIC_LINK_WINDOW_MIN) || 60) * 60_000,
};
// Account-unlock request/consume: email-keyed like reset/magic-link (the
// resend request carries the target email; consume carries only the token and
// falls back to IP — fine, since a valid single-use token is required anyway).
export const ACCOUNT_UNLOCK_POLICY: RatePolicy = {
  max: Number(process.env.AUTH_UNLOCK_MAX) || 5,
  windowMs: (Number(process.env.AUTH_UNLOCK_WINDOW_MIN) || 60) * 60_000,
};

/**
 * Pure sliding-window check (exported for tests — `now` injectable). Mutates
 * `store`: prunes expired hits and, when allowed, records this hit.
 */
export function checkRate(
  store: Map<string, Bucket>,
  key: string,
  policy: RatePolicy,
  now: number,
): { ok: boolean; retryAfter: number } {
  const cutoff = now - policy.windowMs;
  let bucket = store.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    store.set(key, bucket);
  }
  bucket.hits = bucket.hits.filter((t) => t > cutoff);

  if (bucket.hits.length >= policy.max) {
    const oldest = bucket.hits[0] ?? now;
    return { ok: false, retryAfter: Math.max(1, Math.ceil((oldest + policy.windowMs - now) / 1000)) };
  }
  bucket.hits.push(now);
  return { ok: true, retryAfter: 0 };
}

const stores: Record<string, Map<string, Bucket>> = {};

/** Express middleware factory. `name` selects an isolated store + log label. */
export function authRateLimit(name: 'login' | 'signup' | 'reset' | 'magic-link' | 'unlock', policy: RatePolicy) {
  const store = (stores[name] ??= new Map<string, Bucket>());
  return (req: Request, res: Response, next: NextFunction): void => {
    const email =
      typeof req.body?.email === 'string' && req.body.email.trim()
        ? `email:${req.body.email.trim().toLowerCase()}`
        : `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    const { ok, retryAfter } = checkRate(store, `${name}:${email}`, policy, Date.now());
    if (!ok) {
      log.warn({ endpoint: name, key: email, retryAfter }, 'auth rate limit hit');
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'too many attempts — please wait and try again', code: 'RATE_LIMITED', retryAfter });
      return;
    }
    next();
  };
}

/** Test helper — clear all buckets. */
export function _resetAuthRateLimit(): void {
  for (const k of Object.keys(stores)) delete stores[k];
}
