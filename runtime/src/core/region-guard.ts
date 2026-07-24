/**
 * Data-residency / region pinning enforcement (ADR-023).
 *
 * A tenant pins its records + off-hours runner work to a region (`us`/`eu`/
 * `au`, `Tenant.region`). In production, each region is served by its own
 * physical gateway deployment (its own Mongo + its own runner fleet) —
 * `GATEWAY_REGION` declares which one a given process is. This guard is the
 * single enforcement chokepoint: mounted right after `authenticate()` +
 * `tenantQuota()` on REST and MCP (mirrors tenant-quota.ts's placement), and
 * checked inline at the WS upgrade, it rejects any resolved (non-local) tenant
 * whose `region` doesn't match the serving gateway's `GATEWAY_REGION` — before
 * a single scoped-store read/write or task claim happens. That single check
 * covers both halves of the task: a mismatched tenant can neither have its
 * data read/written NOR have its runner tasks claimed by the wrong-region
 * gateway, since every one of those operations is gated behind this same
 * chokepoint.
 *
 * INERT by default: `region.gatewayRegion` is unset (single-region / local
 * dev) or `region.enforce` is false → never rejects, byte-identical to
 * pre-ADR-023 behaviour. Local/loopback callers (`ctx.local`) are never
 * gated — the local operator has no pinned region to violate.
 */
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'node:http';
import type { RegionConfig } from '../shared/types.js';
import type { ToolContext } from './tenant-context.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'region-guard' });

/**
 * Pure verdict, exported for tests. True when this request must be rejected:
 * enforcement is on, the gateway has a configured region, the caller is a
 * real (non-local) resolved tenant, and its pinned region differs.
 *
 * `region` defensively defaults when missing/partial (mirrors auth.ts's
 * `tenancyConfig()` fallback) — a test harness or partial config mock that
 * omits the `region` section entirely must never 500, only stay inert.
 */
export function regionMismatch(ctx: ToolContext | undefined, region: RegionConfig | undefined): boolean {
  const r = region ?? { enforce: false, gatewayRegion: undefined };
  if (!r.enforce || !r.gatewayRegion) return false;
  if (!ctx || ctx.local) return false;
  if (!ctx.region) return false; // no pinned region on record — nothing to violate
  return ctx.region !== r.gatewayRegion;
}

export interface RegionMismatchBody {
  error: string;
  code: 'REGION_MISMATCH';
  tenantRegion: string;
  gatewayRegion: string;
}

export function regionMismatchBody(ctx: ToolContext, gatewayRegion: string): RegionMismatchBody {
  return {
    error: `tenant is pinned to region '${ctx.region}' — this gateway serves '${gatewayRegion}'. Use the '${ctx.region}' regional endpoint.`,
    code: 'REGION_MISMATCH',
    tenantRegion: String(ctx.region),
    gatewayRegion,
  };
}

/**
 * Express middleware factory — REST + MCP (both mount this the same way they
 * mount `tenantQuota()`: after `authenticate()`, before routes).
 */
export function regionGuard(getConfigRegion: () => RegionConfig | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const region = getConfigRegion();
    const ctx = req.tenant;
    if (regionMismatch(ctx, region)) {
      log.warn(
        { tenantId: ctx?.tenantId, tenantRegion: ctx?.region, gatewayRegion: region?.gatewayRegion, path: req.path },
        'region mismatch — request rejected',
      );
      res.status(403).json(regionMismatchBody(ctx as ToolContext, (region as RegionConfig).gatewayRegion as string));
      return;
    }
    next();
  };
}

/**
 * WS upgrade check — call after `authenticateWs` resolves a context, before
 * `setupClient`. Returns true if the connection was rejected (caller should
 * stop; the socket is already closed with 4403).
 */
export function rejectWsOnRegionMismatch(
  ws: { close: (code: number, reason?: string) => void },
  req: IncomingMessage,
  ctx: ToolContext,
  region: RegionConfig | undefined,
): boolean {
  if (!regionMismatch(ctx, region)) return false;
  log.warn(
    { tenantId: ctx.tenantId, tenantRegion: ctx.region, gatewayRegion: region?.gatewayRegion, clientIp: req.socket?.remoteAddress },
    'WebSocket region mismatch — connection rejected',
  );
  try {
    ws.close(4403, 'region_mismatch');
  } catch {
    /* already closed */
  }
  return true;
}
