// POST /api/auth/connect — SECONDARY auth: validate a per-tenant API key
// (the "connect a tool / CLI" path; ADR-010 §3.2). Was /api/auth/login until
// the M2 graft made email+password the primary login. Mirrors the gateway's
// `resolveTenantByKey`: indexed prefix lookup → constant-time hash compare →
// active check. Returns the tenant identity (never the hash). The raw key stays
// client-side; this only confirms it.
import { NextResponse } from 'next/server';
import { connectDB, Tenant } from '@/lib/db';
import { sha256Hex, timingSafeEqualHex, KEY_PREFIX_LEN, KEY_RE } from '@/lib/tenant-keys';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TenantRow {
  tenantId: string;
  name: string;
  plan: string;
  status: string;
  apiKeyHash: string;
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!KEY_RE.test(apiKey)) {
    return NextResponse.json({ error: 'invalid key format' }, { status: 400 });
  }

  try {
    await connectDB();
    const prefix = apiKey.slice(0, KEY_PREFIX_LEN);
    const tenant = await Tenant.findOne({ apiKeyPrefix: prefix })
      .select('+apiKeyHash')
      .lean<TenantRow | null>()
      .exec();

    const candidateHash = sha256Hex(apiKey);
    // Flat 401 on unknown key / bad hash — never reveal which failed.
    if (!tenant) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    if (tenant.status !== 'active') {
      return NextResponse.json({ error: 'tenant not active' }, { status: 403 });
    }
    if (!timingSafeEqualHex(candidateHash, tenant.apiKeyHash)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    return NextResponse.json({
      tenant: { tenantId: tenant.tenantId, name: tenant.name, plan: tenant.plan },
    });
  } catch (err) {
    console.error('[auth/connect] failed:', err);
    return NextResponse.json({ error: 'connect failed' }, { status: 500 });
  }
}
