/**
 * Transactional-email delivery/bounce log + suppression list.
 *
 * The persistence half of the email substrate: email-service.ts records every
 * attempted send here (which template/version, over which provider, what
 * happened), and the `/api/email/events` webhook feeds provider bounce/
 * complaint/delivered events back onto the same rows via providerMessageId.
 * A hard bounce or a complaint auto-suppresses the address so no future
 * transactional send goes to it — repeatedly mailing a bouncing address is
 * how a sending domain gets blocklisted.
 *
 * Every function here is best-effort and NEVER throws: mail must still go out
 * on a self-host install with no Mongo at all, and a logging failure must
 * never fail a password reset. Models are resolved via dynamic import (same
 * posture as email-notify.ts) so consumers' unit tests that mock shared/db.js
 * with a subset of models keep working untouched.
 */
import crypto from 'node:crypto';
import { createChildLogger } from '../shared/logger.js';
import type { EmailDeliveryStatus, EmailSuppressionReason, IEmailDelivery } from '../shared/db.js';

const log = createChildLogger({ module: 'email-delivery-log' });

type DbModule = typeof import('../shared/db.js');

/** Resolve the db module only if it is actually connected; null otherwise. */
async function dbIfConnected(): Promise<DbModule | null> {
  try {
    const db = await import('../shared/db.js');
    if (typeof db.isConnected !== 'function' || !db.isConnected()) return null;
    return db;
  } catch {
    return null;
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ── Delivery log ─────────────────────────────────────────────

export interface DeliveryRecordInput {
  to: string;
  subject: string;
  provider: string;
  status: Extract<EmailDeliveryStatus, 'sent' | 'failed' | 'suppressed'>;
  tenantId?: string;
  template?: string;
  templateVersion?: number;
  providerMessageId?: string;
  error?: string;
}

/** Append one delivery row. Returns its deliveryId, or null when no DB. */
export async function recordDelivery(input: DeliveryRecordInput): Promise<string | null> {
  const db = await dbIfConnected();
  if (!db?.EmailDeliveryModel) return null;
  const deliveryId = `edl_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  try {
    await db.EmailDeliveryModel.create({
      deliveryId,
      to: normalizeEmail(input.to),
      subject: input.subject,
      provider: input.provider,
      status: input.status,
      tenantId: input.tenantId,
      template: input.template,
      templateVersion: input.templateVersion,
      providerMessageId: input.providerMessageId,
      error: input.error,
    });
    return deliveryId;
  } catch (err) {
    log.warn({ err, to: input.to }, 'failed to record email delivery');
    return null;
  }
}

// ── Provider event ingest (bounce / complaint / delivered) ──

export type EmailEventType = 'bounce' | 'complaint' | 'delivered';

export interface EmailEventInput {
  type: EmailEventType;
  /** Provider's message id — preferred join key back to the delivery row. */
  providerMessageId?: string;
  /** Fallback join/suppression key when the provider only sends the address. */
  email?: string;
  /** Soft bounces (mailbox full, greylisting) do NOT suppress; hard ones do. Default true. */
  hard?: boolean;
}

export interface EmailEventResult {
  ok: boolean;
  matched: number;      // delivery rows updated
  suppressed: boolean;  // address added to the suppression list by this event
}

const EVENT_STATUS: Record<EmailEventType, EmailDeliveryStatus> = {
  bounce: 'bounced',
  complaint: 'complained',
  delivered: 'delivered',
};

/**
 * Apply a provider webhook event to the log; auto-suppress on hard bounce or
 * complaint. Unmatched events are still ok:true — a bounce for a send from
 * before the log existed must still be able to suppress the address.
 */
export async function recordEmailEvent(evt: EmailEventInput): Promise<EmailEventResult> {
  const result: EmailEventResult = { ok: true, matched: 0, suppressed: false };
  const db = await dbIfConnected();
  const email = evt.email ? normalizeEmail(evt.email) : undefined;

  if (db?.EmailDeliveryModel && (evt.providerMessageId || email)) {
    try {
      const filter = evt.providerMessageId ? { providerMessageId: evt.providerMessageId } : { to: email };
      const updated = await db.EmailDeliveryModel.updateMany(filter, {
        $set: { status: EVENT_STATUS[evt.type], lastEventAt: new Date() },
      });
      result.matched = updated.matchedCount ?? 0;
    } catch (err) {
      log.warn({ err, evt }, 'failed to apply email event to delivery log');
    }
  }

  const shouldSuppress = evt.type === 'complaint' || (evt.type === 'bounce' && evt.hard !== false);
  if (shouldSuppress) {
    // Resolve the address from the matched delivery row when the webhook only
    // carried a provider message id.
    let target = email;
    if (!target && evt.providerMessageId && db?.EmailDeliveryModel) {
      try {
        const row = await db.EmailDeliveryModel
          .findOne({ providerMessageId: evt.providerMessageId })
          .lean<IEmailDelivery>();
        target = row?.to;
      } catch { /* best-effort */ }
    }
    if (target) {
      result.suppressed = await suppressEmail(
        target,
        evt.type === 'complaint' ? 'complaint' : 'hard-bounce',
        evt.providerMessageId,
      );
    }
  }
  return result;
}

// ── Suppression list ─────────────────────────────────────────

/** True when the address must not receive transactional mail. */
export async function isEmailSuppressed(email: string): Promise<boolean> {
  const db = await dbIfConnected();
  if (!db?.EmailSuppressionModel) return false;
  try {
    const row = await db.EmailSuppressionModel.findOne({ email: normalizeEmail(email) }).lean();
    return Boolean(row);
  } catch (err) {
    log.warn({ err, email }, 'suppression lookup failed — treating as not suppressed');
    return false;
  }
}

/** Idempotently add an address to the do-not-send list. */
export async function suppressEmail(email: string, reason: EmailSuppressionReason, source?: string): Promise<boolean> {
  const db = await dbIfConnected();
  if (!db?.EmailSuppressionModel) return false;
  try {
    await db.EmailSuppressionModel.updateOne(
      { email: normalizeEmail(email) },
      { $set: { reason, source }, $setOnInsert: { email: normalizeEmail(email) } },
      { upsert: true },
    );
    log.info({ email: normalizeEmail(email), reason }, 'email address suppressed');
    return true;
  } catch (err) {
    log.warn({ err, email }, 'failed to suppress email address');
    return false;
  }
}

/** Remove an address from the do-not-send list (ops correction path). */
export async function unsuppressEmail(email: string): Promise<boolean> {
  const db = await dbIfConnected();
  if (!db?.EmailSuppressionModel) return false;
  try {
    const res = await db.EmailSuppressionModel.deleteOne({ email: normalizeEmail(email) });
    return (res.deletedCount ?? 0) > 0;
  } catch (err) {
    log.warn({ err, email }, 'failed to unsuppress email address');
    return false;
  }
}

// ── Query surface (admin/ops) ────────────────────────────────

export interface ListDeliveriesFilter {
  to?: string;
  tenantId?: string;
  status?: EmailDeliveryStatus;
  limit?: number;
}

export async function listDeliveries(filter: ListDeliveriesFilter = {}): Promise<IEmailDelivery[]> {
  const db = await dbIfConnected();
  if (!db?.EmailDeliveryModel) return [];
  try {
    const query: Record<string, unknown> = {};
    if (filter.to) query.to = normalizeEmail(filter.to);
    if (filter.tenantId) query.tenantId = filter.tenantId;
    if (filter.status) query.status = filter.status;
    return await db.EmailDeliveryModel
      .find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200))
      .lean<IEmailDelivery[]>();
  } catch (err) {
    log.warn({ err, filter }, 'failed to list email deliveries');
    return [];
  }
}
