// Activation funnel drop-off + signup-cohort engine — the operator PRODUCT
// analytics view behind /analytics/funnel. Tracks the plain activation journey
//
//   signup → init (project connected) → first_task (first task executed)
//          → first_ship (first task shipped)
//
// with an explicit per-stage DROP-OFF count/% and the same funnel broken out
// per signup cohort (month or ISO week), so onboarding fixes show up as newer
// cohorts converting better. Distinct from the /analytics continuity-aha and
// self-serve funnels (blended, no drop-off, no cohorts) and from /revenue
// (MRR/churn — money, not activation).
//
// Mirror of runtime/src/analytics/activation-cohorts.ts (same discipline as
// nrr-cohort.ts ↔ runtime/src/analytics/nrr-cohort.ts). Pure math — no I/O;
// the page feeds it first-touch ActivationEvent rows from the Mongo mirror.

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
  signups: number;
  shipped: number;
  /** shipped ÷ signups, 0–100 — the headline activation-to-value number. */
  conversionRate: number;
  /** The stage with the largest drop-off count, or null when nothing dropped. */
  worstStage: { step: string; label: string; droppedOff: number; dropOffPct: number } | null;
  /** Signup cohorts (newest first), each with its own per-stage funnel. */
  cohorts: FunnelCohortRow[];
  granularity: CohortGranularity;
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

/**
 * Pure funnel math over first-touch rows. `since` (when set) keeps only
 * milestones that occurred in the window — a tenant who signed up before the
 * window but shipped inside it counts at the later stage only (stages are
 * independent distinct-tenant counts, same semantics as the /analytics
 * rollup). Cohort membership is defined by the SIGNUP first-touch; a cohort
 * tenant's later milestones count into their signup cohort whenever they
 * happened.
 */
export function computeFunnelDropoff(
  rows: FunnelEventRow[],
  opts: { granularity?: CohortGranularity; since?: Date } = {},
): FunnelDropoffReport {
  const granularity = opts.granularity ?? 'month';
  const stepIndex = new Map(OPERATOR_FUNNEL_STEPS.map((s, i) => [s.step, i]));

  // Per-tenant first-touch per stage (defensive min in case of duplicate rows).
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
