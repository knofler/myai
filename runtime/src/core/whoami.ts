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
import { TenantModel, TenantRequestQuotaModel, type ITenant, type TenantPlan, type TenantRegion } from '../shared/db.js';
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
  /**
   * Data-residency region this tenant is pinned to (ADR-024) — the tag
   * `core/region-guard.ts` enforces against the serving gateway's
   * `GATEWAY_REGION`. `null` only for the local/loopback context (the local
   * operator has no pinned region); a real tenant defaults to 'us'.
   */
  region: TenantRegion | null;
  quota: {
    period: string;
    monthlyRequests: { used: number; limit: number };
    requestsPerMin: number;
  };
}

/** Pure — exported for tests. Assembles the response from already-fetched data. */
export function buildWhoamiResponse(
  ctx: ToolContext,
  tenant: Pick<ITenant, 'name' | 'plan'> & Partial<Pick<ITenant, 'region'>> | null,
  usedThisMonth: number,
  period: string,
): WhoamiResponse {
  const plan = ctx.plan ?? tenant?.plan ?? 'free';
  const limits = planLimits(plan);
  // Local/loopback has no pinned region (region-guard never gates it); a real
  // resolved tenant falls back to 'us', the schema default (migration 003).
  const region: TenantRegion | null = ctx.local ? (ctx.region ?? tenant?.region ?? null) : (ctx.region ?? tenant?.region ?? 'us');
  return {
    tenantId: ctx.tenantId,
    org: tenant?.name ?? null,
    plan,
    local: !!ctx.local,
    role: ctx.role ?? null,
    keyId: ctx.keyId ?? null,
    region,
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
      .select('name plan region')
      .lean<Pick<ITenant, 'name' | 'plan' | 'region'>>()
      .exec(),
    TenantRequestQuotaModel.findOne({ tenantId: ctx.tenantId, period }).lean<{ count: number }>().exec(),
  ]);
  return buildWhoamiResponse(ctx, tenant, quotaDoc?.count ?? 0, period);
}
