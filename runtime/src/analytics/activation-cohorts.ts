/**
 * Activation funnel drop-off + signup-cohort report — the operator PRODUCT
 * analytics view (dashboard /analytics/funnel).
 *
 * Distinct from the two funnels that already exist:
 *  - monitoring/activation-funnel.ts::getActivationRollup — the continuity-aha
 *    funnel (signup → … → wrapup_merge), the "did they reach the brain moment"
 *    question.
 *  - getSelfServeConversion — a blended signup → retained headline number.
 *
 * This module answers the question the product operator asks NEXT: *where in
 * the activation journey do signups fall out, and is onboarding getting better
 * or worse over time?* It tracks the plain product journey
 *
 *   signup → init (project connected) → first_task (first task executed)
 *          → first_ship (first task shipped)
 *
 * with an explicit per-stage DROP-OFF count/%, and breaks the same funnel out
 * PER SIGNUP COHORT (month or ISO-week) so a fixed onboarding step shows up as
 * newer cohorts converting better — a blended all-time number can never show
 * that.
 *
 * Same sourcing + privacy posture as the other funnels: first-touch
 * ActivationEvent rows stamped at existing gateway chokepoints (ADR-014
 * metering write path), counting tenants only — never any tenant's content.
 * Cross-tenant BY DESIGN; guard it to the operator surface.
 *
 * The math is pure (computeFunnelDropoff) and mirrored to
 * dashboard/src/lib/activation-cohorts.ts (same discipline as
 * nrr-cohort.ts ↔ dashboard/src/lib/nrr-cohort.ts); getFunnelDropoff is the
 * Mongo-backed wrapper the MCP tool serves.
 */
import { createChildLogger } from '../shared/logger.js';
import { isConnected, ActivationEventModel } from '../shared/db.js';

const log = createChildLogger({ module: 'activation-cohorts' });

/** The operator activation journey, in order. Index = funnel depth. */
export const OPERATOR_FUNNEL_STEPS: ReadonlyArray<{ step: string; label: string }> = [
  { step: 'signup', label: 'Signed up' },
  { step: 'init', label: 'Project connected' },
  { step: 'first_task', label: 'First task executed' },
  { step: 'first_ship', label: 'First task shipped' },
] as const;

export type CohortGranularity = 'month' | 'week';

/** One first-touch milestone row: the (tenant, step) pair and when it happened. */
export interface FunnelEventRow {
  tenantId: string;
  step: string;
  at: Date;
}

export interface DropoffStage {
  step: string;
  label: string;
  /** Distinct tenants that reached this stage. */
  tenants: number;
  /** % of signed-up tenants that reached this stage (0 when no signups). */
  pctOfSignup: number;
  /** % of the previous stage's tenants retained into this stage (100 at stage 0). */
  stepConversion: number;
  /** Tenants lost between the previous stage and this one (clamped ≥ 0). */
  droppedOff: number;
  /** droppedOff as % of the previous stage (0 at stage 0). */
  dropOffPct: number;
}

export interface FunnelCohortRow {
  /** Cohort key from the tenant's signup first-touch: '2026-07' or '2026-W28'. */
  cohort: string;
  /** Signups in this cohort (cohort membership = signup date). */
  signups: number;
  /** Tenants per stage, index-aligned with OPERATOR_FUNNEL_STEPS. */
  stages: number[];
  /** Final stage ÷ signups, 0–100 — this cohort's full-funnel conversion. */
  conversionRate: number;
}

