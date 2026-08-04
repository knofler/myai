// Branded invoice PDF — a downloadable, myAI-branded invoice a customer's
// finance team can file (GO_LIVE_PLAN billing follow-up). Stripe's hosted
// portal only offers Stripe's own invoice list/PDF; this module fetches the
// invoice data from Stripe and renders OUR branded document instead.
//
// SDK-free AND dependency-free (mirrors billing.ts / overage.ts / dunning.ts):
//   1. Invoices are fetched from Stripe's REST API with plain `fetch`.
//   2. The PDF itself is produced by a minimal built-in PDF 1.4 writer — no
//      pdfkit/puppeteer (Docker-only-npm constraint; the dashboard build adds
//      NO new dependency). Single A4 page, Type1 Helvetica, uncompressed
//      content stream. Long invoices truncate with an "… and N more" row
//      rather than paginate — the full line detail always remains available
//      on Stripe's hosted invoice.
//
// Everything Stripe-facing degrades gracefully when env is unset (local dev /
// CI): `isInvoiceFetchConfigured()` is false and the routes 503. The model
// building + PDF rendering are pure (no env, no I/O) so they unit-test flat.

const STRIPE_API = 'https://api.stripe.com/v1';

// ── Env (read at call time so tests can toggle process.env) ────
/** Invoice fetch only needs the secret key — no price ids (unlike checkout). */
export function isInvoiceFetchConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/** Brand name stamped on the PDF header + filename (default myAI). */
export function invoiceBrandName(): string {
  return (process.env.INVOICE_BRAND_NAME || '').trim() || 'myAI';
}

/** Optional seller address block under the brand name — `|`-separated lines,
 *  e.g. "Powerhouse Pty Ltd|123 Example St|Sydney NSW 2000|ABN 12 345 678 901". */
export function invoiceBrandLines(): string[] {
  return (process.env.INVOICE_BRAND_ADDRESS || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Footer line at the bottom of the PDF. */
export function invoiceBrandFooter(): string {
  return (process.env.INVOICE_BRAND_FOOTER || '').trim() || 'Thank you for your business.';
}

// ── Stripe invoice types (the subset we read) ──────────────────
export interface StripeInvoiceLine {
  description?: string | null;
  quantity?: number | null;
  amount?: number; // minor units
  currency?: string;
}

export interface StripeInvoice {
  id: string;
  customer: string;
  number?: string | null;
  status?: string; // draft | open | paid | uncollectible | void
  currency?: string;
  created?: number; // unix seconds
  period_start?: number;
  period_end?: number;
  customer_name?: string | null;
  customer_email?: string | null;
  subtotal?: number;
  tax?: number | null;
  total?: number;
  amount_due?: number;
  amount_paid?: number;
  hosted_invoice_url?: string | null;
  status_transitions?: { paid_at?: number | null };
  lines?: { data?: StripeInvoiceLine[] };
}

async function stripeGet<T>(path: string): Promise<T> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY || ''}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message || `stripe ${res.status}`;
    throw new Error(msg);
  }
  return json as T;
}

/** List a customer's invoices, newest first (Stripe's default ordering). */
export async function listInvoices(
  stripeCustomerId: string,
  limit = 24,
): Promise<StripeInvoice[]> {
  const q = new URLSearchParams({ customer: stripeCustomerId, limit: String(limit) });
  const page = await stripeGet<{ data?: StripeInvoice[] }>(`/invoices?${q}`);
  return page.data ?? [];
}

/** Fetch one invoice by id. The caller MUST verify ownership afterwards
 *  ({@link invoiceBelongsToCustomer}) — the id alone is attacker-suppliable. */
export async function getInvoice(invoiceId: string): Promise<StripeInvoice> {
  return stripeGet<StripeInvoice>(`/invoices/${encodeURIComponent(invoiceId)}`);
}

/** Stripe invoice ids are `in_…` — reject anything else before it reaches a URL. */
export function isValidInvoiceId(id: string): boolean {
  return /^in_[A-Za-z0-9]+$/.test(id);
}

/** The tenant-isolation check: does this invoice belong to this Stripe
 *  customer? False on any missing side — never default-allow. */
