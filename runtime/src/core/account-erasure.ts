/**
 * Self-serve account deletion — the GDPR/CCPA user-initiated right-to-erasure
 * flow (distinct from the operator-side data-retention purge-on-cancel, which
 * fires on subscription lapse, not a legal erasure request).
 *
 * A tenant owner requests erasure from account settings. The request is
 * recorded immediately (audit trail, ADR-013 §5) but the actual purge is
 * deferred by a grace window (`ERASURE_GRACE_DAYS`, default 14) so a change of
 * mind is recoverable via `cancelErasure`. Once the window elapses, an
 * operator-run sweep (`runErasureSweep`) irreversibly deletes every
 * tenant-scoped collection and scrubs the tenant row to a status='deleted'
 * tombstone (kept only so audit/erasure records still resolve to a tenantId —
 * no PII survives on it).
 *
 * One pending request per tenant at a time — a second request while one is
 * already pending is rejected (cancel first, then re-request).
 */
import crypto from 'node:crypto';
import {
  TenantModel,
  ErasureRequestModel,
  TenantApiKeyModel,
  GatewaySessionModel,
  VectorModel,
  TaskModel,
  RunnerLeaseModel,
  ScheduleModel,
  BudgetUsageModel,
  UsageEventModel,
  NotificationModel,
  PushSubscriptionModel,
  NotificationPrefsModel,
  RepoCardModel,
  PlanDayModel,
  FleetRunModel,
  UserModel,
  InviteModel,
  PasswordResetModel,
  ConnectorModel,
  HandoffModel,
  ContinuityMetricModel,
  ActivationEventModel,
  TenantRequestQuotaModel,
  WebhookEndpointModel,
  WebhookDeliveryModel,
  InboundWebhookDeliveryModel,
  ArtifactModel,
  MagicLinkModel,
  GiftRedemptionModel,
  type IErasureRequest,
  type ErasureRequestStatus,
} from '../shared/db.js';
import { scopedDeleteMany } from '../shared/scoped-query.js';
import { AuthError } from './tenant-context.js';
import { recordAuditEvent } from './audit-log.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'account-erasure' });

const ERASURE_GRACE_DAYS = Number(process.env.ERASURE_GRACE_DAYS) || 14;

/**
 * Every tenant-scoped collection wiped on purge, paired with the label used in
 * `purgeSummary`. Deliberately EXCLUDES the framework's global catalogs
 * (Agent/Skill/Hook/Rule/AIPattern carry no real per-tenant data — see
 * shared/scoped-query.ts header) and excludes `Tenant`/`ErasureRequest`
 * themselves, which the purge handles separately (scrub + tombstone).
 */
const PURGE_TARGETS = [
  ['tenantApiKeys', TenantApiKeyModel],
  ['gatewaySessions', GatewaySessionModel],
  ['vectors', VectorModel],
  ['tasks', TaskModel],
  ['runnerLeases', RunnerLeaseModel],
  ['schedules', ScheduleModel],
  ['budgetUsage', BudgetUsageModel],
  ['usageEvents', UsageEventModel],
  ['notifications', NotificationModel],
  ['pushSubscriptions', PushSubscriptionModel],
  ['notificationPrefs', NotificationPrefsModel],
  ['repoCards', RepoCardModel],
  ['planDays', PlanDayModel],
  ['fleetRuns', FleetRunModel],
  ['users', UserModel],
  ['invites', InviteModel],
  ['passwordResets', PasswordResetModel],
  ['magicLinks', MagicLinkModel],
  ['connectors', ConnectorModel],
  ['handoffs', HandoffModel],
  ['continuityMetrics', ContinuityMetricModel],
  ['activationEvents', ActivationEventModel],
  ['tenantRequestQuota', TenantRequestQuotaModel],
  ['webhookEndpoints', WebhookEndpointModel],
  ['webhookDeliveries', WebhookDeliveryModel],
  ['inboundWebhookDeliveries', InboundWebhookDeliveryModel],
  ['artifacts', ArtifactModel],
  ['giftRedemptions', GiftRedemptionModel],
] as const;

export interface ErasureRequestView {
  requestId: string;
  tenantId: string;
  requestedBy: string;
  status: ErasureRequestStatus;
  scheduledPurgeAt: Date;
  reason?: string;
  canceledBy?: string;
  canceledAt?: Date;
  purgedAt?: Date;
  purgeSummary?: Record<string, number>;
  createdAt?: Date;
}

function toView(r: IErasureRequest): ErasureRequestView {
  return {
    requestId: r.requestId,
    tenantId: r.tenantId,
    requestedBy: r.requestedBy,
    status: r.status,
    scheduledPurgeAt: r.scheduledPurgeAt,
    reason: r.reason,
    canceledBy: r.canceledBy,
    canceledAt: r.canceledAt,
    purgedAt: r.purgedAt,
    purgeSummary: r.purgeSummary,
    createdAt: r.createdAt,
  };
}

// ── Request ──

export interface RequestErasureInput {
  tenantId: string;
  requestedBy: string; // userId of the requesting owner
  requestedRole: string;
  reason?: string;
}

/**
 * Record a new erasure request. Owner-only (defense in depth — the REST route
 * also gates on the `billing` capability, which only owner/system/operator
 * hold). Rejects a second request while one is already pending.
 */
