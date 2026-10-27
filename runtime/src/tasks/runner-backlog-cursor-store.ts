/**
 * Runner-backlog cursor store (task-e9163eb9) — the cross-machine
 * "how many config/runner_backlog.jsonl lines have been consumed" counter.
 *
 * Previously this lived only in a gitignored, machine-local file
 * (config/.runner_backlog.cursor), so a fresh checkout/worktree read
 * CONSUMED=0 regardless of the real consumption state on whichever machine
 * actually drives the runner. One document per tenant in Mongo now gives
 * every checkout the same answer, mirroring runner-lease-store.ts.
 */
import { RunnerBacklogCursorModel, isConnected } from '../shared/db.js';
import type { IRunnerBacklogCursor } from '../shared/db.js';
import { scopedFindOne, scopedFindOneAndUpdate } from '../shared/scoped-query.js';

function requireDb(): void {
  if (!isConnected() || !RunnerBacklogCursorModel) {
    throw new Error('MongoDB not connected — runner backlog cursor unavailable');
  }
}

/** Consumed count for the tenant; 0 when no cursor doc exists yet. */
export async function getBacklogCursor(tenantId: string): Promise<number> {
  requireDb();
  const doc = await scopedFindOne(RunnerBacklogCursorModel, tenantId, {})
    .lean()
    .exec() as IRunnerBacklogCursor | null;
  return doc?.consumed ?? 0;
}

/** Upsert the consumed count for the tenant; returns the stored value. */
export async function setBacklogCursor(tenantId: string, consumed: number): Promise<number> {
  requireDb();
  const doc = await scopedFindOneAndUpdate(
    RunnerBacklogCursorModel, tenantId,
    {},
    { $set: { consumed } },
    { upsert: true, new: true },
  ) as IRunnerBacklogCursor;
  return doc.consumed;
}

/**
 * Durable consumed-titles ledger (task-aa331af6). See the `confirmedTitles`
 * doc comment on IRunnerBacklogCursor for why this exists: unlike a
 * tasks_list(limit:2000) lookup, membership here never ages out as the
 * fleet-wide task table grows, so it is safe to use as a floor a corrected
 * cursor may never rewind past.
 */

/** Titles confirmed so far for the tenant; empty when no doc exists yet. */
export async function getConfirmedTitles(tenantId: string): Promise<string[]> {
  requireDb();
  const doc = await scopedFindOne(RunnerBacklogCursorModel, tenantId, {})
    .lean()
    .exec() as IRunnerBacklogCursor | null;
  return doc?.confirmedTitles ?? [];
}

/** Add titles to the ledger (idempotent, set semantics). Returns the full updated list. */
export async function addConfirmedTitles(tenantId: string, titles: string[]): Promise<string[]> {
  requireDb();
  if (titles.length === 0) return getConfirmedTitles(tenantId);
  const doc = await scopedFindOneAndUpdate(
    RunnerBacklogCursorModel, tenantId,
    {},
    { $addToSet: { confirmedTitles: { $each: titles } } },
    { upsert: true, new: true },
  ) as IRunnerBacklogCursor;
  return doc.confirmedTitles ?? [];
}
