/**
 * tenant-cutover — ADR-032 §2 cutover flip (ADR-030 §3 step 4, first half).
 *
 * Consumes ADR-031's `canCutoverTenant` gate (`dual-write-reconciler.ts`)
 * verbatim as a precondition — this file does not redefine or re-derive that
 * gate, it only acts on its answer (ADR-032 §"Builds on").
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ RACE-SAFETY (ADR-032 §2.2, HIGH)                                          │
 * │                                                                           │
 * │   The flip is a single `findOneAndUpdate({tenantId, status: 'migrating'},  │
 * │   {$set: {status: 'active', migratedAt}})` — the `status: 'migrating'`    │
 * │   filter makes this a compare-and-swap. A second concurrent cutover       │
 * │   attempt for the same tenant (operator double-click, a retriggered job)  │
 * │   simply fails to match once the first attempt has already flipped the    │
 * │   row, so it no-ops instead of double-stamping `migratedAt` or racing.    │
 * │   No separate lock/mutex is needed — Mongo's own atomic                   │
 * │   findOneAndUpdate is the race-safety mechanism.                          │
 * │                                                                           │
 * │   No explicit "stop the dual-write dispatcher" step exists either — per   │
 * │   ADR-031's resumability contract, the dispatcher already re-checks       │
 * │   `TenantDbBinding.status` per write and treats `active` as single-write  │
 * │   dedicated-only. The status flip *is* the stop signal, consumed          │
 * │   naturally on the dispatcher's next write for that tenant.               │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
import { TenantDbBindingModel } from './db.js';
import { canCutoverTenant } from './dual-write-reconciler.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger({ module: 'tenant-cutover' });

export type CutoverOutcome =
  | { flipped: true; tenantId: string; migratedAt: Date }
  | { flipped: false; tenantId: string; reason: 'gate-not-eligible'; reasons: string[] }
  | { flipped: false; tenantId: string; reason: 'no-op-not-migrating' };

/**
 * Attempt to cut a tenant over from `migrating` to `active`.
 *
 * 1. Re-checks ADR-031's cutover gate (`canCutoverTenant`) — never trusts a
 *    caller's stale "it was eligible a moment ago" belief.
 * 2. On eligible, performs the atomic compare-and-swap flip (§2.2 above).
 *
 * Safe to call concurrently/repeatedly for the same tenant: only one call
 * (across any number of simultaneous callers, and across retriggers of the
 * same job) will observe `flipped: true` for a given migration; every other
 * call observes `no-op-not-migrating` once the row is no longer `migrating`.
 *
 * @param now injectable clock (gate staleness math + `migratedAt` stamp) for
 *   deterministic tests.
 */
export async function cutoverTenant(tenantId: string, now: Date = new Date()): Promise<CutoverOutcome> {
  const gate = await canCutoverTenant(tenantId, now);
  if (!gate.eligible) {
    log.info({ tenantId, reasons: gate.reasons }, 'Cutover attempt rejected — gate not eligible');
    return { flipped: false, tenantId, reason: 'gate-not-eligible', reasons: gate.reasons };
  }

  const updated = await TenantDbBindingModel.findOneAndUpdate(
    { tenantId, status: 'migrating' },
    { $set: { status: 'active', migratedAt: now } },
    { new: true },
  ).lean();

  if (!updated) {
    // Gate passed, but by the time the CAS ran the binding was no longer
    // 'migrating' — another concurrent/retriggered attempt already won the
    // flip (or the tenant transitioned away some other way). This is the
    // no-op branch §2.2 requires: no double-stamp, no error.
    log.info({ tenantId }, 'Cutover no-op — binding was not in migrating status at flip time (already cut over)');
    return { flipped: false, tenantId, reason: 'no-op-not-migrating' };
  }

  log.info({ tenantId, migratedAt: now }, 'Tenant cutover flip complete — status migrating -> active');
  return { flipped: true, tenantId, migratedAt: now };
}
