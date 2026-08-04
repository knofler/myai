import type { Schema } from 'mongoose';

// ── Read-side DB failover state (MONGO_MIRROR.md follow-up) ──────────────
// When the primary (Atlas) is unreachable at boot AND the operator opted in
// with MYAI_DB_FAILOVER=local, connectDB() falls back to the warm local
// mirror kept by `myai mirror`. The 2026-07-04 split-brain lesson is the
// design constraint here: the gateway must NEVER silently serve stale local
// data as if it were canonical. So failover is (a) opt-in only, (b) loudly
// logged, (c) surfaced on /health/deep + the dashboard health panel, and
// (d) READ-ONLY — the guard plugin below rejects every mongoose write while
// failover is active, so nothing written to the mirror can later diverge
// from Atlas.

export interface DbFailoverState {
  /** True while the gateway is serving reads from the local mirror. */
  active: boolean;
  mode: 'local';
  /** Redacted host of the primary URI that failed (no credentials). */
  primaryUriHost?: string;
  /** Redacted host of the mirror actually connected to. */
  failoverUriHost?: string;
  /** Primary connection error that triggered the failover. */
  reason?: string;
  /** ISO timestamp the failover activated. */
  activatedAt?: string;
}

let state: DbFailoverState = { active: false, mode: 'local' };

export function getDbFailoverState(): DbFailoverState {
  return { ...state };
}

export function activateDbFailover(info: {
  primaryUriHost: string;
  failoverUriHost: string;
  reason: string;
}): void {
  state = {
    active: true,
    mode: 'local',
    primaryUriHost: info.primaryUriHost,
    failoverUriHost: info.failoverUriHost,
    reason: info.reason,
    activatedAt: new Date().toISOString(),
  };
}

/** Clear failover state (tests + a future reconnect-to-primary path). */
export function resetDbFailover(): void {
  state = { active: false, mode: 'local' };
}

// ── Read-only enforcement ────────────────────────────────────────────────

export class DbReadOnlyError extends Error {
  constructor(op: string) {
    super(
      `DB write '${op}' rejected: gateway is in READ-ONLY failover to the local mirror ` +
        `(MYAI_DB_FAILOVER=local, primary unreachable). Writes are blocked so the mirror ` +
        `never diverges from Atlas — restore the primary and restart to resume writes.`,
    );
    this.name = 'DbReadOnlyError';
  }
}

/** Throw when a write is attempted while read-only failover is active.
 *  Exported for non-middleware write paths (e.g. Model.bulkWrite, which
 *  mongoose middleware does not intercept). */
export function assertDbWritable(op: string): void {
  if (state.active) throw new DbReadOnlyError(op);
}

// Every mongoose write entry point that query/document middleware can
// intercept. Model.bulkWrite and raw driver calls bypass middleware — call
// assertDbWritable() explicitly on those paths.
const WRITE_QUERY_OPS = [
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'replaceOne',
] as const;

/**
 * Global mongoose plugin (registered in connectDB before models compile):
 * a no-op while failover is inactive; rejects all writes while it is.
 */
export function readOnlyGuardPlugin(schema: Schema): void {
  schema.pre('save', function (next) {
    if (state.active) return next(new DbReadOnlyError('save'));
    next();
  });
  schema.pre('insertMany', function (next: (err?: Error) => void) {
    if (state.active) return next(new DbReadOnlyError('insertMany'));
    next();
  });
  for (const op of WRITE_QUERY_OPS) {
    schema.pre(op, function (next) {
      if (state.active) return next(new DbReadOnlyError(op));
      next();
    });
  }
}
