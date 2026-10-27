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
 *
 * `connection` param (ADR-030 §2 dispatch plumbing): every helper below takes
 * an optional trailing `connection`. Omitted (every call site today — shared
 * tier, unconditionally, until the dedicated-isolation tier is sold), each
 * helper resolves to the exact same global singleton `model` it always has —
 * zero behavior change. When a future dual-write/dedicated-tier call site
 * passes a `mongoose.Connection` (e.g. from `getConnectionForTenant`,
 * `runtime/src/shared/tenant-db-registry.ts`), `resolveScopedModel` rebinds
 * the query to that connection's copy of the same schema instead — this is
 * the chokepoint ADR-030 §2 named as "the one place ADR-010's scoped store
 * pattern needs a second parameter threaded." Nothing calls it with a real
 * connection yet (that's ADR-031's `dualWriteWithRetry` dispatch, which has
 * "nothing to consume until it exists" per ADR-031's own Consequences) — this
 * is the plumbing that call needs, not the call itself.
 */
import type { Model, FilterQuery, UpdateQuery, UpdateWithAggregationPipeline, PipelineStage, Connection } from 'mongoose';
import { AuthError } from '../core/tenant-context.js';

/**
 * Resolve the model a scoped-query call should actually run against: the
 * passed-in singleton by default (`connection` omitted/undefined — today's
 * only path), or that same schema bound to a dedicated-tier `connection`
 * (`conn.model(name, schema)` — reuses an already-registered model on that
 * connection if present, same as mongoose's own model cache, so repeated
 * calls don't re-register the schema).
 */
export function resolveScopedModel<T extends Scoped>(model: Model<T>, connection?: Connection): Model<T> {
  if (!connection) return model;
  const modelName = model.modelName;
  return (connection.models[modelName] as Model<T> | undefined) ?? connection.model<T>(modelName, model.schema);
}

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
export function scopedFind<T extends Scoped>(model: Model<T>, tenantId: string | undefined, filter: Filter = {}, connection?: Connection) {
  return resolveScopedModel(model, connection).find(withTenant(tenantId, filter) as FilterQuery<T>);
}

/** `Model.findOne` scoped to a tenant. */
export function scopedFindOne<T extends Scoped>(model: Model<T>, tenantId: string | undefined, filter: Filter = {}, connection?: Connection) {
  return resolveScopedModel(model, connection).findOne(withTenant(tenantId, filter) as FilterQuery<T>);
}

/** `Model.countDocuments` scoped to a tenant. */
export function scopedCountDocuments<T extends Scoped>(model: Model<T>, tenantId: string | undefined, filter: Filter = {}, connection?: Connection) {
  return resolveScopedModel(model, connection).countDocuments(withTenant(tenantId, filter) as FilterQuery<T>);
}

/**
 * Scope the `$match` of an aggregation pipeline. Prepends a `$match` that pins
 * `tenantId`, so tenant isolation applies BEFORE every downstream stage
 * ($group, $sort, vector ranking, …). Critical for §1.5 #3.
 */
export function scopedAggregate<T extends Scoped>(model: Model<T>, tenantId: string | undefined, pipeline: PipelineStage[], connection?: Connection) {
  const scope = tenantScope(tenantId);
  return resolveScopedModel(model, connection).aggregate([{ $match: scope }, ...pipeline]);
}

/** `Model.updateOne` scoped to a tenant. */
export function scopedUpdateOne<T extends Scoped>(model: Model<T>, tenantId: string | undefined, filter: Filter, update: UpdateQuery<T>, options?: Record<string, unknown>, connection?: Connection) {
  return resolveScopedModel(model, connection).updateOne(withTenant(tenantId, filter) as FilterQuery<T>, update, options ?? {});
}

/**
 * `Model.findOneAndUpdate` scoped to a tenant (used by the upsert stores).
 * Accepts an aggregation-pipeline update (array) as well as a classic update
 * document — the keyed-lease store uses pipelines so `$$NOW` (Mongo server
 * time) drives lease expiry instead of each gateway's own clock. Only the
 * UPDATE may be a pipeline; the tenant scope is still injected into the filter.
 */
export function scopedFindOneAndUpdate<T extends Scoped>(model: Model<T>, tenantId: string | undefined, filter: Filter, update: UpdateQuery<T> | UpdateWithAggregationPipeline, options?: Record<string, unknown>, connection?: Connection) {
  return resolveScopedModel(model, connection).findOneAndUpdate(withTenant(tenantId, filter) as FilterQuery<T>, update, options ?? {});
}

/** `Model.deleteOne` scoped to a tenant. */
export function scopedDeleteOne<T extends Scoped>(model: Model<T>, tenantId: string | undefined, filter: Filter = {}, connection?: Connection) {
  return resolveScopedModel(model, connection).deleteOne(withTenant(tenantId, filter) as FilterQuery<T>);
}

/** `Model.deleteMany` scoped to a tenant. */
export function scopedDeleteMany<T extends Scoped>(model: Model<T>, tenantId: string | undefined, filter: Filter = {}, connection?: Connection) {
  return resolveScopedModel(model, connection).deleteMany(withTenant(tenantId, filter) as FilterQuery<T>);
}
