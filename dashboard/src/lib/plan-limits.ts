/**
 * Pure plan/tier table and its predicates — CLIENT-SAFE.
 *
 * Extracted out of `billing.ts` because that module imports `node:crypto` (Stripe
 * webhook signature verification) at module scope, and webpack pulls the whole
 * module graph into any client bundle that reaches it. The chain
 * `hosted-brain-upgrade.tsx` (a Client Component) → `hosted-brain.ts` →
 * `billing.ts` → `node:crypto` failed the production build outright, which is why
 * production deployments had been erroring.
 *
 * Nothing here may import anything server-only. Keep it pure: a table, its
 * lookup, and predicates over it. `billing.ts` re-exports all of it, so the 23
 * existing importers are unaffected.
 *
 * Kept in lock-step with the gateway (runtime/src/core/billing.ts) so checkout /
 * webhook / gate / UI agree on what each tier unlocks — enforced by the
 * mirror-parity test runtime/tests/unit/plan-limits-parity.test.ts (a field or
 * value added on one side only fails the gateway's `npm test`). A limit of -1
 * means "unlimited".
 */

export type TenantPlan = 'free' | 'solo' | 'team' | 'scale';

export interface PlanLimits {
  brainMaxAtoms: number;   // max brain atoms (-1 = unlimited)
  teamSeats: number;       // max member seats (-1 = unlimited)
  hostedBrain: boolean;    // managed cross-machine brain remote available?
  requestsPerMin: number;  // per-tenant burst ceiling: gateway req/min (-1 = unlimited)
  monthlyRequests: number; // per-tenant monthly request quota (-1 = unlimited)
  includedSpendUsd: number; // $ of LLM spend included before the 80%/100% spend alert (-1 = unlimited)
  teamFleetConsole: boolean; // cross-machine "who's doing what" panel on /fleet (GO_LIVE_PLAN Team tier)
}

export const PLAN_LIMITS: Readonly<Record<TenantPlan, PlanLimits>> = {
  free: { brainMaxAtoms: 500, teamSeats: 1, hostedBrain: false, requestsPerMin: 60, monthlyRequests: 10_000, includedSpendUsd: 5, teamFleetConsole: false },
  solo: { brainMaxAtoms: 5_000, teamSeats: 1, hostedBrain: true, requestsPerMin: 300, monthlyRequests: 200_000, includedSpendUsd: 50, teamFleetConsole: false },
  team: { brainMaxAtoms: 50_000, teamSeats: 10, hostedBrain: true, requestsPerMin: 1_000, monthlyRequests: 2_000_000, includedSpendUsd: 250, teamFleetConsole: true },
  scale: { brainMaxAtoms: -1, teamSeats: -1, hostedBrain: true, requestsPerMin: -1, monthlyRequests: -1, includedSpendUsd: -1, teamFleetConsole: true },
} as const;

export function planLimits(plan: TenantPlan): PlanLimits {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
}
export function withinBrainLimit(plan: TenantPlan, count: number): boolean {
  const max = planLimits(plan).brainMaxAtoms;
  return max < 0 || count <= max;
}
export function canAddSeat(plan: TenantPlan, currentSeats: number): boolean {
  const max = planLimits(plan).teamSeats;
  return max < 0 || currentSeats < max;
}
export function hasHostedBrain(plan: TenantPlan): boolean {
  return planLimits(plan).hostedBrain;
}
/** Team tier gate for the /fleet "Team Activity" panel — the cross-machine
 *  view of every teammate's latest sweep on a shared tenant. Free/Solo are
 *  single-seat, so there is nothing to show; Team/Scale unlock it. */
export function hasTeamFleetConsole(plan: TenantPlan): boolean {
  return planLimits(plan).teamFleetConsole;
}
