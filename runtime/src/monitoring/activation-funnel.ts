/**
 * Activation funnel — privacy-respecting product analytics.
 *
 * Instruments the onboarding funnel as first-class, tenant-scoped events so the
 * product can answer the one question a SaaS lives or dies on: *of the accounts
 * that sign up, how many reach the continuity "aha"?* The five milestones, in
 * order, are:
 *
 *   signup → init → first_brain_boot → first_brain_delta → wrapup_merge
 *
 * Each is stamped the FIRST time a tenant reaches it, from a chokepoint that
 * already exists in the gateway (signup handler, context_boot, brain_delta,
 * brain_merge, repo-card upsert). There is NO third-party tracker: activation
 * is derived entirely from data that already flows through the gateway, so it
 * inherits the tenant's data locality (ADR-010) and privacy posture. Recording
 * is fire-and-forget — a meter failure must never fail the metered operation
 * (the ADR-014 usage-metering posture) — and idempotent: the unique
 * {tenantId, step} index makes a re-emission (every wrap-up, every boot) a
 * no-op, so the funnel reflects first-touch, not activity volume.
 *
 * Two read shapes:
 *  - getActivationFunnel(tenantId) — the tenant's OWN journey (scoped, ADR-010):
 *    which milestones they've hit, when, and their activation % — an onboarding
 *    progress meter for that account.
 *  - getActivationRollup() — the FLEET funnel: distinct tenants at each step and
 *    the overall activation rate. This is the operator/product view and is
 *    intentionally cross-tenant (it counts tenants, never exposing any tenant's
 *    content); guard it to the operator surface.
 */
import { createChildLogger } from '../shared/logger.js';
import { isConnected, ActivationEventModel, TaskModel } from '../shared/db.js';
import { scopedAggregate } from '../shared/scoped-query.js';
import type { ActivationStep, IActivationEvent } from '../shared/db.js';

const log = createChildLogger({ module: 'activation-funnel' });

/** The funnel, in order. Index = depth; last step = "activated". */
export const ACTIVATION_STEPS: ReadonlyArray<{ step: ActivationStep; label: string }> = [
  { step: 'signup', label: 'Signed up' },
  { step: 'init', label: 'Project connected' },
  { step: 'first_brain_boot', label: 'First brain boot' },
  { step: 'first_brain_delta', label: 'First brain delta' },
  { step: 'wrapup_merge', label: 'Continuity aha (wrap-up merge)' },
] as const;

/** The terminal step — reaching it means the tenant is "activated". */
export const ACTIVATED_STEP: ActivationStep = 'wrapup_merge';

