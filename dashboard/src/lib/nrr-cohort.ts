// Net-revenue-retention (NRR) COHORT report — expansion vs contraction vs churn,
// tracked per signup-month cohort over time. Distinct from lib/revenue.ts, which
// reports a single trailing-window NRR number; this module answers the
// retention-quality question investors actually ask: "of the accounts that
// signed up in month X, how did their combined MRR evolve month over month —
// how much came from upgrades/overage (expansion), how much was lost to
// downgrades (contraction) vs full cancellation (churn)?"
//
// Mirror of runtime/src/analytics/nrr-cohort.ts (same discipline as
// revenue.ts ↔ runtime/src/analytics/revenue.ts). Pure math — no I/O. Fed a
// starting cohort (each account's MRR in its first paying month) plus, for
// each later month, a lookup of each account's MRR then (absent/0 ⇒ churned).

export interface CohortAccountStart {
  tenantId: string;
  startingMrr: number;
}

export interface CohortMonthSnapshot {
  /** Calendar label for this month, e.g. "2026-02". */
  month: string;
  /** Months elapsed since the cohort's starting month (0 = the starting month itself). */
  monthsSinceStart: number;
  /** Current MRR for a starting account, by tenantId (absent/0 ⇒ churned by this month). */
  currentMrrById: Readonly<Record<string, number>>;
}

export interface CohortNrrPoint {
  cohortMonth: string;
  month: string;
  monthsSinceStart: number;
  startingLogos: number;
  startingMrr: number;
  /** Sum of MRR gained by accounts now paying MORE than their cohort start (upgrades/overage). */
  expansionMrr: number;
  /** Sum of MRR lost by accounts still paying, but LESS than their cohort start (downgrades). */
  contractionMrr: number;
  /** MRR lost from accounts that dropped to 0 (full churn) by this month. */
  churnedMrr: number;
  /** Count of accounts at 0 MRR by this month. */
  churnedLogos: number;
  /** startingMrr + expansionMrr − contractionMrr − churnedMrr. */
  endingMrr: number;
  /** endingMrr ÷ startingMrr — the NRR ratio for this cohort at this month (>1 = net expansion). */
  netRevenueRetention: number;
}

/** Compute one cohort/month point: starting MRR split into expansion / contraction / churn. */
export function computeCohortNrrPoint(
  cohortMonth: string,
  startingAccounts: readonly CohortAccountStart[],
  snapshot: Pick<CohortMonthSnapshot, 'month' | 'monthsSinceStart' | 'currentMrrById'>,
): CohortNrrPoint {
  let startingMrr = 0;
  let expansionMrr = 0;
  let contractionMrr = 0;
  let churnedMrr = 0;
  let churnedLogos = 0;

  for (const a of startingAccounts) {
    startingMrr += a.startingMrr;
    const current = snapshot.currentMrrById[a.tenantId] ?? 0;

    if (current <= 0) {
      churnedMrr += a.startingMrr;
      churnedLogos += 1;
      continue;
    }
    if (current > a.startingMrr) expansionMrr += current - a.startingMrr;
    else if (current < a.startingMrr) contractionMrr += a.startingMrr - current;
  }

  const endingMrr = startingMrr + expansionMrr - contractionMrr - churnedMrr;
  return {
    cohortMonth,
    month: snapshot.month,
    monthsSinceStart: snapshot.monthsSinceStart,
    startingLogos: startingAccounts.length,
    startingMrr,
    expansionMrr,
    contractionMrr,
    churnedMrr,
    churnedLogos,
    endingMrr,
    netRevenueRetention: startingMrr > 0 ? endingMrr / startingMrr : 0,
  };
}

/** Compute the full month-over-month series for one cohort (sorted by monthsSinceStart). */
export function computeCohortNrrSeries(
  cohortMonth: string,
  startingAccounts: readonly CohortAccountStart[],
  monthlySnapshots: readonly CohortMonthSnapshot[],
): CohortNrrPoint[] {
  return monthlySnapshots
    .slice()
    .sort((a, b) => a.monthsSinceStart - b.monthsSinceStart)
    .map((snap) => computeCohortNrrPoint(cohortMonth, startingAccounts, snap));
}

/** Input for computeCohortNrrReport: one cohort's starting accounts + its monthly snapshots. */
export interface CohortInput {
  cohortMonth: string;
  startingAccounts: readonly CohortAccountStart[];
  monthlySnapshots: readonly CohortMonthSnapshot[];
}

/** Compute the series for every cohort, sorted oldest cohort first. */
export function computeCohortNrrReport(cohorts: readonly CohortInput[]): CohortNrrPoint[][] {
  return cohorts
    .slice()
    .sort((a, b) => a.cohortMonth.localeCompare(b.cohortMonth))
    .map((c) => computeCohortNrrSeries(c.cohortMonth, c.startingAccounts, c.monthlySnapshots));
}
