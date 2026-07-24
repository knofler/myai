/**
 * Branded transactional-email template system — the single rendering layer
 * every transactional mail (verification, password reset, receipt, welcome,
 * digest) renders through. Individual flows (core/password-reset.ts,
 * a future email-verification flow, billing receipts, the KPI digest, …) own
 * WHEN to send and WHAT data goes in; this module owns HOW it looks: one HTML
 * layout, per-tenant branding (from name/address, reply-to, logo, accent
 * color), and a plain-text fallback rendered alongside every HTML body.
 *
 * Usage:
 *   const branding = resolveTenantBranding(tenant);
 *   await sendTemplatedMail(user.email, 'password-reset', tenant, { email, link, expiresMinutes });
 *
 * Preview surface: previewEmailTemplate() renders any template against fixture
 * data (PREVIEW_FIXTURES) so it can be inspected without sending real mail —
 * see core/server.ts's `/api/email-templates` routes.
 */
import { sendMail } from '../shared/mailer.js';
import type { ITenant } from '../shared/db.js';

// ── Branding ─────────────────────────────────────────────────

export type TenantBrandingInput = Pick<ITenant, 'name' | 'emailBranding'>;

export interface TenantBranding {
  tenantName: string;
  fromName: string;
  fromAddress: string;
  replyTo?: string;
  logoUrl?: string;
  primaryColor: string;
}

const DEFAULT_PRODUCT_NAME = 'myAI';
const DEFAULT_PRIMARY_COLOR = '#4f46e5';

function defaultFromAddress(): string {
  return process.env.SMTP_FROM || process.env.MAIL_FROM || 'myai@localhost';
}

/** Resolve a tenant's email branding, falling back to product defaults for anything unset (or no tenant at all). */
export function resolveTenantBranding(tenant?: TenantBrandingInput | null): TenantBranding {
  const b = tenant?.emailBranding ?? {};
  const tenantName = tenant?.name?.trim() || DEFAULT_PRODUCT_NAME;
  return {
    tenantName,
    fromName: b.fromName?.trim() || tenantName,
    fromAddress: b.fromAddress?.trim() || defaultFromAddress(),
    replyTo: b.replyTo?.trim() || undefined,
    logoUrl: b.logoUrl?.trim() || undefined,
    primaryColor: b.primaryColor?.trim() || DEFAULT_PRIMARY_COLOR,
  };
}

/** RFC 5322 `"Name" <address>` header, quoting the display name. */
function formatFromHeader(branding: TenantBranding): string {
  return `"${branding.fromName.replace(/"/g, "'")}" <${branding.fromAddress}>`;
}

// ── HTML escaping (template data may contain user-supplied strings) ────────

function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Shared layout ────────────────────────────────────────────

function layout(branding: TenantBranding, preheader: string, bodyHtml: string): string {
  const logo = branding.logoUrl
    ? `<img src="${escapeHtml(branding.logoUrl)}" alt="${escapeHtml(branding.tenantName)}" height="32" style="display:block;border:0;outline:none;" />`
    : `<span style="font-size:18px;font-weight:700;color:#111827;">${escapeHtml(branding.tenantName)}</span>`;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(branding.tenantName)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
            <tr>
              <td style="padding:24px 32px;border-bottom:1px solid #e5e7eb;">${logo}</td>
            </tr>
            <tr>
              <td style="padding:32px;color:#111827;font-size:15px;line-height:1.6;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;background:#fafafa;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;">
                Sent by ${escapeHtml(branding.tenantName)}. If you didn't expect this email, you can safely ignore it.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function button(branding: TenantBranding, href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr>
      <td style="border-radius:6px;background:${escapeHtml(branding.primaryColor)};">
        <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 24px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

// ── Template data contracts ──────────────────────────────────

export interface VerificationEmailData {
  email: string;
  link: string;
  expiresMinutes: number;
}

export interface PasswordResetEmailData {
  email: string;
  link: string;
  expiresMinutes: number;
}

export interface ReceiptEmailData {
  email: string;
  invoiceNumber: string;
  /** Pre-formatted for display, e.g. "$29.00". */
  amount: string;
  planName: string;
  periodStart: string;
  periodEnd: string;
  receiptUrl?: string;
}

export interface WelcomeEmailData {
  email: string;
  displayName?: string;
  dashboardUrl: string;
}

export interface DigestEmailItem {
  label: string;
  value: string;
}

export interface DigestEmailData {
  /** e.g. "week of Jul 21" */
  periodLabel: string;
  items: DigestEmailItem[];
  dashboardUrl: string;
}

export interface EmailTemplateDataMap {
  verification: VerificationEmailData;
  'password-reset': PasswordResetEmailData;
  receipt: ReceiptEmailData;
  welcome: WelcomeEmailData;
  digest: DigestEmailData;
}

export type EmailTemplateName = keyof EmailTemplateDataMap;

export const EMAIL_TEMPLATE_NAMES: readonly EmailTemplateName[] = [
  'verification',
  'password-reset',
  'receipt',
  'welcome',
  'digest',
];

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  from: string;
  replyTo?: string;
}

