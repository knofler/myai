/**
 * Tenant lifecycle beyond signup (GRAND_PRODUCT_ROADMAP.md §3.3/§7 DoD):
 * suspend / reactivate on billing state, and the operator-side
 * data-retention purge-on-cancel — hard-deleting a tenant's data once its
 * subscription has been fully canceled for `CANCELLATION_PURGE_GRACE_DAYS`.
 *
 * Self-serve PROVISIONING itself already exists (`tenant-keys.ts`
 * `provisionTenant`, wired through `POST /api/auth/signup`) — this module
 * covers the rest of the arc that follows it.
 *
 * Distinct from `account-erasure.ts`'s user-initiated right-to-erasure flow
 * (that file's header): this is triggered by BILLING STATE, not an owner's
 * explicit request, and — per the DoD — also wipes the tenant's audit trail
 * (account-erasure.ts deliberately does NOT, so a right-to-erasure purge
 * still leaves a compliance trail behind; a billing-driven offboarding has
 * no such requirement). Reuses `account-erasure.ts`'s `purgeTenantData` for
 * every tenant-scoped collection + tombstone shape so "what gets wiped" has
 * one definition, and layers the audit-trail wipe on top via
 * `audit-log.ts`'s `purgeTenantAuditTrail`.
 *
 * `suspend`/`reactivate` toggle `Tenant.status`, the SAME field
 * `auth.ts` `resolveTenantByKey` already gates on (`tenant.status !== 'active'`
 * → 403) — no separate enforcement path needed.
 */
import { TenantModel, type ITenant, type TenantStatus } from '../shared/db.js';
import { AuthError, type CtxRole } from './tenant-context.js';
import { recordAuditEvent, purgeTenantAuditTrail } from './audit-log.js';
import { purgeTenantData } from './account-erasure.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'tenant-lifecycle' });

export const CANCELLATION_PURGE_GRACE_DAYS = Number(process.env.CANCELLATION_PURGE_GRACE_DAYS) || 30;

interface ActorInput {
  actorUserId?: string;
  actorRole: string;
}

async function requireTenant(tenantId: string): Promise<ITenant & { _id: unknown }> {
  const tenant = await TenantModel.findOne({ tenantId }).lean<ITenant & { _id: unknown }>();
  if (!tenant) {
    throw new AuthError(`no such tenant '${tenantId}'`, 404, 'NOT_FOUND');
  }
  return tenant;
}

// ── Suspend / reactivate ────────────────────────────────────────────────

export interface SuspendTenantInput extends ActorInput {
  tenantId: string;
  reason?: string;
}

/**
 * Move a tenant to `status='suspended'` — blocks every gateway API-key call
 * (`auth.ts`) instantly. Idempotent no-op if already suspended; refuses a
 * `deleted` tombstone (there is nothing left to suspend).
 */
export async function suspendTenant(input: SuspendTenantInput): Promise<TenantStatus> {
  const tenant = await requireTenant(input.tenantId);
  if (tenant.status === 'deleted') {
    throw new AuthError(`tenant '${input.tenantId}' is deleted — cannot suspend`, 409, 'CONFLICT');
  }
  if (tenant.status === 'suspended') {
    return 'suspended';
  }

  await TenantModel.updateOne({ tenantId: input.tenantId }, { $set: { status: 'suspended' } });
  log.warn({ tenantId: input.tenantId, reason: input.reason }, 'tenant suspended');
  recordAuditEvent({
    tenantId: input.tenantId,
    actor: { userId: input.actorUserId, role: input.actorRole as CtxRole, via: input.actorRole === 'system' ? 'system' : 'operator' },
    action: 'tenant.suspend',
    target: input.tenantId,
    detail: { reason: input.reason },
  });
  return 'suspended';
}

export interface ReactivateTenantInput extends ActorInput {
  tenantId: string;
}

/**
 * Restore a suspended tenant to `status='active'`. Idempotent no-op if
 * already active; refuses a `deleted` tombstone. Also clears any pending
 * cancellation-purge schedule — reactivating a tenant implies it should not
 * be hard-deleted on the next sweep.
 */
export async function reactivateTenant(input: ReactivateTenantInput): Promise<TenantStatus> {
  const tenant = await requireTenant(input.tenantId);
  if (tenant.status === 'deleted') {
    throw new AuthError(`tenant '${input.tenantId}' is deleted — cannot reactivate`, 409, 'CONFLICT');
  }
  if (tenant.status === 'active' && !tenant.cancellationPurgeAt) {
    return 'active';
  }

  await TenantModel.updateOne(
    { tenantId: input.tenantId },
    { $set: { status: 'active' }, $unset: { cancellationPurgeAt: '' } },
  );
  log.info({ tenantId: input.tenantId }, 'tenant reactivated');
  recordAuditEvent({
    tenantId: input.tenantId,
    actor: { userId: input.actorUserId, role: input.actorRole as CtxRole, via: input.actorRole === 'system' ? 'system' : 'operator' },
    action: 'tenant.reactivate',
    target: input.tenantId,
  });
  return 'active';
}

