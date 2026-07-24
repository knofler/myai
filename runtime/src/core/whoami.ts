/**
 * `GET /api/auth/whoami` — end-user session identity for `myai whoami` (CLI).
 *
 * Distinct from `/api/auth/me` (JWT-cookie dashboard session) and the
 * tenant-key rotate/bootstrap routes (operator CRUD): this is the per-tenant
 * API-key-authenticated identity check the CLI uses after `myai login` to
 * show which org/tenant/plan/quota it is currently talking to. Auth is
 * resolved the SAME way as every other `/api/*` route (core/auth.ts
 * `authenticate()` middleware) — a present-but-invalid key already 401s
 * before this handler runs, so a successful response IS the login proof.
 */
import { TenantModel, TenantRequestQuotaModel, type ITenant, type TenantPlan } from '../shared/db.js';
import { planLimits } from './billing.js';
import { monthKey } from './tenant-quota.js';
import type { ToolContext } from './tenant-context.js';

export interface WhoamiResponse {
  tenantId: string;
  org: string | null;
  plan: TenantPlan;
  local: boolean;
  role: string | null;
  keyId: string | null;
  quota: {
    period: string;
    monthlyRequests: { used: number; limit: number };
    requestsPerMin: number;
  };
}

/** Pure — exported for tests. Assembles the response from already-fetched data. */
export function buildWhoamiResponse(
  ctx: ToolContext,
  tenant: Pick<ITenant, 'name' | 'plan'> | null,
  usedThisMonth: number,
  period: string,
): WhoamiResponse {
  const plan = ctx.plan ?? tenant?.plan ?? 'free';
  const limits = planLimits(plan);
  return {
    tenantId: ctx.tenantId,
    org: tenant?.name ?? null,
    plan,
    local: !!ctx.local,
    role: ctx.role ?? null,
    keyId: ctx.keyId ?? null,
    quota: {
      period,
      monthlyRequests: { used: usedThisMonth, limit: limits.monthlyRequests },
      requestsPerMin: limits.requestsPerMin,
    },
  };
}

export async function getWhoami(ctx: ToolContext): Promise<WhoamiResponse> {
  const period = monthKey(new Date());
  const [tenant, quotaDoc] = await Promise.all([
    TenantModel.findOne({ tenantId: ctx.tenantId })
      .select('name plan')
      .lean<Pick<ITenant, 'name' | 'plan'>>()
      .exec(),
    TenantRequestQuotaModel.findOne({ tenantId: ctx.tenantId, period }).lean<{ count: number }>().exec(),
  ]);
  return buildWhoamiResponse(ctx, tenant, quotaDoc?.count ?? 0, period);
}