// ── Renderers (one per template) ─────────────────────────────

function renderVerification(b: TenantBranding, d: VerificationEmailData): RenderedEmail {
  const subject = `Verify your email for ${b.tenantName}`;
  const bodyHtml = `
    <p>Hi,</p>
    <p>Confirm <strong>${escapeHtml(d.email)}</strong> to finish setting up your ${escapeHtml(b.tenantName)} account.</p>
    ${button(b, d.link, 'Verify email')}
    <p style="color:#6b7280;font-size:13px;">This link expires in ${d.expiresMinutes} minutes and works once. If you didn't request this, you can ignore this email.</p>
  `;
  const text = [
    `Confirm ${d.email} to finish setting up your ${b.tenantName} account.`,
    '',
    `Verify here (expires in ${d.expiresMinutes} minutes, works once):`,
    d.link,
    '',
    "If you didn't request this, ignore this email.",
  ].join('\n');
  return { subject, html: layout(b, subject, bodyHtml), text, from: formatFromHeader(b), replyTo: b.replyTo };
}

function renderPasswordReset(b: TenantBranding, d: PasswordResetEmailData): RenderedEmail {
  const subject = `Reset your ${b.tenantName} password`;
  const bodyHtml = `
    <p>Hi,</p>
    <p>Someone (hopefully you) asked to reset the ${escapeHtml(b.tenantName)} password for <strong>${escapeHtml(d.email)}</strong>.</p>
    ${button(b, d.link, 'Reset password')}
    <p style="color:#6b7280;font-size:13px;">This link expires in ${d.expiresMinutes} minutes and works once. If you didn't ask for this, ignore this email — your password is unchanged.</p>
  `;
  const text = [
    `Someone (hopefully you) asked to reset the ${b.tenantName} password for ${d.email}.`,
    '',
    `Reset it here (expires in ${d.expiresMinutes} minutes, works once):`,
    d.link,
    '',
    "If you didn't ask for this, ignore this email — your password is unchanged.",
  ].join('\n');
  return { subject, html: layout(b, subject, bodyHtml), text, from: formatFromHeader(b), replyTo: b.replyTo };
}

function renderReceipt(b: TenantBranding, d: ReceiptEmailData): RenderedEmail {
  const subject = `Your ${b.tenantName} receipt — ${d.invoiceNumber}`;
  const receiptLink = d.receiptUrl ? button(b, d.receiptUrl, 'View receipt') : '';
  const bodyHtml = `
    <p>Hi,</p>
    <p>Thanks for your payment. Here's your receipt for ${escapeHtml(d.email)}:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:16px 0;border-collapse:collapse;">
      <tr><td style="padding:6px 0;color:#6b7280;">Invoice</td><td style="padding:6px 0;text-align:right;">${escapeHtml(d.invoiceNumber)}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Plan</td><td style="padding:6px 0;text-align:right;">${escapeHtml(d.planName)}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Period</td><td style="padding:6px 0;text-align:right;">${escapeHtml(d.periodStart)} – ${escapeHtml(d.periodEnd)}</td></tr>
      <tr><td style="padding:6px 0;font-weight:700;">Amount</td><td style="padding:6px 0;text-align:right;font-weight:700;">${escapeHtml(d.amount)}</td></tr>
    </table>
    ${receiptLink}
  `;
  const text = [
    `Thanks for your payment. Here's your receipt for ${d.email}:`,
    '',
    `Invoice: ${d.invoiceNumber}`,
    `Plan: ${d.planName}`,
    `Period: ${d.periodStart} - ${d.periodEnd}`,
    `Amount: ${d.amount}`,
    ...(d.receiptUrl ? ['', `View receipt: ${d.receiptUrl}`] : []),
  ].join('\n');
  return { subject, html: layout(b, subject, bodyHtml), text, from: formatFromHeader(b), replyTo: b.replyTo };
}

