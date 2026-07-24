// /api/connectors — per-tenant MCP connector manager (betaC connector bundle).
//
// A fresh betaC install should have working connectors day one. This route:
//   • GET  — lists the active tenant's connectors, auto-seeding the curated
//            bundle on first read so the manager is never empty.
//   • POST — mutates a connector: {action: 'seed' | 'set' | 'toggle' | 'remove'}.
//
// TENANCY: like the New App flow, writes go straight to the dashboard's Mongo
// connection scoped to the active tenant — NOT through the gateway bridge token
// (which resolves to the default tenant and would mis-scope a real tenant).
import { NextResponse } from 'next/server';
import { connectDB, Connector } from '@/lib/db';
import { getActiveTenant } from '@/lib/tenant';
import { BUNDLED_CONNECTORS, BUNDLED_BY_KEY } from '@/lib/connector-bundle';
import type { ConnectorTransport } from '@/lib/connector-bundle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Seed the curated bundle for a tenant. Idempotent — bundled catalog fields are
 * refreshed but an existing connector's `enabled` toggle is preserved.
 */
async function seedDefaults(tenantId: string): Promise<{ seeded: number; existing: number }> {
  const presentDocs = (await Connector.find({ tenantId }).select('key').lean()) as Array<{ key?: string }>;
  const present = new Set(presentDocs.map((c) => c.key));
  let seeded = 0;
  let existing = 0;
  const now = new Date();
  for (const def of BUNDLED_CONNECTORS) {
    await Connector.updateOne(
      { tenantId, key: def.key },
      {
        $set: {
          label: def.label,
          category: def.category,
          transport: def.transport,
          description: def.description,
          url: def.url,
          command: def.command,
          args: def.args,
          env: def.env,
          requiresEnv: def.requiresEnv,
          source: 'bundled',
          updatedAt: now,
        },
        $setOnInsert: { tenantId, key: def.key, enabled: def.defaultEnabled, createdAt: now },
      },
      { upsert: true },
    );
    if (present.has(def.key)) existing++;
    else seeded++;
  }
  return { seeded, existing };
}

export async function GET() {
  const tenantId = await getActiveTenant();
  try {
    await connectDB();
    let docs = await Connector.find({ tenantId }).sort({ category: 1, key: 1 }).lean();
    if (docs.length === 0) {
      await seedDefaults(tenantId);
      docs = await Connector.find({ tenantId }).sort({ category: 1, key: 1 }).lean();
    }
    return NextResponse.json({ ok: true, connectors: JSON.parse(JSON.stringify(docs)) });
  } catch (err) {
    console.error('[api/connectors] GET failed:', err);
    return NextResponse.json({ error: 'could not load connectors' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const action = typeof body.action === 'string' ? body.action : '';
  const tenantId = await getActiveTenant();

  try {
    await connectDB();
    const now = new Date();

    if (action === 'seed') {
      const result = await seedDefaults(tenantId);
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === 'toggle') {
      const key = typeof body.key === 'string' ? body.key : '';
      if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 });
      if (typeof body.enabled !== 'boolean') return NextResponse.json({ error: 'enabled (boolean) is required' }, { status: 400 });
      const res = await Connector.updateOne({ tenantId, key }, { $set: { enabled: body.enabled, updatedAt: now } });
      if (res.matchedCount === 0) return NextResponse.json({ error: 'connector not found' }, { status: 404 });
      return NextResponse.json({ ok: true });
    }

    if (action === 'remove') {
      const key = typeof body.key === 'string' ? body.key : '';
      if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 });
      // Bundled connectors are disabled, not deleted (a re-seed would resurrect them).
      if (BUNDLED_BY_KEY[key]) {
        await Connector.updateOne({ tenantId, key }, { $set: { enabled: false, updatedAt: now } });
        return NextResponse.json({ ok: true, disabled: true });
      }
      const res = await Connector.deleteOne({ tenantId, key });
      return NextResponse.json({ ok: true, removed: res.deletedCount > 0 });
    }

    if (action === 'set') {
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 });
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(key)) {
        return NextResponse.json({ error: 'key must be a slug (letters, numbers, - or _)' }, { status: 400 });
      }
      const transport = (body.transport as ConnectorTransport) || 'http';
      if (transport !== 'http' && transport !== 'stdio') {
        return NextResponse.json({ error: 'transport must be http or stdio' }, { status: 400 });
      }
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      const command = typeof body.command === 'string' ? body.command.trim() : '';
      if (transport === 'http' && !url) return NextResponse.json({ error: 'url is required for an http connector' }, { status: 400 });
      if (transport === 'stdio' && !command) return NextResponse.json({ error: 'command is required for a stdio connector' }, { status: 400 });

      const args = typeof body.args === 'string'
        ? body.args.split(/\s+/).filter(Boolean)
        : Array.isArray(body.args) ? (body.args as string[]) : undefined;

      const set: Record<string, unknown> = {
        label: (typeof body.label === 'string' && body.label.trim()) || key,
        category: (typeof body.category === 'string' && body.category) || 'custom',
        transport,
        description: typeof body.description === 'string' ? body.description.trim() : undefined,
        url: transport === 'http' ? url : undefined,
        command: transport === 'stdio' ? command : undefined,
        args: transport === 'stdio' ? args : undefined,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
        updatedAt: now,
      };

      await Connector.updateOne(
        { tenantId, key },
        { $set: set, $setOnInsert: { tenantId, key, source: 'custom', createdAt: now } },
        { upsert: true },
      );
      return NextResponse.json({ ok: true, key });
    }

    return NextResponse.json({ error: `unknown action "${action}"` }, { status: 400 });
  } catch (err) {
    console.error('[api/connectors] POST failed:', err);
    return NextResponse.json({ error: 'connector operation failed' }, { status: 500 });
  }
}
