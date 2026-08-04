/**
 * Physical per-tenant DB connection routing (ADR-030 §2).
 *
 * `getConnectionForTenant(ctx)` is the single new chokepoint, mounted at the
 * same point ADR-010's `getTenantScope(ctx)` and ADR-024's `region-guard.ts`
 * already sit: immediately after tenant resolution, before any store call.
 *
 * THIS SLICE IS SHARED-TIER-ONLY (the no-op path):
 *  - `ctx.isolationTier` absent or `'shared'` (every tenant today, per
 *    migration 004's backfill) resolves to the exact same global connection
 *    `connectDB()` already returns — zero behavior change, zero new query
 *    path, for every tenant who doesn't opt in.
 *  - `'dedicated-db'` / `'dedicated-cluster'` cannot occur yet (nothing sets
 *    `Tenant.isolationTier` to those values outside a manually-constructed
 *    test context) — this deliberately does NOT attempt the dual-write
 *    migration machinery from ADR-030 §3, which is out of scope for this
 *    slice. It fails closed with a typed, catchable error instead of either
 *    throwing an unhandled exception or (far worse, per the ADR's own HIGH
 *    severity flag) silently falling back to the shared connection.
 */
import mongoose from 'mongoose';
import type { Request, Response, NextFunction } from 'express';
import { connectDB } from './db.js';
import { AuthError } from '../core/tenant-context.js';
import type { ToolContext } from '../core/tenant-context.js';

/**
 * Thrown when a tenant is on a dedicated isolation tier but no
 * `TenantDbBinding` routing/provisioning exists yet for it (the §3
 * provisioning + dual-write flow is a separate, queued follow-up). Fail
 * closed (ADR-030 "Severity flags for implementers", HIGH) — callers must
 * reject the request, never silently serve it off the shared connection.
 */
export class TenantIsolationNotProvisionedError extends AuthError {
  readonly tenantId: string;
  readonly isolationTier: 'dedicated-db' | 'dedicated-cluster';

  constructor(tenantId: string, isolationTier: 'dedicated-db' | 'dedicated-cluster') {
    super(
      `tenant '${tenantId}' is on isolation tier '${isolationTier}' but has no provisioned database yet`,
      501,
      'TENANT_ISOLATION_NOT_PROVISIONED',
    );
    this.name = 'TenantIsolationNotProvisionedError';
    this.tenantId = tenantId;
    this.isolationTier = isolationTier;
  }
}

/** Today's single global connection — byte-identical to calling `connectDB()` directly. */
function getSharedConnection(): Promise<typeof mongoose> {
  return connectDB();
}

/**
 * Resolve the mongoose connection (and, transitively, the models registered
 * on it) a tenant's store calls should use.
 *
 * Shared-tier (default, unconditionally, until the Phase-3 tier is sold):
 * returns today's `connectDB()` result unchanged.
 *
 * Dedicated tiers: not yet provisionable in this slice — fails closed with
 * `TenantIsolationNotProvisionedError` rather than attempting §3's dual-write
 * migration machinery (out of scope here) or silently falling back to the
 * shared connection (the exact failure this tier exists to prevent).
 */
export async function getConnectionForTenant(ctx: ToolContext): Promise<typeof mongoose> {
  const tier = ctx.isolationTier;
  if (!tier || tier === 'shared') {
    return getSharedConnection();
  }
  throw new TenantIsolationNotProvisionedError(ctx.tenantId, tier);
}

/**
 * Express middleware mounting the chokepoint on the REST/MCP transports, at
 * the same point `regionGuard` sits: after `authenticate()`, before routes.
 * A no-op (calls `next()` with no side effect) for the shared-tier majority
 * and for unresolved/local contexts (mirrors `regionMismatch`'s `!ctx || ctx.local`
 * guard) — this exists purely so a dedicated-tier ctx fails closed here,
 * before any store call, instead of at some later, easier-to-miss call site.
 */
export function tenantDbGuard() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ctx = req.tenant;
    if (!ctx || ctx.local) {
      next();
      return;
    }
    try {
      await getConnectionForTenant(ctx);
      next();
    } catch (err) {
      if (err instanceof TenantIsolationNotProvisionedError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  };
}