export interface RecordActivationOptions {
  repo?: string;
  source?: IActivationEvent['source'];
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Stamp the first time a tenant reaches an activation milestone. Idempotent
 * (first-wins via the unique {tenantId, step} index) and fire-and-forget:
 * returns false — never throws — when the DB is down or the id is empty, so
 * callers can `void` it at a chokepoint without risking the metered operation.
 * Returns true only when THIS call created the row (the genuine first touch).
 */
export async function recordActivation(
  tenantId: string,
  step: ActivationStep,
  opts: RecordActivationOptions = {},
): Promise<boolean> {
  if (!tenantId) return false;
  try {
    if (!isConnected()) return false;
    const res = await ActivationEventModel.updateOne(
      { tenantId, step },
      {
        $setOnInsert: {
          tenantId,
          step,
          repo: opts.repo?.trim() || undefined,
          source: opts.source ?? 'gateway',
          occurredAt: opts.occurredAt ?? new Date(),
          metadata: opts.metadata,
        },
      },
      { upsert: true },
    );
    // upsertedCount === 1 only on the genuine first touch; a re-emission is 0.
    return (res.upsertedCount ?? 0) > 0;
  } catch (err) {
    // A duplicate-key race (two chokepoints firing at once) is expected and OK.
    log.debug({ err, step }, 'activation event not recorded');
    return false;
  }
}

export interface FunnelStep {
  step: ActivationStep;
  label: string;
  reached: boolean;
  at?: string;   // ISO occurredAt when reached
}

export interface ActivationFunnel {
  tenantId: string;
  steps: FunnelStep[];
  reachedCount: number;    // milestones reached
  totalSteps: number;      // ACTIVATION_STEPS.length
  activated: boolean;      // reached the terminal step
  /** Fraction of the funnel completed, 0–100. */
  activationPct: number;
}

/**
 * The tenant's OWN activation journey (ADR-010 scoped). Degrades to an all-unreached
 * funnel when the DB is unreachable — the panel must always render.
 */
export async function getActivationFunnel(tenantId: string): Promise<ActivationFunnel> {
  const base: ActivationFunnel = {
    tenantId,
    steps: ACTIVATION_STEPS.map((s) => ({ step: s.step, label: s.label, reached: false })),
    reachedCount: 0,
    totalSteps: ACTIVATION_STEPS.length,
    activated: false,
    activationPct: 0,
  };
  try {
    if (!isConnected()) return base;
    const rows = await scopedAggregate(ActivationEventModel, tenantId, [
      { $group: { _id: '$step', at: { $min: '$occurredAt' } } },
    ]) as Array<{ _id: ActivationStep; at: Date }>;
    const reached = new Map(rows.map((r) => [r._id, r.at]));
    base.steps = ACTIVATION_STEPS.map((s) => {
      const at = reached.get(s.step);
      return { step: s.step, label: s.label, reached: !!at, at: at ? new Date(at).toISOString() : undefined };
    });
    base.reachedCount = base.steps.filter((s) => s.reached).length;
    base.activated = !!reached.get(ACTIVATED_STEP);
    base.activationPct = Math.round((base.reachedCount / base.totalSteps) * 100);
    return base;
  } catch (err) {
    log.debug({ err }, 'activation funnel unavailable — returning empty');
    return base;
  }
}

export interface RollupStep {
  step: ActivationStep;
  label: string;
  tenants: number;         // distinct tenants that reached this step
  /** % of signed-up tenants that reached this step (0 when no signups). */
  pctOfSignup: number;
  /** % of the previous step's tenants retained into this step. */
  stepConversion: number;
}

export interface ActivationRollup {
  steps: RollupStep[];
  signups: number;         // distinct tenants at 'signup'
  activated: number;       // distinct tenants at the terminal step
  /** activated / signups, 0–100 — the headline product number. */
  activationRate: number;
  /** Optional window the rollup was computed over (ISO). */
  since?: string;
}

/**
 * The FLEET activation funnel — distinct tenants at each step and the overall
 * activation rate. Cross-tenant BY DESIGN (it counts tenants, never surfacing
 * any tenant's content); this is the operator/product analytics view. Optional
 * `since` bounds it to tenants whose milestone occurred in the window.
 */
export async function getActivationRollup(opts: { since?: Date } = {}): Promise<ActivationRollup> {
  const empty: ActivationRollup = {
    steps: ACTIVATION_STEPS.map((s) => ({ step: s.step, label: s.label, tenants: 0, pctOfSignup: 0, stepConversion: 0 })),
    signups: 0,
    activated: 0,
    activationRate: 0,
    since: opts.since?.toISOString(),
  };
  try {
    if (!isConnected()) return empty;
    const match: Record<string, unknown> = {};
    if (opts.since) match.occurredAt = { $gte: opts.since };
    // tenant-ok: cross-tenant BY DESIGN — see doc comment above (counts
    // tenants per step, never surfaces any tenant's content).
    const rows = await ActivationEventModel.aggregate<{ _id: ActivationStep; tenants: number }>([
      ...(Object.keys(match).length ? [{ $match: match }] : []),
      // distinct tenants per step
      { $group: { _id: { step: '$step', tenantId: '$tenantId' } } },
      { $group: { _id: '$_id.step', tenants: { $sum: 1 } } },
    ]);
    const byStep = new Map(rows.map((r) => [r._id, r.tenants]));
    const signups = byStep.get('signup') ?? 0;
    let prev = signups;
    const steps: RollupStep[] = ACTIVATION_STEPS.map((s, i) => {
      const tenants = byStep.get(s.step) ?? 0;
      const pctOfSignup = signups > 0 ? Math.round((tenants / signups) * 100) : 0;
      const stepConversion = i === 0 ? 100 : prev > 0 ? Math.round((tenants / prev) * 100) : 0;
      prev = tenants;
      return { step: s.step, label: s.label, tenants, pctOfSignup, stepConversion };
    });
    const activated = byStep.get(ACTIVATED_STEP) ?? 0;
    return {
      steps,
      signups,
      activated,
      activationRate: signups > 0 ? Math.round((activated / signups) * 100) : 0,
      since: opts.since?.toISOString(),
    };
  } catch (err) {
    log.debug({ err }, 'activation rollup unavailable — returning empty');
    return empty;
  }
}

/** The self-serve conversion funnel, in order — distinct from ACTIVATION_STEPS'
 *  "continuity aha" framing. This is the plain sellable-product question:
 *  of the accounts that sign up, how many get real value (ship a task) and
 *  come back for more (retained)? */
export const SELF_SERVE_STEPS: ReadonlyArray<{ key: 'signup' | 'init' | 'first_value' | 'retained'; label: string }> = [
  { key: 'signup', label: 'Signed up' },
  { key: 'init', label: 'Project connected' },
  { key: 'first_value', label: 'First task shipped' },
  { key: 'retained', label: 'Retained (2nd task shipped)' },
] as const;

export interface SelfServeStep {
  key: 'signup' | 'init' | 'first_value' | 'retained';
  label: string;
  tenants: number;
  pctOfSignup: number;
  stepConversion: number;
}

export interface SelfServeConversion {
  steps: SelfServeStep[];
  signups: number;
  retained: number;
  /** retained / signups, 0–100 — the headline self-serve conversion number. */
  conversionRate: number;
}

/**
 * The self-serve conversion funnel: signup → init → first task shipped →
 * retained. Reuses the same ActivationEvent rows as getActivationRollup for
 * the first three steps ('first_ship' is stamped by the lifecycle-email
 * chokepoint on a tenant's first done task — see shared/db.ts's ActivationStep
 * doc comment). 'retained' is computed read-time from the Task collection
 * (distinct tenants with 2+ done tasks) rather than a stamped event, since it
 * is a standing state, not a first-touch milestone.
 */
export async function getSelfServeConversion(): Promise<SelfServeConversion> {
  const empty: SelfServeConversion = {
    steps: SELF_SERVE_STEPS.map((s) => ({ ...s, tenants: 0, pctOfSignup: 0, stepConversion: s.key === 'signup' ? 100 : 0 })),
    signups: 0,
    retained: 0,
    conversionRate: 0,
  };
  try {
    if (!isConnected()) return empty;
    // tenant-ok: cross-tenant BY DESIGN — see doc comment above (counts
    // distinct tenants per step, never surfaces any tenant's content).
    const eventRows = await ActivationEventModel.aggregate<{ _id: ActivationStep; tenants: number }>([
      { $match: { step: { $in: ['signup', 'init', 'first_ship'] } } },
      { $group: { _id: { step: '$step', tenantId: '$tenantId' } } },
      { $group: { _id: '$_id.step', tenants: { $sum: 1 } } },
    ]);
    const byStep = new Map(eventRows.map((r) => [r._id, r.tenants]));
    // tenant-ok: cross-tenant BY DESIGN — operator retention metric (counts
    // distinct tenants with 2+ done tasks, never surfaces any tenant's content).
    const retainedRows = await TaskModel.aggregate<{ _id: null; tenants: number }>([
      { $match: { status: 'done' } },
      { $group: { _id: '$tenantId', done: { $sum: 1 } } },
      { $match: { done: { $gte: 2 } } },
      { $count: 'tenants' },
    ]);
    const raw: Record<SelfServeStep['key'], number> = {
      signup: byStep.get('signup') ?? 0,
      init: byStep.get('init') ?? 0,
      first_value: byStep.get('first_ship') ?? 0,
      retained: retainedRows[0]?.tenants ?? 0,
    };
    const signups = raw.signup;
    let prev = signups;
    const steps: SelfServeStep[] = SELF_SERVE_STEPS.map((s, i) => {
      const tenants = raw[s.key];
      const pctOfSignup = signups > 0 ? Math.round((tenants / signups) * 100) : 0;
      const stepConversion = i === 0 ? 100 : prev > 0 ? Math.round((tenants / prev) * 100) : 0;
      prev = tenants;
      return { ...s, tenants, pctOfSignup, stepConversion };
    });
    return {
      steps,
      signups,
      retained: raw.retained,
      conversionRate: signups > 0 ? Math.round((raw.retained / signups) * 100) : 0,
    };
  } catch (err) {
    log.debug({ err }, 'self-serve conversion unavailable — returning empty');
    return empty;
  }
}

export interface HostedBrainConversion {
  signups: number;
  /** Distinct tenants who ever completed a first hosted-brain provision. */
  converted: number;
  /** converted / signups, 0-100 — the headline cross-machine-sync conversion number. */
  conversionRate: number;
}

/**
 * The cross-machine-sync (hosted brain) conversion KPI (ADR-023 Slice P3): of
 * the tenants that signed up, how many completed their first hosted-brain
 * provision? This is the countable numerator GO_LIVE_PLAN §6 needs now that
 * "Pro" reads as "Solo" — "cross-machine sync converted N of your M
 * customers." Reuses the same idempotent first-wins ActivationEvent rows as
 * getActivationRollup/getSelfServeConversion; 'first_hosted_brain' is stamped
 * once per tenant at handleBrainHostProvision's first successful call.
 */
export async function getHostedBrainConversion(): Promise<HostedBrainConversion> {
  const empty: HostedBrainConversion = { signups: 0, converted: 0, conversionRate: 0 };
  try {
    if (!isConnected()) return empty;
    // tenant-ok: cross-tenant BY DESIGN — operator/product KPI (counts distinct
    // tenants per step, never surfaces any tenant's content).
    const rows = await ActivationEventModel.aggregate<{ _id: ActivationStep; tenants: number }>([
      { $match: { step: { $in: ['signup', 'first_hosted_brain'] } } },
      { $group: { _id: { step: '$step', tenantId: '$tenantId' } } },
      { $group: { _id: '$_id.step', tenants: { $sum: 1 } } },
    ]);
    const byStep = new Map(rows.map((r) => [r._id, r.tenants]));
    const signups = byStep.get('signup') ?? 0;
    const converted = byStep.get('first_hosted_brain') ?? 0;
    return { signups, converted, conversionRate: signups > 0 ? Math.round((converted / signups) * 100) : 0 };
  } catch (err) {
    log.debug({ err }, 'hosted-brain conversion unavailable — returning empty');
    return empty;
  }
}
