// Team Activity panel logic for /fleet (Team tier — GO_LIVE_PLAN "team fleet
// console"). A solo tenant only ever has one machine driving the sweep, so the
// existing /fleet page just renders the single latest FleetRun. A shared Team
// tenant can have several teammates on several machines running sweeps at the
// same time — this collapses recent runs down to "each machine's latest run"
// so a team can see what everyone else is doing, not just the newest run
// overall (which would otherwise hide every other machine's in-flight work).

export interface FleetRunSummary {
  runId: string;
  machine?: string;
  agent?: string;
  status?: string;
  startedAt?: string | Date;
  finishedAt?: string | Date;
  summary?: { total?: number; needsAction?: number; shipped?: number; failed?: number };
}

/**
 * Collapse `runs` (expected newest-first, e.g. sorted by `startedAt: -1`) to
 * one entry per machine — the most recent run each machine has kicked off.
 * Runs with no `machine` are grouped under `'unknown'` rather than dropped, so
 * older data (pre-machine-field runs) still surfaces.
 */
export function latestRunPerMachine(runs: FleetRunSummary[]): FleetRunSummary[] {
  const seen = new Set<string>();
  const out: FleetRunSummary[] = [];
  for (const r of runs) {
    const key = r.machine?.trim() || 'unknown';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