// ── Cancellation purge scheduling ───────────────────────────────────────

export interface ScheduleCancellationPurgeOptions {
  now?: Date;
}

/**
 * Billing-driven counterpart to `requestErasure` (account-erasure.ts): called
 * when a subscription is fully canceled (billing webhook
 * `customer.subscription.deleted`). Starts the grace window; does NOT change
 * `status` — a canceled-but-still-in-grace tenant keeps working on the free
 * plan exactly as `billing.ts`'s gate already allows, same posture as a
 * pending erasure request leaving the tenant active until the sweep fires.
 * Idempotent: re-scheduling an already-scheduled purge is a no-op (keeps the
 * original deadline — a redelivered webhook must never push the purge date
 * further out).
 */
export async function scheduleCancellationPurge(
  tenantId: string,
  opts: ScheduleCancellationPurgeOptions = {},
): Promise<Date> {
  const now = opts.now ?? new Date();
  const tenant = await requireTenant(tenantId);
  if (tenant.cancellationPurgeAt) {
    return tenant.cancellationPurgeAt;
  }

  const purgeAt = new Date(now.getTime() + CANCELLATION_PURGE_GRACE_DAYS * 86_400_000);
  await TenantModel.updateOne({ tenantId }, { $set: { cancellationPurgeAt: purgeAt } });
  log.warn({ tenantId, cancellationPurgeAt: purgeAt }, 'tenant cancellation purge scheduled');
  recordAuditEvent({
    tenantId,
    actor: { role: 'system', via: 'system' },
    action: 'tenant.cancellation_scheduled',
    target: tenantId,
    detail: { cancellationPurgeAt: purgeAt.toISOString() },
  });
  return purgeAt;
}

/**
 * Reverse a scheduled cancellation purge — a resubscribe before the grace
 * window elapses (billing webhook `checkout.session.completed` /
 * `customer.subscription.updated` back to active/trialing). No-op if nothing
 * was scheduled.
 */
export async function cancelScheduledPurge(tenantId: string): Promise<boolean> {
  const tenant = await requireTenant(tenantId);
  if (!tenant.cancellationPurgeAt) {
    return false;
  }

  await TenantModel.updateOne({ tenantId }, { $unset: { cancellationPurgeAt: '' } });
  log.info({ tenantId }, 'tenant cancellation purge reversed (resubscribed)');
  recordAuditEvent({
    tenantId,
    actor: { role: 'system', via: 'system' },
    action: 'tenant.cancellation_reversed',
    target: tenantId,
  });
  return true;
}

// ── Sweep ────────────────────────────────────────────────────────────────

export interface CancellationPurgeSweepResult {
  purged: string[];
  failed: string[];
}

/**
 * Operator-run sweep (mirrors `runErasureSweep`'s shape exactly): find every
 * tenant whose `cancellationPurgeAt` is due, not already deleted, and not
 * under legal hold, then irreversibly purge it — every tenant-scoped
 * collection (`purgeTenantData`, tasks/plans/schedules/directory/... per the
 * DoD) PLUS its audit trail (`purgeTenantAuditTrail`, the one place this
 * flow diverges from account-erasure.ts). Each tenant is handled
 * independently; one failure never blocks the rest. Wired as the
 * `cancellation_purge_sweep` MCP tool + a daily schedule, same posture as
 * `erasure_sweep`.
 */
export async function runCancellationPurgeSweep(now: Date = new Date()): Promise<CancellationPurgeSweepResult> {
  const due = await TenantModel.find({
    cancellationPurgeAt: { $lte: now },
    status: { $ne: 'deleted' },
    legalHold: { $ne: true },
  })
    .select('tenantId')
    .lean<{ tenantId: string }[]>();

  const purged: string[] = [];
  const failed: string[] = [];

  for (const { tenantId } of due) {
    try {
      const purgeSummary = await purgeTenantData(tenantId);
      const auditPurge = purgeTenantAuditTrail(tenantId);
      await TenantModel.updateOne(
        { tenantId },
        { $set: { cancellationPurgedAt: now }, $unset: { cancellationPurgeAt: '' } },
      );
      log.warn({ tenantId, purgeSummary, auditPurge }, 'tenant cancellation purge complete');
      recordAuditEvent({
        tenantId,
        actor: { role: 'system', via: 'system' },
        action: 'tenant.cancellation_purge',
        target: tenantId,
        detail: { purgeSummary, auditLinesRemoved: auditPurge.linesRemoved, auditFilesDeleted: auditPurge.filesDeleted },
      });
      purged.push(tenantId);
    } catch (err) {
      log.error({ err, tenantId }, 'tenant cancellation purge failed');
      failed.push(tenantId);
    }
  }

  log.info({ ranAt: now, dueCount: due.length, purgedCount: purged.length, failedCount: failed.length }, 'cancellation purge sweep complete');
  return { purged, failed };
}
