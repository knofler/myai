// GET /api/billing/invoices — the tenant's invoice history with branded-PDF
// download links (beyond Stripe's own portal invoice list). Authenticates the
// tenant by its per-tenant API key and lists the Stripe invoices on its
// customer, newest first. Each entry carries `pdfPath` → our branded PDF
// (/api/billing/invoices/{id}/pdf) plus Stripe's `hostedUrl` as a fallback.
// A tenant that has never checked out simply gets an empty list (200, not an
// error — "no invoices yet" is a normal state the UI renders).
import { NextResponse } from 'next/server';
import { authenticateTenant, keyFromRequest } from '@/lib/tenant-auth';
import { isInvoiceFetchConfigured, listInvoices, invoiceSummary } from '@/lib/invoice-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = await authenticateTenant(keyFromRequest(req));
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (!isInvoiceFetchConfigured()) {
    return NextResponse.json({ error: 'billing not configured' }, { status: 503 });
  }
  if (!auth.tenant.stripeCustomerId) {
    return NextResponse.json({ invoices: [] });
  }

  try {
    const invoices = await listInvoices(auth.tenant.stripeCustomerId);
    return NextResponse.json({ invoices: invoices.map(invoiceSummary) });
  } catch (err) {
    console.error('[billing/invoices] list failed:', err);
    return NextResponse.json({ error: 'could not list invoices' }, { status: 502 });
  }
}
