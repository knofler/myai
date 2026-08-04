// Historical MRR snapshot selection — prefers the persisted daily snapshots
// written by the runtime's nightly `mrr_snapshot_sweep` job (mirrored via the
// `MrrSnapshot` collection in db.ts) over the single "now" proxy /revenue and
// /revenue/nrr used before that job existed (each account previously
// contributed exactly one observed point, so expansion/contraction always
// read as a guess rather than a real trend).
//
// A tenant needs at least MIN_SNAPSHOTS_FOR_HISTORY persisted points before
// its history is trusted — with 0-1 snapshots there's no real trend to read
// yet, so callers fall back to the pre-existing proxy (current MRR reused as
// the historical point) exactly as before.

export interface MrrSnapshotPoint {
  mrr: number;
  capturedAt: Date;
}

const MIN_SNAPSHOTS_FOR_HISTORY = 2;

/**
 * The earliest persisted MRR for a tenant — the real "starting MRR" for
 * cohort math. Returns null when history is too thin to trust (fewer than
 * two snapshots); the caller should fall back to its proxy in that case.
 */
export function historicalStartingMrr(snapshots: readonly MrrSnapshotPoint[]): number | null {
  if (snapshots.length < MIN_SNAPSHOTS_FOR_HISTORY) return null;
  return snapshots.reduce((earliest, s) => (s.capturedAt < earliest.capturedAt ? s : earliest)).mrr;
}

/**
 * The real MRR as of `target` — the latest snapshot at or before it. Returns
 * null when history is too thin to trust, or when every snapshot postdates
 * `target` (the tenant's history doesn't reach back that far yet); the
 * caller should fall back to its proxy in either case.
 */
export function historicalMrrAsOf(snapshots: readonly MrrSnapshotPoint[], target: Date): number | null {
  if (snapshots.length < MIN_SNAPSHOTS_FOR_HISTORY) return null;
  const eligible = snapshots.filter((s) => s.capturedAt.getTime() <= target.getTime());
  if (eligible.length === 0) return null;
  return eligible.reduce((latest, s) => (s.capturedAt > latest.capturedAt ? s : latest)).mrr;
}
