// Dedicated rate limiting for the PUBLIC auth surface (/api/auth/login,
// /api/auth/signup). The global rateLimiter (middleware.ts) allows 120 req/min
// per IP — far too loose for credential brute-forcing. This adds a tight,
// per-account limiter on top, plus a looser per-IP limiter alongside it.
//
// Why the PRIMARY key is EMAIL, not IP: the dashboard proxies auth calls to
// the gateway, so the gateway sees a single source IP for every tenant's
// login. IP-keying alone would throttle all users together (and an
// attacker rotating source IPs could evade an IP-only limit entirely, but
// not an email-keyed one). Keying by the targeted email limits per-account
// guessing regardless of source. Falls back to IP only when no email is
// supplied (malformed request).
//
// Why there's ALSO an IP layer: the email-only limiter above doesn't stop one
// source spraying credentials across MANY accounts (each account's own bucket
// stays under threshold). `authRateLimit`'s optional `ipPolicy` adds a second,
// independent, deliberately looser bucket keyed purely on IP — high enough
// that legitimate multi-tenant traffic through the shared dashboard proxy IP
// never trips it, but low enough to catch genuine single-source volume abuse.
// Both layers are checked; either tripping is a 429.
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
// IP layer for login: much looser than the account layer (shared proxy IP —
// see file header) but catches one source spraying credentials across many
// accounts, which the email-only bucket above can't see.
export const LOGIN_IP_POLICY: RatePolicy = {
  max: Number(process.env.AUTH_LOGIN_IP_MAX) || 30,
  windowMs: (Number(process.env.AUTH_LOGIN_IP_WINDOW_MIN) || 15) * 60_000,
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
export const RESET_IP_POLICY: RatePolicy = {
  max: Number(process.env.AUTH_RESET_IP_MAX) || 20,
  windowMs: (Number(process.env.AUTH_RESET_IP_WINDOW_MIN) || 60) * 60_000,
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
const ipStores: Record<string, Map<string, Bucket>> = {};

function reqIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Bare IP-keyed limiter, usable standalone as Express middleware. Used for
 * `authRateLimit`'s optional IP layer and for endpoints (like TOTP verify)
 * that have no account identifier available before body/token parsing.
 */
export function ipRateLimit(name: string, policy: RatePolicy) {
  const store = (ipStores[name] ??= new Map<string, Bucket>());
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = reqIp(req);
    const { ok, retryAfter } = checkRate(store, `${name}:${ip}`, policy, Date.now());
    if (!ok) {
      log.warn({ endpoint: name, ip, retryAfter }, 'auth rate limit hit (ip)');
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'too many attempts — please wait and try again', code: 'RATE_LIMITED', retryAfter });
      return;
    }
    next();
  };
}

/**
 * Express middleware factory. `name` selects an isolated store + log label.
 * `policy` is the account (email-keyed) layer; `ipPolicy`, when given, adds
 * an independent IP-keyed layer checked first (see file header for why both
 * exist). Either layer tripping returns 429 + Retry-After.
 */
export function authRateLimit(name: 'login' | 'signup' | 'reset' | 'magic-link' | 'unlock' | 'email-verify', policy: RatePolicy, ipPolicy?: RatePolicy) {
  const store = (stores[name] ??= new Map<string, Bucket>());
  const ipStore = ipPolicy ? (ipStores[name] ??= new Map<string, Bucket>()) : undefined;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (ipStore && ipPolicy) {
      const ip = reqIp(req);
      const ipResult = checkRate(ipStore, `${name}:${ip}`, ipPolicy, Date.now());
      if (!ipResult.ok) {
        log.warn({ endpoint: name, ip, retryAfter: ipResult.retryAfter }, 'auth rate limit hit (ip)');
        res.setHeader('Retry-After', String(ipResult.retryAfter));
        res.status(429).json({ error: 'too many attempts — please wait and try again', code: 'RATE_LIMITED', retryAfter: ipResult.retryAfter });
        return;
      }
    }
    const email =
      typeof req.body?.email === 'string' && req.body.email.trim()
        ? `email:${req.body.email.trim().toLowerCase()}`
        : `ip:${reqIp(req)}`;
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

/** Test helper — clear all buckets (account + IP). */
export function _resetAuthRateLimit(): void {
  for (const k of Object.keys(stores)) delete stores[k];
  for (const k of Object.keys(ipStores)) delete ipStores[k];
}
