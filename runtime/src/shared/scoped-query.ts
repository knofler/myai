/**
 * Tenant-scoped query helpers (ADR-010 §1.5 / §3.4, Day-2 step 8).
 *
 * Every read/write of a tenant-scoped collection (Task, Schedule, PlanDay,
 * RepoCard, Vector, GatewaySession, BudgetUsage, Notification, FleetRun) MUST
 * go through these helpers. They take an explicit `tenantId` and inject it into
 * the Mongo filter, so a store can never accidentally query across tenants —
 * the "forgotten filter" failure mode in §1.5.
 *
 * Two hard rules enforced here:
 *  1. `tenantId` is REQUIRED (a falsy id throws via `tenantScope`) — fail closed.
 *  2. A caller-supplied `tenantId` inside the ad-hoc `filter` is IGNORED — the
 *     scope is always written last, so the trusted server-derived id wins and a
 *     spoofed filter key can never widen the scope.
 *
 * These wrap the raw Mongoose Model methods and return the real Mongoose query
 * builders unchanged, so callers keep chaining `.sort().limit().lean<T>().exec()`
 * exactly as before.
 */
import type { Model, FilterQuery, UpdateQuery, PipelineStage } from 'mongoose';
import { AuthError } from '../core/tenant-context.js';

/** A plain Mongo filter object. */
export type Filter = Record<string, unknown>;

/**
 * Build the mandatory `{ tenantId }` scope. Throws (fail-closed) on a missing
 * tenant so a mis-wired call site errors loudly instead of running unscoped.
 * Mirrors `getTenantScope(ctx)` but takes the raw id the stores already hold.
 */
export function tenantScope(tenantId: string | undefined): { tenantId: string } {
  if (!tenantId) {
    throw new AuthError('no tenantId for scoped query', 500, 'NO_TENANT_CONTEXT');
  }
  return { tenantId };
}

/**
 * Merge a caller filter with the tenant scope. The scope is spread LAST so a
 * `tenantId` smuggled into `filter` can never override the trusted one.
 */
export function withTenant(tenantId: string | undefined, filter: Filter = {}): Filter {
  return { ...filter, ...tenantScope(tenantId) };
}

// A scoped collection always carries a `tenantId` field.
type Scoped = { tenantId: string };

/** `Model.find` scoped to a tenant. Returns the query builder unchanged. */
export function scopedFind<T extends Scoped>(model: Model<T>, tenantId: string | undefined, filter: Filter = {}) {
  return model.find(withTenant(tenantId, filter) as FilterQuery<T>);
}

/** `Model.findOne` scoped to a tenant. */
export function scopedFindOne<T extends Scoped>(model: Model<T>, tenantId: string | undefined, filter: Filter = {}) {
  return model.findOne(withTenant(tenantId, filter) as FilterQuery<T>);
}

/** `Model.countDocuments` scoped to a tenant. */
export function scopedCountDocuments<T extends Scoped>(model: Model<T>, tenantId: string | undefined, filter: Filter = {}) {
  return model.countDocuments(withTenant(tenantId, filter) as FilterQuery<T>);
}

/**
 * Scope the `$match` of an aggregation pipeline. Prepends a `$match` that pins
 * `tenantId`, so tenant isolation applies BEFORE every downstream stage
 * ($group, $sort, vector ranking, …). Critical for §1.5 #3.
 */
export function scopedAggregate<T extends Scoped>(model: Model<T>, tenantId: string | undefined, pipeline: PipelineStage[]) {
  const scope = tenantScope(tenantId);
  return model.aggregate([{ $match: scope }, ...pipeline]);
}

/** `Model.updateOne` scoped to a tenant. */
export function scopedUpdateOne<T extends Scoped>(model: Model<T>, tenantId: string | undefined, filter: Filter, update: UpdateQuery<T>, options?: Record<string, unknown>) {
  return model.updateOne(withTenant(tenantId, filter) as FilterQuery<T>, update, options ?? {});
}

/** `Model.findOneAndUpdate` scoped to a tenant (used by the upsert stores). */
export function scopedFindOneAndUpdate<T extends Scoped>(model: Model<T>, tenantId: string | undefined, filter: Filter, update: UpdateQuery<T>, options?: Record<string, unknown>) {
  return model.findOneAndUpdate(withTenant(tenantId, filter) as FilterQuery<T>, update, options ?? {});
}

/** `Model.deleteOne` scoped to a tenant. */
export function scopedDeleteOne<T extends Scoped>(model: Model<T>, tenantId: string | undefined, filter: Filter = {}) {
  return model.deleteOne(withTenant(tenantId, filter) as FilterQuery<T>);
}

/** `Model.deleteMany` scoped to a tenant. */
export function scopedDeleteMany<T extends Scoped>(model: Model<T>, tenantId: string | undefined, filter: Filter = {}) {
  return model.deleteMany(withTenant(tenantId, filter) as FilterQuery<T>);
}
