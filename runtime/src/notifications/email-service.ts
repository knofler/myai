/**
 * Transactional-email service — THE send path for account-lifecycle mail
 * (email verification, password reset, invites, activation sequences).
 *
 * One call chains the whole substrate so every flow gets the same hardening
 * for free instead of re-implementing it:
 *
 *   suppression check → versioned template render (email-templates.ts)
 *     → provider-abstracted send (shared/mailer.ts: resend | smtp | console)
 *     → delivery log row (email-delivery-log.ts)
 *
 * Error contract: a transport failure is recorded on the delivery log and
 * then RE-THROWN — callers keep their existing failure semantics (a reset
 * request that couldn't email anyone should surface, not vanish). A
 * suppressed recipient is NOT an error: the send is skipped, logged as
 * 'suppressed', and reported in the result — mailing a hard-bounced address
 * again is strictly worse than not mailing it.
 */
import { getMailTransport, sendMail } from '../shared/mailer.js';
import {
  renderEmailTemplate,
  resolveTenantBranding,
  type EmailTemplateDataMap,
  type EmailTemplateName,
  type TenantBrandingInput,
} from './email-templates.js';
import { isEmailSuppressed, recordDelivery } from './email-delivery-log.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'email-service' });

export interface TransactionalSendOptions<T extends EmailTemplateName> {
  to: string;
  template: T;
  data: EmailTemplateDataMap[T];
  /** Tenant branding (from name/address, logo, color); null → product defaults. */
  tenant?: TenantBrandingInput | null;
  /** Recorded on the delivery log row for per-tenant audit; not used for branding. */
  tenantId?: string;
}

export interface TransactionalSendResult {
  status: 'sent' | 'suppressed';
  /** Delivery-log row id (null when the gateway runs without a DB). */
  deliveryId: string | null;
  provider: string;
  templateVersion: number;
}

export async function sendTransactionalEmail<T extends EmailTemplateName>(
  opts: TransactionalSendOptions<T>,
): Promise<TransactionalSendResult> {
  const to = opts.to.trim().toLowerCase();
  const rendered = renderEmailTemplate(opts.template, resolveTenantBranding(opts.tenant), opts.data);
  const provider = getMailTransport().name;
  const base = {
    to,
    subject: rendered.subject,
    provider,
    tenantId: opts.tenantId,
    template: opts.template as string,
    templateVersion: rendered.templateVersion,
  };

  if (await isEmailSuppressed(to)) {
    const deliveryId = await recordDelivery({ ...base, status: 'suppressed' });
    log.info({ to, template: opts.template }, 'transactional email skipped — address suppressed');
    return { status: 'suppressed', deliveryId, provider, templateVersion: rendered.templateVersion };
  }

  try {
    const sent = await sendMail({
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      from: rendered.from,
      replyTo: rendered.replyTo,
    });
    const deliveryId = await recordDelivery({
      ...base,
      status: 'sent',
      providerMessageId: sent.providerMessageId,
    });
    return { status: 'sent', deliveryId, provider, templateVersion: rendered.templateVersion };
  } catch (err) {
    await recordDelivery({
      ...base,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
