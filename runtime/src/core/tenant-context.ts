/**
 * Tenant request-context primitives (ADR-010 §1.2, §3.4).
 *
 * `ToolContext` is the server-derived identity threaded into every tool call.
 * It is ALWAYS resolved from an authenticated credential or the local-trust
 * path — NEVER from a caller-supplied argument (that would be an injection
 * vector). `executeTool` strips any inbound `tenantId` from tool args so only
 * this context is trusted.
 */
// Type-only import — erased at compile, so this module has NO runtime dependency
// on db.js (keeps it safe to import from test files that mock db.js).
import type { TenantIsolationTier, TenantPlan, TenantRegion } from '../shared/db.js';

// Mirror db.ts's DEFAULT_TENANT_ID: both read the same env var so they cannot
// diverge, without coupling this lightweight module to the heavy db module.
const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || 'default';

/**
 * RBAC v1 principal role (ADR-013 §2). The four human roles mirror
 * `db.ts` `UserRole`; `system`/`operator` are machine/operator principals with
 * no parallel permission system — they map onto the same capability axis.
 * Server-derived only — NEVER read from caller-supplied args.
 */
export type CtxRole = 'viewer' | 'member' | 'admin' | 'owner' | 'system' | 'operator';

/**
 * Per-invocation resource ceiling for a sandboxed marketplace-package call
 * (ADR-027 §3) — mirrors `marketplace/publish.ts`'s
 * `PublishManifest.capabilities.resourceLimits` shape (the same numbers a
 * reviewed manifest declares); duplicated here rather than imported to keep
 * this low-level module free of a `marketplace/*` import (would cycle back
 * through `core/rbac.ts`, which this file is imported by).
 */
export interface SandboxResourceLimits {
  maxWallClockMs: number;
  maxToolCalls: number;
  maxOutputBytes: number;
}

/**
 * Server-derived marker identifying `ctx` as belonging to a running
 * sandboxed marketplace-package invocation (ADR-027 §3) — set ONLY by the
 * invocation loader (`marketplace/sandbox-invoke.ts`), never from a caller
 * or tool arg, same posture as `role` below. `executeTool` checks this
 * FIRST, via `assertDeclaredCapability` (core/rbac.ts), before the ordinary
 * role/visibility gates.
 */
export interface SandboxContextMarker {
  listingId: string;
  version: string;
  installId: string;
  /** The manifest's declared tool set for this invocation (ADR-027 §2). A
   *  declared capability never WIDENS what the caller's real role already
   *  permits — §3's gate is intersective, not substitutive. */
  declaredTools: readonly string[];
  resourceLimits: SandboxResourceLimits;
  /** Mutable accumulator, the SAME object reference threaded through every
   *  chained `executeTool` call this invocation makes, so `maxToolCalls` is
   *  enforced across the whole invocation rather than reset per call. */
  toolCallState: { count: number };
}