function renderWelcome(b: TenantBranding, d: WelcomeEmailData): RenderedEmail {
  const subject = `Welcome to ${b.tenantName}`;
  const greeting = d.displayName ? `Hi ${escapeHtml(d.displayName)},` : 'Hi,';
  const bodyHtml = `
    <p>${greeting}</p>
    <p>Your ${escapeHtml(b.tenantName)} account (${escapeHtml(d.email)}) is ready to go.</p>
    ${button(b, d.dashboardUrl, 'Open dashboard')}
  `;
  const text = [
    `${d.displayName ? `Hi ${d.displayName},` : 'Hi,'}`,
    '',
    `Your ${b.tenantName} account (${d.email}) is ready to go.`,
    '',
    `Open your dashboard: ${d.dashboardUrl}`,
  ].join('\n');
  return { subject, html: layout(b, subject, bodyHtml), text, from: formatFromHeader(b), replyTo: b.replyTo };
}

function renderDigest(b: TenantBranding, d: DigestEmailData): RenderedEmail {
  const subject = `Your ${b.tenantName} digest — ${d.periodLabel}`;
  const rows = d.items
    .map(
      (item) =>
        `<tr><td style="padding:6px 0;color:#6b7280;">${escapeHtml(item.label)}</td><td style="padding:6px 0;text-align:right;font-weight:600;">${escapeHtml(item.value)}</td></tr>`,
    )
    .join('');
  const bodyHtml = `
    <p>Here's your ${escapeHtml(b.tenantName)} summary for ${escapeHtml(d.periodLabel)}:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:16px 0;border-collapse:collapse;">${rows}</table>
    ${button(b, d.dashboardUrl, 'Open dashboard')}
  `;
  const text = [
    `Here's your ${b.tenantName} summary for ${d.periodLabel}:`,
    '',
    ...d.items.map((item) => `${item.label}: ${item.value}`),
    '',
    `Open your dashboard: ${d.dashboardUrl}`,
  ].join('\n');
  return { subject, html: layout(b, subject, bodyHtml), text, from: formatFromHeader(b), replyTo: b.replyTo };
}

// ── Dispatcher ────────────────────────────────────────────────

export function renderEmailTemplate<T extends EmailTemplateName>(
  name: T,
  branding: TenantBranding,
  data: EmailTemplateDataMap[T],
): RenderedEmail {
  switch (name) {
    case 'verification':
      return renderVerification(branding, data as VerificationEmailData);
    case 'password-reset':
      return renderPasswordReset(branding, data as PasswordResetEmailData);
    case 'receipt':
      return renderReceipt(branding, data as ReceiptEmailData);
    case 'welcome':
      return renderWelcome(branding, data as WelcomeEmailData);
    case 'digest':
      return renderDigest(branding, data as DigestEmailData);
    default:
      throw new Error(`Unknown email template: ${String(name)}`);
  }
}

/** Render + send in one call — the primary entry point for flows adopting the shared layer. */
export async function sendTemplatedMail<T extends EmailTemplateName>(
  to: string,
  name: T,
  tenant: TenantBrandingInput | null | undefined,
  data: EmailTemplateDataMap[T],
): Promise<void> {
  const branding = resolveTenantBranding(tenant);
  const rendered = renderEmailTemplate(name, branding, data);
  await sendMail({
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    from: rendered.from,
    replyTo: rendered.replyTo,
  });
}

// ── Preview surface ───────────────────────────────────────────
//
// Fixture data for each template so any template can be rendered without a
// real signup/reset/invoice in flight — powers the `/api/email-templates`
// preview routes in core/server.ts and is reused directly by the test suite.

export const PREVIEW_FIXTURES: EmailTemplateDataMap = {
  verification: { email: 'jane@example.com', link: 'https://app.example.com/verify?token=preview', expiresMinutes: 60 },
  'password-reset': { email: 'jane@example.com', link: 'https://app.example.com/login?reset=preview', expiresMinutes: 60 },
  receipt: {
    email: 'jane@example.com',
    invoiceNumber: 'INV-1024',
    amount: '$29.00',
    planName: 'Team',
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
    receiptUrl: 'https://app.example.com/billing/invoices/1024',
  },
  welcome: { email: 'jane@example.com', displayName: 'Jane', dashboardUrl: 'https://app.example.com/dashboard' },
  digest: {
    periodLabel: 'week of Jul 21',
    items: [
      { label: 'Tasks completed', value: '12' },
      { label: 'Tokens saved', value: '48K' },
    ],
    dashboardUrl: 'https://app.example.com/dashboard',
  },
};

/** Render a template against fixture data (optionally with real tenant branding) — never sends mail. */
export function previewEmailTemplate(name: EmailTemplateName, tenant?: TenantBrandingInput | null): RenderedEmail {
  const branding = resolveTenantBranding(tenant);
  return renderEmailTemplate(name, branding, PREVIEW_FIXTURES[name]);
}

export function isEmailTemplateName(value: string): value is EmailTemplateName {
  return (EMAIL_TEMPLATE_NAMES as readonly string[]).includes(value);
}
