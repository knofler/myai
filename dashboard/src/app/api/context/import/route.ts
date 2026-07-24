// POST /api/context/import — UPLOAD a portable context bundle and import its
// vectors into this tenant's RAG corpus (CONTEXT-PORT 3, the upload half).
//
// Accepts either a raw JSON bundle body or a multipart file upload of the same
// shape (as emitted by GET /api/context/export, `myai context export`, or the
// external-source importer CONTEXT-PORT 2). The bundle is validated locally
// (kind + formatVersion + shape — see lib/context.validateImportBundle) BEFORE
// anything is forwarded, then the vector entries are handed to the gateway's
// `POST /api/vectors/import` endpoint, which re-embeds/upserts them under the
// tenant resolved from the bridge token.
//
// NOTE: the gateway /api/vectors/import endpoint shipped in CONTEXT-PORT 1 but
// needs a MASTER-checkout gateway rebuild to be live (deploy guard — never
// rebuilt from a workspace clone). Until then this route validates + forwards
// and reports the gateway's response verbatim, degrading to a clear message if
// the endpoint isn't reachable.
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { GATEWAY_HTTP_URL, gatewayHeaders } from '@/lib/gateway';
import { validateImportBundle } from '@/lib/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function readBundle(req: NextRequest): Promise<unknown> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('bundle');
    if (file && typeof file !== 'string') {
      return JSON.parse(await (file as File).text());
    }
    const raw = form.get('json');
    if (typeof raw === 'string') return JSON.parse(raw);
    throw new Error('no bundle file or json field in form data');
  }
  return req.json();
}

export async function POST(req: NextRequest) {
  let parsed: unknown;
  try {
    parsed = await readBundle(req);
  } catch (err) {
    return NextResponse.json(
      { error: `could not parse bundle: ${err instanceof Error ? err.message : 'invalid JSON'}` },
      { status: 400 },
    );
  }

  const check = validateImportBundle(parsed);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  const bundle = parsed as { vectors: unknown[] };
  if (check.vectorCount === 0) {
    return NextResponse.json({
      ok: true,
      imported: 0,
      message: 'Bundle valid but contained no vectors to import.',
      sessions: check.sessionCount,
    });
  }

  // Forward the vector entries to the gateway importer. The gateway re-embeds
  // when dimensions are absent/mismatched and dedups by content hash.
  try {
    const res = await fetch(`${GATEWAY_HTTP_URL}/api/vectors/import`, {
      method: 'POST',
      headers: gatewayHeaders(),
      body: JSON.stringify({
        kind: 'myai-vector-corpus',
        formatVersion: 1,
        entries: bundle.vectors,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 404) {
        return NextResponse.json(
          {
            error:
              'The gateway /api/vectors/import endpoint is not live yet — it needs a gateway rebuild from the master checkout (deploy guard). Bundle validated OK.',
            validated: check.vectorCount,
          },
          { status: 503 },
        );
      }
      return NextResponse.json({ error: `gateway import failed (${res.status}): ${text.slice(0, 300)}` }, { status: 502 });
    }

    const result = await res.json().catch(() => ({}));
    return NextResponse.json({ ok: true, validated: check.vectorCount, gateway: result });
  } catch (err) {
    return NextResponse.json(
      {
        error: `could not reach the gateway importer: ${err instanceof Error ? err.message : 'fetch failed'}`,
        validated: check.vectorCount,
      },
      { status: 502 },
    );
  }
}