export interface FunnelDropoffReport {
  stages: DropoffStage[];
  /** Distinct tenants at 'signup'. */
  signups: number;
  /** Distinct tenants at the terminal stage ('first_ship'). */
  shipped: number;
  /** shipped ÷ signups, 0–100 — the headline activation-to-value number. */
  conversionRate: number;
  /** The stage with the largest drop-off count, or null when nothing dropped. */
  worstStage: { step: string; label: string; droppedOff: number; dropOffPct: number } | null;
  /** Signup cohorts (newest first), each with its own per-stage funnel. */
  cohorts: FunnelCohortRow[];
  granularity: CohortGranularity;
  /** Optional window the report was computed over (ISO). */
  since?: string;
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** ISO-8601 week key ('2026-W28') — Thursday-anchored, UTC. */
function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7; // Mon=1 … Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - day); // shift to this ISO week's Thursday
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function emptyFunnelDropoffReport(granularity: CohortGranularity = 'month', since?: Date): FunnelDropoffReport {
  return {
    stages: OPERATOR_FUNNEL_STEPS.map((s, i) => ({
      step: s.step, label: s.label, tenants: 0, pctOfSignup: 0,
      stepConversion: i === 0 ? 100 : 0, droppedOff: 0, dropOffPct: 0,
    })),
    signups: 0,
    shipped: 0,
    conversionRate: 0,
    worstStage: null,
    cohorts: [],
    granularity,
    since: since?.toISOString(),
  };
}

/**
 * Pure funnel math over first-touch rows. `since` (when set) keeps only
 * milestones that occurred in the window — same semantics as
 * getActivationRollup, so a tenant who signed up before the window but shipped
 * inside it counts at the later stage only (the stages are independent
 * distinct-tenant counts, exactly like the existing rollup). Cohort membership
 * is defined by the SIGNUP first-touch, so only tenants whose signup falls in
 * the window appear in the cohort table; their later milestones count into
 * their signup cohort whenever they happened.
 */
export function computeFunnelDropoff(
  rows: FunnelEventRow[],
  opts: { granularity?: CohortGranularity; since?: Date } = {},
): FunnelDropoffReport {
  const granularity = opts.granularity ?? 'month';
  const stepIndex = new Map(OPERATOR_FUNNEL_STEPS.map((s, i) => [s.step, i]));

  // Per-tenant first-touch per stage (defensive $min in case of duplicate rows).
  const byTenant = new Map<string, Map<number, Date>>();
  for (const r of rows) {
    const idx = stepIndex.get(r.step);
    if (idx === undefined || !r.tenantId) continue;
    const at = new Date(r.at);
    if (opts.since && at < opts.since) continue;
    const steps = byTenant.get(r.tenantId) ?? new Map<number, Date>();
    const prev = steps.get(idx);
    if (!prev || at < prev) steps.set(idx, at);
    byTenant.set(r.tenantId, steps);
  }

  // Overall stage counts + drop-off.
  const counts = OPERATOR_FUNNEL_STEPS.map((_s, i) => {
    let n = 0;
    for (const steps of byTenant.values()) if (steps.has(i)) n++;
    return n;
  });
  const signups = counts[0];
  let prev = signups;
  const stages: DropoffStage[] = OPERATOR_FUNNEL_STEPS.map((s, i) => {
    const tenants = counts[i];
    const pctOfSignup = signups > 0 ? Math.round((tenants / signups) * 100) : 0;
    const stepConversion = i === 0 ? 100 : prev > 0 ? Math.round((tenants / prev) * 100) : 0;
    const droppedOff = i === 0 ? 0 : Math.max(prev - tenants, 0);
    const dropOffPct = i === 0 || prev <= 0 ? 0 : Math.round((droppedOff / prev) * 100);
    prev = tenants;
    return { step: s.step, label: s.label, tenants, pctOfSignup, stepConversion, droppedOff, dropOffPct };
  });
  const worst = stages.reduce<DropoffStage | null>(
    (acc, s) => (s.droppedOff > (acc?.droppedOff ?? 0) ? s : acc), null);

  // Signup cohorts — keyed by each tenant's signup first-touch.
  const cohortMap = new Map<string, { signups: number; stages: number[] }>();
  for (const steps of byTenant.values()) {
    const signupAt = steps.get(0);
    if (!signupAt) continue;
    const key = granularity === 'week' ? isoWeekKey(signupAt) : monthKey(signupAt);
    const entry = cohortMap.get(key) ?? { signups: 0, stages: OPERATOR_FUNNEL_STEPS.map(() => 0) };
    entry.signups++;
    for (let i = 0; i < OPERATOR_FUNNEL_STEPS.length; i++) if (steps.has(i)) entry.stages[i]++;
    cohortMap.set(key, entry);
  }
  const last = OPERATOR_FUNNEL_STEPS.length - 1;
  const cohorts: FunnelCohortRow[] = [...cohortMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1)) // newest first
    .map(([cohort, { signups: n, stages: st }]) => ({
      cohort,
      signups: n,
      stages: st,
      conversionRate: n > 0 ? Math.round((st[last] / n) * 100) : 0,
    }));

  const shipped = counts[last];
  return {
    stages,
    signups,
    shipped,
    conversionRate: signups > 0 ? Math.round((shipped / signups) * 100) : 0,
    worstStage: worst ? { step: worst.step, label: worst.label, droppedOff: worst.droppedOff, dropOffPct: worst.dropOffPct } : null,
    cohorts,
    granularity,
    since: opts.since?.toISOString(),
  };
}

/**
 * Mongo-backed wrapper: pull the first-touch rows for the four operator stages
 * and run the pure engine. Never throws — degrades to the empty report when
 * the DB is unreachable (the dashboard/tool must always render).
 */
export async function getFunnelDropoff(
  opts: { granularity?: CohortGranularity; since?: Date } = {},
): Promise<FunnelDropoffReport> {
  const granularity = opts.granularity ?? 'month';
  try {
    if (!isConnected()) return emptyFunnelDropoffReport(granularity, opts.since);
    const match: Record<string, unknown> = { step: { $in: OPERATOR_FUNNEL_STEPS.map((s) => s.step) } };
    if (opts.since) match.occurredAt = { $gte: opts.since };
    // tenant-ok: cross-tenant BY DESIGN — operator/product funnel (counts
    // distinct tenants per stage, never surfaces any tenant's content).
    const rows = await ActivationEventModel.aggregate<{ _id: { tenantId: string; step: string }; at: Date }>([
      { $match: match },
      { $group: { _id: { tenantId: '$tenantId', step: '$step' }, at: { $min: '$occurredAt' } } },
    ]);
    return computeFunnelDropoff(
      rows.map((r) => ({ tenantId: r._id.tenantId, step: r._id.step, at: r.at })),
      { granularity, since: opts.since },
    );
  } catch (err) {
    log.debug({ err }, 'funnel drop-off unavailable — returning empty');
    return emptyFunnelDropoffReport(granularity, opts.since);
  }
}
