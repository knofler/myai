/**
 * Per-tenant rate limiting + monthly request-quota enforcement at the gateway
 * MCP/REST edge (abuse / DoS protection for the multi-tenant surface).
 *
 * Two independent guards, both keyed by the SERVER-DERIVED tenant (req.tenant,
 * resolved by core/auth.ts) — never a caller-supplied value:
 *
 *  1. Burst rate limit — an in-memory sliding window (reuses the same pure
 *     `checkRate` as the auth surface), `PlanLimits.requestsPerMin` per tenant.
 *     Cheap, per-process; a hosted multi-instance deploy would move this to a
 *     shared store (same caveat as core/auth-rate-limit.ts). Rejected requests
 *     do NOT touch Mongo or count against the monthly quota. Both this and the
 *     monthly quota below resolve their per-tenant ceiling via
 *     `billing.ts planLimits()`, which layers a config default
 *     (`TENANT_RATE_LIMIT_RPM` / `TENANT_MONTHLY_REQUEST_LIMIT`) and a per-tier
 *     override (`..._<TIER>`, e.g. `TENANT_RATE_LIMIT_RPM_FREE`) over the
 *     hardcoded PLAN_LIMITS baseline — so ops can retune a live ceiling without
 *     a redeploy.
 *
 *  2. Monthly request quota — an atomic `$inc` on a per-(tenant, month) counter
 *     row in Mongo (`TenantRequestQuotaModel`), enforced against
 *     `PlanLimits.monthlyRequests`. Resets on the UTC calendar-month boundary
 *     (the next month is a fresh row).
 *
 * Both return 429 with a `Retry-After` header when exceeded — burst → seconds
 * until the window frees; quota → seconds until the month rolls over.
 *
 * INERT FOR THE LOCAL OPERATOR: `local` tenants (loopback / GATEWAY_LOCAL_TOKEN)
 * are never gated, and `scale` (the default local plan) has `-1` (unlimited)
 * limits — so the existing single-operator gateway never rate-limits and never
 * writes a quota counter. Only real tenants on finite plans (free/solo/team)
 * ever hit Mongo. Fully disable with TENANT_QUOTA_DISABLED=1.
 *
 * The quota write FAILS OPEN: a Mongo hiccup must not 500 all traffic, so a
 * counter error logs and allows the request (availability over strict quota).
 */
import type { Request, Response, NextFunction } from 'express';
import { checkRate } from './auth-rate-limit.js';
import { planLimits } from './billing.js';
import { TenantRequestQuotaModel } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'tenant-quota' });

const RATE_WINDOW_MS = 60_000;

/** In-memory per-tenant sliding-window store (process-local — see header). */
const rateStore = new Map<string, { hits: number[] }>();

/** UTC calendar-month bucket, e.g. "2026-07". */
export function monthKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Whole seconds until the start of next UTC month (Retry-After for quota). */
export function secondsUntilNextMonth(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Atomically bump this tenant's monthly counter and return the NEW count.
 * Upsert keyed by the unique {tenantId, period} index, so concurrent requests
 * increment the same row without a read-modify-write race.
 */
export async function incrementMonthlyUsage(tenantId: string, period: string): Promise<number> {
  const doc = await TenantRequestQuotaModel.findOneAndUpdate(
    { tenantId, period },
    { $inc: { count: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
    .lean<{ count: number }>()
    .exec();
  return doc?.count ?? 1;
}

/**
 * Pure quota verdict — exported for tests. `n` is the post-increment count.
 * A limit of -1 is unlimited (always ok).
 */
export function quotaVerdict(n: number, limit: number): boolean {
  return limit < 0 || n <= limit;
}

/**
 * Express middleware factory — per-tenant rate limit + monthly quota. Mount
 * AFTER `authenticate()` (needs `req.tenant`) and after the global per-IP
 * limiter, before the routes. Safe on both the REST app and the MCP app.
 */
export function tenantQuota() {
  const disabled = process.env.TENANT_QUOTA_DISABLED === '1';
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ctx = req.tenant;
    // No resolved tenant (exempt path) or the local operator → never gated.
    if (disabled || !ctx || ctx.local) {
      next();
      return;
    }

    const limits = planLimits(ctx.plan ?? 'free');
    const tenantId = ctx.tenantId;

    // 1. Burst rate limit (in-memory). Rejected requests stop here — they never
    //    touch Mongo nor count against the monthly quota.
    if (limits.requestsPerMin >= 0) {
      const { ok, retryAfter } = checkRate(
        rateStore,
        tenantId,
        { max: limits.requestsPerMin, windowMs: RATE_WINDOW_MS },
        Date.now(),
      );
      if (!ok) {
        log.warn({ tenantId, plan: ctx.plan, retryAfter, limit: limits.requestsPerMin }, 'tenant rate limit hit');
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({
          error: 'rate limit exceeded — slow down',
          code: 'RATE_LIMITED',
          retryAfter,
          limit: limits.requestsPerMin,
        });
        return;
      }
    }

    // 2. Monthly request quota (Mongo atomic counter). Fail-open on DB error.
    if (limits.monthlyRequests >= 0) {
      const now = new Date();
      let count: number;
      try {
        count = await incrementMonthlyUsage(tenantId, monthKey(now));
      } catch (err) {
        log.error({ err, tenantId }, 'quota counter increment failed — allowing (fail-open)');
        next();
        return;
      }
      if (!quotaVerdict(count, limits.monthlyRequests)) {
        const retryAfter = secondsUntilNextMonth(now);
        log.warn(
          { tenantId, plan: ctx.plan, count, limit: limits.monthlyRequests, retryAfter },
          'tenant monthly quota exceeded',
        );
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({
          error: 'monthly request quota exceeded — upgrade your plan or wait for the next billing period',
          code: 'QUOTA_EXCEEDED',
          retryAfter,
          limit: limits.monthlyRequests,
          used: count - 1,
        });
        return;
      }
    }

    next();
  };
}

/** Test helper — clear the in-memory rate buckets. */
export function _resetTenantQuota(): void {
  rateStore.clear();
}
