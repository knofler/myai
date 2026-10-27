/**
 * Who a schedule runs as — v1 gate G5 re-check (N-1).
 *
 * A schedule used to fire as the `system` principal for every tenant, and
 * `system` skips both tool visibility and capability checks, so a tenant could
 * schedule an operator-only tool (memory_reindex, state_read, agents_invoke…).
 * Now the operator's own schedules (default tenant) keep the system context,
 * and every other tenant's schedules run as that tenant's owner, not local,
 * with the tenant's own tool allow/deny lists.
 */
import { DEFAULT_TENANT_ID, TenantModel, isConnected } from '../shared/db.js';
import { SYSTEM_CONTEXT, type ToolContext } from '../core/tenant-context.js';
import { isToolVisibleForTenant } from '../core/rbac.js';
import type { ScheduleKind } from '../shared/db.js';

/** The MCP tool a schedule dispatches. */
export function scheduleToolName(kind: ScheduleKind | string, target: string): string {
  if (kind === 'agent') return 'agents_invoke';
  if (kind === 'skill') return 'skills_invoke';
  return target;
}

/** The context a due schedule of `tenantId` executes under. */
export async function scheduleRunContext(tenantId: string): Promise<ToolContext> {
  if (tenantId === DEFAULT_TENANT_ID) return { ...SYSTEM_CONTEXT, tenantId };
  let tenant: Record<string, unknown> | null = null;
  try {
    if (isConnected()) tenant = await TenantModel.findOne({ tenantId }).lean() as Record<string, unknown> | null;
  } catch {
    tenant = null; // no record → the plain tenant context (stricter, never system)
  }
  return {
    tenantId,
    local: false,
    role: 'owner',
    ...(tenant?.plan ? { plan: tenant.plan as ToolContext['plan'] } : {}),
    ...(tenant?.region ? { region: tenant.region as ToolContext['region'] } : {}),
    ...(tenant?.isolationTier ? { isolationTier: tenant.isolationTier as ToolContext['isolationTier'] } : {}),
    ...(Array.isArray(tenant?.mcpToolAllowlist) ? { mcpToolAllowlist: tenant.mcpToolAllowlist as string[] } : {}),
    ...(Array.isArray(tenant?.mcpToolDenylist) ? { mcpToolDenylist: tenant.mcpToolDenylist as string[] } : {}),
  };
}

/** True when `ctx` may run the tool a schedule of this kind/target dispatches. */
export function scheduleTargetAllowed(ctx: ToolContext | undefined, kind: ScheduleKind | string, target: string): boolean {
  return isToolVisibleForTenant(ctx, scheduleToolName(kind, target));
}

/**
 * 'suspended' / 'deleted' when a non-default tenant may not run anything
 * (G5 NF-3: API keys are blocked on suspension; its schedules must stop too).
 */
export async function scheduleTenantInactive(tenantId: string): Promise<string | null> {
  if (tenantId === DEFAULT_TENANT_ID || !isConnected()) return null;
  try {
    const t = await TenantModel.findOne({ tenantId }).lean() as { status?: string } | null;
    return t?.status === 'suspended' || t?.status === 'deleted' ? t.status : null;
  } catch {
    return null;
  }
}
