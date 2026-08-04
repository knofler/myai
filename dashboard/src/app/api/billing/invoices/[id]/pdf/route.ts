// GET /api/billing/invoices/{id}/pdf — the downloadable, branded invoice PDF
// a customer's finance team can file (Stripe's portal only offers Stripe's own
// document). Fetches the invoice from Stripe, verifies it belongs to THIS
// tenant's Stripe customer (the id alone is attacker-suppliable — never serve
// another tenant's invoice), renders it with the built-in dependency-free PDF
// writer, and streams it back as an attachment.
//
// Auth: per-tenant API key via Authorization/X-Api-Key header, or — because a
// plain browser download link can't set headers — a `?key=` query param. The
// key in a URL can land in logs, so the UI should prefer header + blob
// downloads; the query param exists for copy-paste convenience only.
import { NextResponse } from 'next/server';
import { authenticateTenant, keyFromRequest } from '@/lib/tenant-auth';
import {
  isInvoiceFetchConfigured,
  isValidInvoiceId,
  getInvoice,
  invoiceBelongsToCustomer,
  buildInvoicePdfModel,
  renderInvoicePdf,
  invoicePdfFilename,
} from '@/lib/invoice-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const url = new URL(req.url);
  const apiKey = keyFromRequest(req) || url.searchParams.get('key')?.trim() || '';
  const auth = await authenticateTenant(apiKey);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (!isInvoiceFetchConfigured()) {
    return NextResponse.json({ error: 'billing not configured' }, { status: 503 });
  }
  if (!isValidInvoiceId(id)) {
    return NextResponse.json({ error: 'invalid invoice id' }, { status: 400 });
  }
  if (!auth.tenant.stripeCustomerId) {
    return NextResponse.json({ error: 'no invoices for this tenant' }, { status: 404 });
  }

  try {
    const invoice = await getInvoice(id);
    // Tenant isolation — 404 (not 403) so foreign ids don't confirm existence.
    if (!invoiceBelongsToCustomer(invoice, auth.tenant.stripeCustomerId)) {
      return NextResponse.json({ error: 'invoice not found' }, { status: 404 });
    }

    const model = buildInvoicePdfModel(invoice);
    const pdf = renderInvoicePdf(model);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdf.length),
        'Content-Disposition': `attachment; filename="${invoicePdfFilename(model)}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    // Stripe 404s (unknown/deleted invoice) surface as thrown errors here.
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such invoice/i.test(msg)) {
      return NextResponse.json({ error: 'invoice not found' }, { status: 404 });
    }
    console.error('[billing/invoices/pdf] failed:', err);
    return NextResponse.json({ error: 'could not generate invoice PDF' }, { status: 502 });
  }
}
