// /system → MCP Tools tab (admin-only) — view/edit a tenant's per-org MCP
// tool visibility override (core/rbac.ts OPERATOR_ONLY_TOOLS override,
// ITenant.mcpToolAllowlist/mcpToolDenylist, d67f3f9). Before this panel, the
// only way to grant a trusted tenant an operator-tool exception was a raw
// Mongo write — see runtime/src/core/tenant-mcp-tools.ts.
//
// The tenant picker is a plain Mongo read (read-only mirror, like the other
// /system tabs); the actual view/edit of the override goes through
// /api/tenants/[id]/mcp-tools, which proxies to the gateway's admin-gated
// REST route — this view never writes to Mongo directly.

import { connectDB, Tenant } from '@/lib/db';
import TenantMcpToolsPanel from '@/components/tenant-mcp-tools-panel';

export const dynamic = 'force-dynamic';

export default async function McpToolsView() {
  let tenants: Array<{ tenantId: string; name?: string; plan?: string }> = [];
  let dbError = false;

  try {
    await connectDB();
    tenants = await Tenant.find({})
      .select('tenantId name plan -_id')
      .sort({ tenantId: 1 })
      .limit(500)
      .lean<Array<{ tenantId: string; name?: string; plan?: string }>>();
  } catch (err) {
    console.error('[mcp-tools view] tenant list load failed:', err);
    dbError = true;
  }

  return (
    <div className="max-w-4xl">
      {dbError && (
        <div className="mb-4 bg-amber-950/30 border border-amber-800/50 rounded-lg p-3 text-xs text-amber-300">
          Could not reach the database — tenant list unavailable.
        </div>
      )}
      <p className="mb-5 text-sm text-zinc-500">
        Grant a trusted tenant an exception to an operator-only MCP tool, or additionally restrict a
        tenant&apos;s own tool surface. Operator-only — requires <code className="bg-zinc-800 px-1 rounded">ADMIN_API_TOKEN</code> configured
        on both the dashboard and the gateway.
      </p>
      <TenantMcpToolsPanel tenants={tenants} />
    </div>
  );
}