export async function requestErasure(input: RequestErasureInput): Promise<ErasureRequestView> {
  if (input.requestedRole !== 'owner' && input.requestedRole !== 'system' && input.requestedRole !== 'operator') {
    throw new AuthError('only the tenant owner can request account erasure', 403, 'FORBIDDEN');
  }

  const existing = await ErasureRequestModel.findOne({ tenantId: input.tenantId, status: 'pending' }).lean();
  if (existing) {
    throw new AuthError('an erasure request is already pending — cancel it first to re-request', 409, 'CONFLICT');
  }

  const scheduledPurgeAt = new Date(Date.now() + ERASURE_GRACE_DAYS * 86_400_000);
  const request = await ErasureRequestModel.create({
    requestId: `era_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    tenantId: input.tenantId,
    requestedBy: input.requestedBy,
    status: 'pending',
    scheduledPurgeAt,
    reason: input.reason,
  });

  log.warn(
    { tenantId: input.tenantId, requestId: request.requestId, scheduledPurgeAt },
    'account erasure requested',
  );
  recordAuditEvent({
    tenantId: input.tenantId,
    actor: { userId: input.requestedBy, role: 'owner', via: 'jwt' },
    action: 'account.erasure_request',
    target: input.tenantId,
    detail: { requestId: request.requestId, scheduledPurgeAt: scheduledPurgeAt.toISOString(), reason: input.reason },
  });

  return toView(request as IErasureRequest);
}

// ── Status ──

/** The tenant's most recent erasure request (any status), or null. */
export async function getErasureStatus(tenantId: string): Promise<ErasureRequestView | null> {
  const request = await ErasureRequestModel.findOne({ tenantId }).sort({ createdAt: -1 }).lean<IErasureRequest>();
  return request ? toView(request) : null;
}

// ── Cancel ──

export interface CancelErasureInput {
  tenantId: string;
  actorUserId: string;
  actorRole: string;
}

/** Cancel the tenant's pending erasure request within the grace window. */
export async function cancelErasure(input: CancelErasureInput): Promise<ErasureRequestView> {
  const request = await ErasureRequestModel.findOne({ tenantId: input.tenantId, status: 'pending' });
  if (!request) {
    throw new AuthError('no pending erasure request to cancel', 404, 'NOT_FOUND');
  }

  request.status = 'canceled';
  request.canceledBy = input.actorUserId;
  request.canceledAt = new Date();
  await request.save();

  log.info({ tenantId: input.tenantId, requestId: request.requestId }, 'account erasure canceled');
  recordAuditEvent({
    tenantId: input.tenantId,
    actor: { userId: input.actorUserId, role: input.actorRole as 'owner', via: 'jwt' },
    action: 'account.erasure_cancel',
    target: input.tenantId,
    detail: { requestId: request.requestId },
  });

  return toView(request as IErasureRequest);
}

// ── Purge (irreversible) ──

/**
 * Irreversibly wipe every tenant-scoped collection and scrub the tenant row to
 * a PII-free `status='deleted'` tombstone (kept so the erasure record itself,
 * and any audit trail entry, still resolves to a tenantId). Returns a
 * collection→deleted-count map — the evidence stored on the request.
 */
async function purgeTenantData(tenantId: string): Promise<Record<string, number>> {
  const summary: Record<string, number> = {};
  for (const [label, model] of PURGE_TARGETS) {
    const res = await scopedDeleteMany(model, tenantId);
    summary[label] = res.deletedCount ?? 0;
  }

  // Scrub the tenant row rather than deleting it outright — a tombstone keeps
  // the tenantId resolvable (audit trail, this very erasure record) without
  // retaining any PII (name/ownerEmail/live credential).
  await TenantModel.updateOne(
    { tenantId },
    {
      $set: {
        name: '[erased]',
        status: 'deleted',
        apiKeyHash: crypto.randomBytes(32).toString('hex'),
        apiKeyPrefix: `erased_${crypto.randomBytes(6).toString('hex')}`,
        metadata: { erased: true },
      },
      $unset: { ownerEmail: '', stripeCustomerId: '', stripeSubscriptionId: '' },
    },
  );

  return summary;
}

/**
 * Operator-run sweep: find every request past its grace window and purge it.
 * Each request is handled independently — a failure on one tenant is logged
 * and never blocks the rest of the sweep. Not wired to an automatic in-process
 * cron (the gateway's sweeps are externally triggered — see
 * scheduler/evening-sweep.ts header); an operator/cron invokes this on a daily
 * cadence, same as the morning/evening sweeps.
 */
export async function runErasureSweep(now: Date = new Date()): Promise<{ purged: string[]; failed: string[] }> {
  const due = await ErasureRequestModel.find({ status: 'pending', scheduledPurgeAt: { $lte: now } }).lean<IErasureRequest[]>();
  const purged: string[] = [];
  const failed: string[] = [];

  for (const request of due) {
    try {
      const purgeSummary = await purgeTenantData(request.tenantId);
      await ErasureRequestModel.updateOne(
        { requestId: request.requestId },
        { $set: { status: 'purged', purgedAt: now, purgeSummary } },
      );
      log.warn({ tenantId: request.tenantId, requestId: request.requestId, purgeSummary }, 'account erasure purged');
      recordAuditEvent({
        tenantId: request.tenantId,
        actor: { role: 'system', via: 'system' },
        action: 'account.erasure_purge',
        target: request.tenantId,
        detail: { requestId: request.requestId, purgeSummary },
      });
      purged.push(request.tenantId);
    } catch (err) {
      log.error({ err, tenantId: request.tenantId, requestId: request.requestId }, 'account erasure purge failed');
      failed.push(request.tenantId);
    }
  }

  return { purged, failed };
}