export interface ToolContext {
  /** The tenant every scoped store call is filtered by. */
  tenantId: string;
  /** Plan tier (drives quotas/budgets in M2+). */
  plan?: TenantPlan;
  /**
   * Data-residency region this tenant is pinned to (ADR-023). Absent for the
   * local/loopback context (region-guard never gates local callers).
   */
  region?: TenantRegion;
  /**
   * Physical DB isolation tier (ADR-030). Absent/`'shared'` (the default for
   * every tenant until the Phase-3 tier is sold) routes through
   * `getConnectionForTenant` to today's single global connection — zero
   * behavior change. Only `'dedicated-db'`/`'dedicated-cluster'` diverge, and
   * only once a `TenantDbBinding` actually exists for that tenant.
   */
  isolationTier?: TenantIsolationTier;
  /** True when resolved via the loopback / GATEWAY_LOCAL_TOKEN local-trust path. */
  local?: boolean;
  /**
   * Which of THIS tenant's projects the caller works in — the `x-myai-repo`
   * header the stdio MCP bridge sends (its checkout's brain namespace). A
   * SELECTION hint for context_boot / the initialize auto-boot only; never used
   * for authorization or tenant scoping. Sanitized to [A-Za-z0-9._-]{1,100}.
   */
  callerRepo?: string;
  /**
   * RBAC v1 (ADR-013 §2) — server-derived, never from caller args.
   * Absent → treated as 'member' by the rbac layer (pre-RBAC caller).
   */
  role?: CtxRole;
  /** The human principal (User.userId) when the credential was a dashboard JWT. */
  userId?: string;
  /**
   * Scopes granted to the authenticating scoped API key (ADR-010 §3.6).
   * `['*']` (or absent) = full access — a tenant-doc key, local trust, or a
   * legacy key carries no scope restriction. Present only for scoped keys.
   */
  scopes?: string[];
  /** The scoped API key's id (TenantApiKey.keyId) when auth resolved via one. */
  keyId?: string;
  /**
   * Per-org MCP tool visibility override (ITenant.mcpToolAllowlist /
   * .mcpToolDenylist — server-derived from the tenant record, never from
   * caller args). Consumed by core/rbac.ts `isToolVisibleForTenant`.
   */
  mcpToolAllowlist?: string[];
  mcpToolDenylist?: string[];
  /**
   * Present only while dispatching inside a sandboxed marketplace-package
   * invocation (ADR-027 §3) — server-derived by the invocation loader,
   * NEVER settable via caller args (`stripTenantFromArgs`-style trust
   * boundary applies here too).
   */
  sandbox?: SandboxContextMarker;
}

/**
 * The context for non-request-bound, system-internal execution: the scheduler,
 * dispatch worker, morning/evening sweeps, channel registry, and self-dispatch.
 * These operate as the default tenant on the local box. It is an EXPLICIT,
 * auditable context — never a silent fallback — and is also the default 3rd
 * arg of `executeTool` so existing single-tenant callers behave unchanged.
 */
export const SYSTEM_CONTEXT: ToolContext = Object.freeze({
  tenantId: DEFAULT_TENANT_ID,
  plan: 'scale',
  local: true,
  // ADR-013 §2: internal execution acts as the `system` principal (superset of
  // owner). Never resolvable from a request.
  role: 'system',
});

/** Thrown by the auth/scope layer. Carries an HTTP status + stable code. */
export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  /** Seconds the caller should wait before retrying — set on 429 (rate-limit)
   *  and 423 (lockout) errors thrown deep in service code (e.g. TOTP verify,
   *  login lockout) so the route handler can echo a `Retry-After` header the
   *  same way the `authRateLimit` middleware does at the edge. */
  readonly retryAfter?: number;
  constructor(message: string, status = 401, code = 'UNAUTHORIZED', retryAfter?: number) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * Fail-closed scope extraction (ADR-010 §3.4 HIGH flag): a missing tenant in
 * context throws loudly so a forgotten/mis-wired call site errors instead of
 * silently running unscoped (which would be a cross-tenant leak). Day-2 scoped
 * stores call this to derive their mandatory `{ tenantId }` filter.
 */
export function getTenantScope(ctx: ToolContext | undefined): { tenantId: string } {
  if (!ctx?.tenantId) {
    throw new AuthError('no tenant in context', 500, 'NO_TENANT_CONTEXT');
  }
  return { tenantId: ctx.tenantId };
}

/**
 * Defense in depth (ADR-010 §1.2/§3.4): a caller must never set its own
 * `tenantId` via tool args/body. Strip it on entry so only the server-derived
 * `ctx` is trusted. Returns a shallow copy without `tenantId` (or the original
 * if absent).
 */
export function stripTenantFromArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (args && typeof args === 'object' && 'tenantId' in args) {
    const { tenantId: _dropped, ...rest } = args;
    return rest;
  }
  return args;
}