export function invoiceBelongsToCustomer(
  invoice: Pick<StripeInvoice, 'customer'>,
  stripeCustomerId: string | undefined,
): boolean {
  return Boolean(invoice.customer && stripeCustomerId && invoice.customer === stripeCustomerId);
}

// ── Formatting (pure) ──────────────────────────────────────────
/** Stripe currencies charged in whole units (no minor-unit division). */
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

/** Format a Stripe minor-unit amount as e.g. "$49.00" / "¥500" / "12.34 XYZ". */
export function formatAmount(minorUnits: number, currency = 'usd'): string {
  const cur = (currency || 'usd').toLowerCase();
  const value = ZERO_DECIMAL.has(cur) ? minorUnits : minorUnits / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(value);
  } catch {
    return `${value.toFixed(ZERO_DECIMAL.has(cur) ? 0 : 2)} ${cur.toUpperCase()}`;
  }
}

/** Format a unix-seconds timestamp as "12 Jun 2026" (UTC — invoice dates must
 *  not shift with the server's timezone). Empty string when absent. */
export function formatUnixDate(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return '';
  const d = new Date(seconds * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// ── List-route summary (pure) ──────────────────────────────────
export interface InvoiceSummary {
  id: string;
  number: string;
  status: string;
  date: string;
  total: string;
  amountDue: string;
  currency: string;
  hostedUrl: string | null;
  /** Our branded download — relative so it works behind any base URL. */
  pdfPath: string;
}

export function invoiceSummary(inv: StripeInvoice): InvoiceSummary {
  return {
    id: inv.id,
    number: inv.number || inv.id,
    status: inv.status || 'unknown',
    date: formatUnixDate(inv.created),
    total: formatAmount(inv.total ?? 0, inv.currency),
    amountDue: formatAmount(inv.amount_due ?? 0, inv.currency),
    currency: (inv.currency || 'usd').toUpperCase(),
    hostedUrl: inv.hosted_invoice_url || null,
    pdfPath: `/api/billing/invoices/${inv.id}/pdf`,
  };
}

// ── PDF model (pure) ───────────────────────────────────────────
/** Max line items on the single page — beyond this we add a "+N more" row. */
export const MAX_PDF_LINES = 18;

export interface InvoicePdfLine {
  description: string;
  quantity: string;
  amount: string;
}

export interface InvoicePdfModel {
  brandName: string;
  brandLines: string[];
  footer: string;
  title: string; // INVOICE / RECEIPT semantics stay simple: always INVOICE
  number: string;
  status: string; // upper-cased badge, e.g. PAID
  issuedDate: string;
  paidDate: string;
  periodLabel: string;
  billedTo: string[];
  lines: InvoicePdfLine[];
  truncatedLineCount: number;
  subtotal: string;
  tax: string | null;
  total: string;
  amountPaid: string;
  amountDue: string;
  reference: string; // Stripe invoice id, for support lookups
}

export interface InvoiceBranding {
  brandName?: string;
  brandLines?: string[];
  footer?: string;
}

/** Shape a Stripe invoice into everything the PDF page shows. Branding is
 *  injectable for tests; defaults come from env at call time. */
export function buildInvoicePdfModel(
  inv: StripeInvoice,
  branding: InvoiceBranding = {},
): InvoicePdfModel {
  const currency = inv.currency;
  const allLines = (inv.lines?.data ?? []).map((l) => ({
    description: (l.description || 'Subscription').trim() || 'Subscription',
    quantity: String(l.quantity ?? 1),
    amount: formatAmount(l.amount ?? 0, l.currency || currency),
  }));
  const lines = allLines.slice(0, MAX_PDF_LINES);
  const period =
    inv.period_start && inv.period_end
      ? `${formatUnixDate(inv.period_start)} — ${formatUnixDate(inv.period_end)}`
      : '';
  const billedTo = [inv.customer_name, inv.customer_email]
    .map((s) => (s || '').trim())
    .filter(Boolean);
  return {
    brandName: branding.brandName ?? invoiceBrandName(),
    brandLines: branding.brandLines ?? invoiceBrandLines(),
    footer: branding.footer ?? invoiceBrandFooter(),
    title: 'INVOICE',
    number: inv.number || inv.id,
    status: (inv.status || 'unknown').toUpperCase(),
    issuedDate: formatUnixDate(inv.created),
    paidDate: formatUnixDate(inv.status_transitions?.paid_at),
    periodLabel: period,
    billedTo: billedTo.length ? billedTo : ['—'],
    lines,
    truncatedLineCount: allLines.length - lines.length,
    subtotal: formatAmount(inv.subtotal ?? 0, currency),
    tax: typeof inv.tax === 'number' && inv.tax !== 0 ? formatAmount(inv.tax, currency) : null,
    total: formatAmount(inv.total ?? 0, currency),
    amountPaid: formatAmount(inv.amount_paid ?? 0, currency),
    amountDue: formatAmount(inv.amount_due ?? 0, currency),
    reference: inv.id,
  };
}

/** Download filename, e.g. "myai-invoice-A1B2C3-0001.pdf" (safe charset only). */
export function invoicePdfFilename(model: Pick<InvoicePdfModel, 'brandName' | 'number'>): string {
  const brand = model.brandName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'invoice';
  const num = model.number.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'invoice';
  return `${brand}-invoice-${num}.pdf`;
}

// ── Minimal PDF writer (pure) ──────────────────────────────────
// A4 portrait: 595 × 842 pt. Two Type1 fonts (Helvetica / Helvetica-Bold),
// WinAnsi encoding, uncompressed content stream. Text is sanitized to
// Latin-1 (anything outside becomes '?') — the built-in fonts can't render
// beyond WinAnsi and a wrong glyph is worse than an explicit placeholder.

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 50;

/** Escape a string for a PDF literal string: backslash, parens, newlines. */
export function pdfEscape(text: string): string {
  return text
    .replace(/[^\x20-\xff]/g, '?') // Latin-1 printable only (strips \n\r\t too)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

// Helvetica advance widths (per 1000 em) for the chars our layout right-aligns
// (amounts + labels). Anything unlisted approximates to 556 (digit width) —
// close enough for alignment; never used for clipping decisions.
const HELV_WIDTHS: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '=': 584, '?': 556, 'A': 667, 'B': 667,
  'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778, 'H': 722, 'I': 278, 'J': 500,
  'K': 667, 'L': 556, 'M': 833, 'N': 722, 'O': 778, 'P': 667, 'Q': 778, 'R': 722,
  'S': 667, 'T': 611, 'U': 722, 'V': 667, 'W': 944, 'X': 667, 'Y': 667, 'Z': 611,
  'a': 556, 'b': 556, 'c': 500, 'd': 556, 'e': 556, 'f': 278, 'g': 556, 'h': 556,
  'i': 222, 'j': 222, 'k': 500, 'l': 222, 'm': 833, 'n': 556, 'o': 556, 'p': 556,
  'q': 556, 'r': 333, 's': 500, 't': 278, 'u': 556, 'v': 500, 'w': 722, 'x': 500,
  'y': 500, 'z': 500,
};

/** Approximate rendered width (pt) of `text` at `size` in Helvetica. */
export function approxTextWidth(text: string, size: number): number {
  let units = 0;
  for (const ch of text) units += HELV_WIDTHS[ch] ?? 556;
  return (units / 1000) * size;
}

/** Truncate `text` with an ellipsis so it fits `maxWidth` pt at `size`. */
export function fitText(text: string, size: number, maxWidth: number): string {
  if (approxTextWidth(text, size) <= maxWidth) return text;
  let out = text;
  // ASCII "..." (not U+2026) — WinAnsi-safe in every viewer.
  while (out.length > 1 && approxTextWidth(`${out}...`, size) > maxWidth) out = out.slice(0, -1);
  return `${out.trimEnd()}...`;
}

class ContentStream {
  private ops: string[] = [];

  text(x: number, y: number, str: string, size: number, opts: { bold?: boolean; gray?: number } = {}): void {
    const font = opts.bold ? '/F2' : '/F1';
    const g = opts.gray ?? 0;
    this.ops.push(
      `BT ${g} ${g} ${g} rg ${font} ${size} Tf 1 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)} Tm (${pdfEscape(str)}) Tj ET`,
    );
  }

  /** Right-aligned text: the string ENDS at x. */
  textRight(x: number, y: number, str: string, size: number, opts: { bold?: boolean; gray?: number } = {}): void {
    this.text(x - approxTextWidth(str, size), y, str, size, opts);
  }

  hline(y: number, gray = 0.75): void {
    this.ops.push(`${gray} ${gray} ${gray} RG 0.7 w ${MARGIN} ${y.toFixed(1)} m ${PAGE_W - MARGIN} ${y.toFixed(1)} l S`);
  }

  render(): string {
    return this.ops.join('\n');
  }
}

/** Lay the model out on one A4 page and return the finished PDF bytes. */
export function renderInvoicePdf(model: InvoicePdfModel): Buffer {
  const c = new ContentStream();
  const right = PAGE_W - MARGIN;
  let y = PAGE_H - 64;

  // Header — brand left, INVOICE + number right.
  c.text(MARGIN, y, model.brandName, 22, { bold: true });
  c.textRight(right, y, model.title, 20, { bold: true, gray: 0.45 });
  y -= 16;
  c.textRight(right, y, `# ${model.number}`, 10, { gray: 0.35 });
  for (const line of model.brandLines) {
    c.text(MARGIN, y, line, 8.5, { gray: 0.35 });
    y -= 11;
  }
  y = Math.min(y, PAGE_H - 96) - 8;
  c.hline(y);
  y -= 22;

  // Meta block — billed-to left; dates/status right.
  c.text(MARGIN, y, 'BILLED TO', 8, { bold: true, gray: 0.45 });
  const metaTop = y;
  y -= 13;
  for (const line of model.billedTo) {
    c.text(MARGIN, y, fitText(line, 10, 280), 10);
    y -= 13;
  }
  let my = metaTop;
  const meta: Array<[string, string]> = [
    ['Status', model.status],
    ['Issued', model.issuedDate || '—'],
  ];
  if (model.paidDate) meta.push(['Paid', model.paidDate]);
  if (model.periodLabel) meta.push(['Period', model.periodLabel]);
  for (const [label, value] of meta) {
    c.textRight(right - 110, my, label.toUpperCase(), 8, { bold: true, gray: 0.45 });
    c.textRight(right, my, value, 9);
    my -= 13;
  }
  y = Math.min(y, my) - 14;

  // Line-item table.
  c.text(MARGIN, y, 'DESCRIPTION', 8, { bold: true, gray: 0.45 });
  c.textRight(right - 110, y, 'QTY', 8, { bold: true, gray: 0.45 });
  c.textRight(right, y, 'AMOUNT', 8, { bold: true, gray: 0.45 });
  y -= 6;
  c.hline(y);
  y -= 16;
  for (const line of model.lines) {
    c.text(MARGIN, y, fitText(line.description, 9.5, 330), 9.5);
    c.textRight(right - 110, y, line.quantity, 9.5);
    c.textRight(right, y, line.amount, 9.5);
    y -= 15;
  }
  if (model.truncatedLineCount > 0) {
    c.text(MARGIN, y, `... and ${model.truncatedLineCount} more line(s) — see the hosted invoice for full detail`, 8.5, { gray: 0.4 });
    y -= 15;
  }
  y -= 2;
  c.hline(y);
  y -= 20;

  // Totals — right-aligned block.
  const totals: Array<[string, string, boolean]> = [['Subtotal', model.subtotal, false]];
  if (model.tax) totals.push(['Tax', model.tax, false]);
  totals.push(['Total', model.total, true]);
  totals.push(['Amount paid', model.amountPaid, false]);
  totals.push(['Amount due', model.amountDue, true]);
  for (const [label, value, bold] of totals) {
    c.textRight(right - 110, y, label, bold ? 10 : 9, { bold, gray: bold ? 0 : 0.3 });
    c.textRight(right, y, value, bold ? 10 : 9, { bold });
    y -= 15;
  }

  // Footer — pinned to the bottom, independent of body height.
  c.hline(78, 0.85);
  c.text(MARGIN, 64, model.footer, 8.5, { gray: 0.35 });
  c.text(MARGIN, 52, `Generated by ${model.brandName} billing - reference ${model.reference}`, 7.5, { gray: 0.55 });

  return assemblePdf(c.render());
}

/** Wrap a content stream in the fixed 6-object document skeleton. */
function assemblePdf(content: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
