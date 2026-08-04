/**
 * Admin surface for the per-org MCP tool visibility override (Wave-2 #15
 * follow-up — task-01af5b05). `core/rbac.ts` added `OPERATOR_ONLY_TOOLS` +
 * `ITenant.mcpToolAllowlist`/`mcpToolDenylist` (d67f3f9) but shipped
 * DB-write-only: no REST route or dashboard panel read/wrote those two
 * fields, so the only way to grant (or further restrict) a tenant's
 * operator-tool exception was a raw Mongo write.
 *
 * Operator-only, cross-tenant — same posture as `tenant-bulk-import.ts` /
 * the gift-codes mint routes: no self-serve equivalent, a tenant can never
 * grant itself an operator-tool exception.
 */
import { TenantModel, type ITenant } from '../shared/db.js';
import { AuthError } from './tenant-context.js';
import { OPERATOR_ONLY_TOOLS } from './rbac.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'tenant-mcp-tools' });

export interface TenantMcpToolsView {
  tenantId: string;
  mcpToolAllowlist: string[];
  mcpToolDenylist: string[];
  operatorOnlyTools: string[];
}

function toView(tenant: Pick<ITenant, 'tenantId' | 'mcpToolAllowlist' | 'mcpToolDenylist'>): TenantMcpToolsView {
  return {
    tenantId: tenant.tenantId,
    mcpToolAllowlist: tenant.mcpToolAllowlist ?? [],
    mcpToolDenylist: tenant.mcpToolDenylist ?? [],
    operatorOnlyTools: Array.from(OPERATOR_ONLY_TOOLS),
  };
}

/** Read a tenant's current allow/deny override, alongside the known
 *  `OPERATOR_ONLY_TOOLS` set the dashboard panel renders checkboxes against. */
export async function getTenantMcpTools(tenantId: string): Promise<TenantMcpToolsView> {
  const tenant = await TenantModel.findOne({ tenantId })
    .select('tenantId mcpToolAllowlist mcpToolDenylist')
    .lean<Pick<ITenant, 'tenantId' | 'mcpToolAllowlist' | 'mcpToolDenylist'>>();
  if (!tenant) throw new AuthError('tenant not found', 404, 'NOT_FOUND');
  return toView(tenant);
}

/** Validate that `value` is an array of non-empty strings, or undefined. */
function validateToolList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim().length > 0)) {
    throw new AuthError(`${field} must be an array of non-empty tool-name strings`, 400, 'BAD_REQUEST');
  }
  return value;
}

/**
 * Set (replace) a tenant's allowlist and/or denylist. Either field may be
 * omitted to leave it untouched; an empty array clears the override back to
 * the `OPERATOR_ONLY_TOOLS` default (mirrors the schema's `default:
 * undefined` — an empty array is stored as "unset", not `[]`, so
 * `mcpToolAllowlist?.includes(...)` in rbac.ts sees it as absent).
 */
export async function setTenantMcpTools(
  tenantId: string,
  input: { mcpToolAllowlist?: unknown; mcpToolDenylist?: unknown },
): Promise<TenantMcpToolsView> {
  const allowlist = validateToolList(input.mcpToolAllowlist, 'mcpToolAllowlist');
  const denylist = validateToolList(input.mcpToolDenylist, 'mcpToolDenylist');
  if (allowlist === undefined && denylist === undefined) {
    throw new AuthError('mcpToolAllowlist and/or mcpToolDenylist required', 400, 'BAD_REQUEST');
  }

  const set: Record<string, string[]> = {};
  const unset: Record<string, ''> = {};
  if (allowlist !== undefined) {
    if (allowlist.length) set.mcpToolAllowlist = allowlist;
    else unset.mcpToolAllowlist = '';
  }
  if (denylist !== undefined) {
    if (denylist.length) set.mcpToolDenylist = denylist;
    else unset.mcpToolDenylist = '';
  }

  const update: Record<string, unknown> = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;

  const tenant = await TenantModel.findOneAndUpdate({ tenantId }, update, { new: true })
    .select('tenantId mcpToolAllowlist mcpToolDenylist')
    .lean<Pick<ITenant, 'tenantId' | 'mcpToolAllowlist' | 'mcpToolDenylist'>>();
  if (!tenant) throw new AuthError('tenant not found', 404, 'NOT_FOUND');

  log.info(
    { tenantId, mcpToolAllowlist: tenant.mcpToolAllowlist, mcpToolDenylist: tenant.mcpToolDenylist },
    'tenant mcp-tools override updated',
  );
  return toView(tenant);
}
