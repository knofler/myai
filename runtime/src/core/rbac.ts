/**
 * RBAC v1 — the static four-role capability matrix + enforcement helpers
 * (ADR-013 §3). ONE file, ONE matrix, two adapters:
 *   - `assertCapability(ctx, cap)` — the gateway-tool chokepoint helper (slice 2
 *     wires it at the top of `executeTool`, once the tool→capability inventory
 *     is filled in).
 *   - `requireCapability(cap)` / `requireRole(minRole)` — express guards for the
 *     REST routes that don't funnel through `executeTool`, sitting alongside the
 *     existing `requireAdmin` guard in `server.ts`.
 *
 * The role on `ToolContext` is ALWAYS server-derived (JWT claim / tenant-key /
 * local-trust / SYSTEM_CONTEXT) — never read from caller args. See ADR-013 §2.
 *
 * Shadow mode (ADR-013 §6): with `RBAC_ENFORCE` off (the default), a would-be
 * denial is logged (`rbac.shadow`) but ALLOWED — a soak period on the live
 * fleet before flipping enforcement on. With it on, denials throw 403 and log
 * `rbac.denied` (the security-relevant signal).
 */
import type { Request, Response, NextFunction } from 'express';
import { type CtxRole, type ToolContext, AuthError } from './tenant-context.js';
import { getLogger } from '../shared/logger.js';
import { recordAuditEvent } from './audit-log.js';

/**
 * The fixed capability axis every role and tool maps onto (ADR-013 §3). No
 * per-resource ACLs — a capability is the unit of permission.
 */
export type Capability = 'read' | 'work' | 'configure' | 'billing' | 'members' | 'fleet-admin';

/** All capabilities, in ascending order of privilege (for docs/tests). */
export const CAPABILITIES: readonly Capability[] = [
  'read', 'work', 'configure', 'members', 'billing', 'fleet-admin',
];

/**
 * The role → capabilities matrix (ADR-013 §3). `system` mirrors `owner`
 * (internal execution); `operator` adds cross-tenant `fleet-admin`.
 */
export const ROLE_CAPS: Record<CtxRole, readonly Capability[]> = Object.freeze({
  viewer:   ['read'],
  member:   ['read', 'work'],
  admin:    ['read', 'work', 'configure', 'members'],
  owner:    ['read', 'work', 'configure', 'members', 'billing'],
  system:   ['read', 'work', 'configure', 'members', 'billing'],
  operator: ['read', 'work', 'configure', 'members', 'billing', 'fleet-admin'],
});

/**
 * A context with no `role` is a pre-RBAC caller — treated as `member`
 * (ADR-013 §2). This is deliberately NOT `viewer`: pre-RBAC callers already
 * do work, and shadow mode must not change their behavior.
 */
export const DEFAULT_ROLE: CtxRole = 'member';

/** Resolve the effective role from a context, defaulting absent → `member`. */
export function effectiveRole(ctx: Pick<ToolContext, 'role'> | undefined): CtxRole {
  return ctx?.role ?? DEFAULT_ROLE;
}

/** True if `role` is granted `cap` by the static matrix. */
export function roleHasCapability(role: CtxRole, cap: Capability): boolean {
  return ROLE_CAPS[role]?.includes(cap) ?? false;
}

/** True if the context's effective role is granted `cap`. */
export function ctxHasCapability(ctx: Pick<ToolContext, 'role'> | undefined, cap: Capability): boolean {
  return roleHasCapability(effectiveRole(ctx), cap);
}

/**
 * True if `role` has AT LEAST every capability of `minRole` — i.e. it dominates
 * `minRole` on the capability lattice. Used by `requireRole`; naturally lets
 * `system`/`operator` (owner supersets) pass any human-role gate.
 */
export function roleAtLeast(role: CtxRole, minRole: CtxRole): boolean {
  const have = ROLE_CAPS[role] ?? [];
  return (ROLE_CAPS[minRole] ?? []).every((c) => have.includes(c));
}

/** ADR-013 §6 rollout flag. Off (default) → shadow mode; on → hard 403s. */
export function rbacEnforceEnabled(): boolean {
  const v = process.env.RBAC_ENFORCE;
  return v === 'true' || v === '1';
}

/**
 * The gateway chokepoint helper. Throws `AuthError(403, 'FORBIDDEN')` when the
 * context's role lacks `cap` AND enforcement is on. In shadow mode it logs the
 * would-be denial and returns. `action` is an optional label for the audit line
 * (e.g. the tool/route name).
 */
export function assertCapability(
  ctx: ToolContext | undefined,
  cap: Capability,
  opts: { action?: string } = {},
): void {
  const role = effectiveRole(ctx);
  if (roleHasCapability(role, cap)) return;

  const enforced = rbacEnforceEnabled();
  getLogger().warn(
    {
      role,
      cap,
      action: opts.action,
      userId: ctx?.userId,
      tenantId: ctx?.tenantId,
      enforced,
    },
    enforced ? 'rbac.denied' : 'rbac.shadow',
  );

  if (enforced) {
    // Persist the denial to the hash-chained trail (ADR-013 §5) — the
    // repeated-permission-denial-burst detector (security-anomaly-alerter)
    // reads this, not the structured log above.
    if (ctx?.tenantId) {
      recordAuditEvent({
        tenantId: ctx.tenantId,
        actor: { userId: ctx?.userId, role, via: ctx?.local ? 'local' : ctx?.keyId ? 'api-key' : ctx?.userId ? 'jwt' : 'system' },
        action: 'rbac.denied',
        target: opts.action,
        detail: { cap },
      });
    }
    throw new AuthError(
      `role '${role}' lacks capability '${cap}'${opts.action ? ` for '${opts.action}'` : ''}`,
      403,
      'FORBIDDEN',
    );
  }
}

/** Read the resolved ToolContext off an express request (see auth.ts). */
function ctxOf(req: Request): ToolContext | undefined {
  return req.tenant;
}

/**
 * Express guard: require a capability on the resolved `req.tenant` role. Sits
 * alongside `requireAdmin` in `server.ts`. Honors shadow mode — with
 * `RBAC_ENFORCE` off it calls `next()` after logging (soak), on it 403s.
 */
export function requireCapability(cap: Capability) {
  return function guard(req: Request, res: Response, next: NextFunction): void {
    try {
      assertCapability(ctxOf(req), cap, { action: req.path });
      next();
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  };
}

// ── REST route enforcement matrix (ADR-013 §3/§4 — slice 2) ─────────────────
//
// The declarative source of truth mapping each RBAC-enforced gateway REST route
// to the single capability it requires. REST routes don't funnel through
// `executeTool`, so this matrix is the REST-side twin of the tool→capability
// inventory: one matrix, two adapters (ADR-013 §3). The contract test walks
// this table × every role and asserts the allow/deny grid, and the routes in
// `server.ts` reference the SAME capability constants so the wiring can't drift
// from the spec.
//
// `mode` distinguishes routes that already carried a HARD role gate before
// slice 2 (invites — stay hard, never shadow-weakened) from routes that had NO
// role gate (tasks/schedules — enter shadow-mode soak first, ADR-013 §6). A
// documented-only row (`enforce: false`) appears in the spec/OpenAPI but is
// protected by a separate mechanism (the budgets routes are operator-token
// gated via `requireAdmin`, not tenant role).

export type RestMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RestRouteRule {
  method: RestMethod;
  /** Express path, with `:param` segments (matched positionally). */
  path: string;
  capability: Capability;
  /** `hard` = pre-existing strict gate (no shadow); `shadow` = ADR-013 §6 soak. */
  mode: 'hard' | 'shadow';
  /** False → documented in the matrix but enforced by a different mechanism. */
  enforce: boolean;
  note?: string;
}

export const REST_ROUTE_CAPS: readonly RestRouteRule[] = Object.freeze([
  // Member & invite management — already owner/admin-gated, kept HARD.
  { method: 'POST',   path: '/api/auth/invites',        capability: 'members', mode: 'hard', enforce: true, note: 'create invite' },
  { method: 'GET',    path: '/api/auth/invites',        capability: 'members', mode: 'hard', enforce: true, note: 'list invites' },
  { method: 'POST',   path: '/api/auth/invites/revoke', capability: 'members', mode: 'hard', enforce: true, note: 'revoke invite' },
  // Member role change (slice 3) — owner/admin only, kept HARD (no shadow soak).
  { method: 'POST',   path: '/api/auth/members/role',   capability: 'members', mode: 'hard', enforce: true, note: 'change member role' },
  // Self-serve account deletion (GDPR/CCPA right-to-erasure) — owner-only
  // (`billing` capability, same rung as the billing routes below), kept HARD.
  { method: 'POST',   path: '/api/auth/account/erasure',        capability: 'billing', mode: 'hard', enforce: true, note: 'request account erasure' },
  { method: 'GET',    path: '/api/auth/account/erasure',        capability: 'billing', mode: 'hard', enforce: true, note: 'erasure request status' },
  { method: 'POST',   path: '/api/auth/account/erasure/cancel', capability: 'billing', mode: 'hard', enforce: true, note: 'cancel account erasure' },
  // Task mutations — no prior role gate, shadow-mode soak.
  { method: 'POST',   path: '/api/tasks',               capability: 'work',      mode: 'shadow', enforce: true, note: 'create task' },
  { method: 'PATCH',  path: '/api/tasks/:id',           capability: 'work',      mode: 'shadow', enforce: true, note: 'update task' },
  // Schedule mutations — no prior role gate, shadow-mode soak.
  { method: 'POST',   path: '/api/schedules',           capability: 'configure', mode: 'shadow', enforce: true, note: 'create schedule' },
  { method: 'PATCH',  path: '/api/schedules/:id',       capability: 'configure', mode: 'shadow', enforce: true, note: 'update schedule' },
  { method: 'DELETE', path: '/api/schedules/:id',       capability: 'configure', mode: 'shadow', enforce: true, note: 'delete schedule' },
  { method: 'POST',   path: '/api/schedules/:id/run',   capability: 'configure', mode: 'shadow', enforce: true, note: 'run schedule now' },
  // Budgets — read capability in the model, but the REST routes carry a
  // stricter operator-token gate (requireAdmin). Documented, not role-enforced.
  { method: 'GET',    path: '/api/budgets/status',      capability: 'read', mode: 'hard', enforce: false, note: 'operator-token gated' },
  { method: 'GET',    path: '/api/budgets/breakdown',   capability: 'read', mode: 'hard', enforce: false, note: 'operator-token gated' },
  { method: 'GET',    path: '/api/budgets/usage',       capability: 'read', mode: 'hard', enforce: false, note: 'operator-token gated' },

  // Usage meter (product events — ADR-014 S2). Same read/operator-token posture
  // as budgets: reads are a `read` capability in the model, REST is operator-gated.
  { method: 'GET',    path: '/api/usage/summary',       capability: 'read', mode: 'hard', enforce: false, note: 'operator-token gated' },
  { method: 'GET',    path: '/api/usage/breakdown',     capability: 'read', mode: 'hard', enforce: false, note: 'operator-token gated' },

  // Gift / redeemable subscription codes (GROWTH — core/gift-codes.ts). Redeem
  // mutates the redeeming tenant's plan/credit balance — owner-only HARD gate,
  // same rung as account erasure. Mint/list/revoke mint platform-wide grants
  // with no redeeming tenant in scope, so like budgets/usage they're gated by
  // requireAdmin (x-admin-token) instead of a tenant role; documented here
  // (enforce:false) for the same reason.
  { method: 'POST',   path: '/api/gift-codes/redeem',   capability: 'billing', mode: 'hard', enforce: true,  note: 'redeem gift code (owner only)' },
  { method: 'POST',   path: '/api/gift-codes',          capability: 'billing', mode: 'hard', enforce: false, note: 'operator-token gated (mint)' },
  { method: 'GET',    path: '/api/gift-codes',          capability: 'billing', mode: 'hard', enforce: false, note: 'operator-token gated (list)' },
  { method: 'POST',   path: '/api/gift-codes/revoke',   capability: 'billing', mode: 'hard', enforce: false, note: 'operator-token gated (revoke)' },
]);

/** Split a URL path into non-empty segments (query string stripped). */
function pathSegments(p: string): string[] {
  return p.split('?')[0].split('/').filter(Boolean);
}

/**
 * Look up the required capability for a concrete (method, path), matching
 * `:param` segments positionally. Returns undefined for unmapped routes (the
 * REST guard leaves those untouched — this matrix is an allow-list of the
 * routes slice 2 enforces, not a fail-closed global gate like `executeTool`).
 */
export function capabilityForRoute(method: string, path: string): Capability | undefined {
  const m = method.toUpperCase();
  const segs = pathSegments(path);
  for (const rule of REST_ROUTE_CAPS) {
    if (rule.method !== m) continue;
    const ruleSegs = pathSegments(rule.path);
    if (ruleSegs.length !== segs.length) continue;
    const ok = ruleSegs.every((rs, i) => rs.startsWith(':') || rs === segs[i]);
    if (ok) return rule.capability;
  }
  return undefined;
}

/**
 * Resolve the caller's effective RBAC role for a REST request. Prefers the
 * verified session-JWT role claim (the dashboard proxy forwards it as a cookie
 * or Bearer token — ADR-013 §2 JWT path); falls back to the role already on the
 * resolved `req.tenant` (tenant-key / local-trust), then to the pre-RBAC
 * default (`member`). `verify` is injected to keep this module free of a
 * user-auth import cycle.
 */
export function resolveRestRole(
  req: Pick<Request, 'header'> & { cookies?: Record<string, string>; tenant?: ToolContext },
  verify?: (token: string) => { role?: CtxRole },
): CtxRole {
  if (verify) {
    const token =
      req.cookies?.myai_token || req.header?.('authorization')?.replace('Bearer ', '');
    if (token) {
      try {
        const claim = verify(token);
        if (claim?.role) return claim.role;
      } catch {
        /* invalid/expired token → fall through to ctx/default */
      }
    }
  }
  return effectiveRole(req.tenant);
}

/**
 * Express guard by minimum role — the `requireRole('admin')` form from
 * ADR-013 §3. Passes when the caller's role dominates `minRole` on the
 * capability lattice (so `owner`/`system`/`operator` pass an `admin` gate).
 */
export function requireRole(minRole: CtxRole) {
  return function guard(req: Request, res: Response, next: NextFunction): void {
    const role = effectiveRole(ctxOf(req));
    if (roleAtLeast(role, minRole)) {
      next();
      return;
    }
    const enforced = rbacEnforceEnabled();
    getLogger().warn(
      { role, minRole, action: req.path, tenantId: ctxOf(req)?.tenantId, enforced },
      enforced ? 'rbac.denied' : 'rbac.shadow',
    );
    if (!enforced) {
      next();
      return;
    }
    const ctx = ctxOf(req);
    if (ctx?.tenantId) {
      recordAuditEvent({
        tenantId: ctx.tenantId,
        actor: { userId: ctx.userId, role, via: ctx.local ? 'local' : ctx.keyId ? 'api-key' : ctx.userId ? 'jwt' : 'system' },
        action: 'rbac.denied',
        target: req.path,
        detail: { minRole },
      });
    }
    res.status(403).json({
      error: `role '${role}' is below required '${minRole}'`,
      code: 'FORBIDDEN',
    });
  };
}

// ── RBAC v2 — per-resource permission matrix (ADR-013 Phase-3 seam) ──────────
//
// v1 maps each TOOL/ROUTE to ONE capability. v2 adds a second, orthogonal view:
// per-RESOURCE × per-ACTION granularity, so governance surfaces (the dashboard
// permission matrix, the audit-log filters, SOC2 evidence export) can answer
// "which roles may DELETE a plan?" without walking the whole tool inventory.
//
// It is a PROJECTION of the SAME role→capability lattice — not a parallel
// permission system. Every (resource, action) resolves to exactly one v1
// capability, so the two views can never disagree: if the matrix says `admin`
// may delete a schedule, it is because `delete schedule` requires `configure`
// and `admin` holds `configure`. Destructive actions deliberately sit one rung
// higher than their create/update siblings (delete → `configure`), which is the
// finer granularity v1's single-capability-per-tool model couldn't express.

/** The governed resource classes (ADR-013 §4/§5 named surfaces + audit trail). */
export type Resource = 'tasks' | 'plans' | 'schedules' | 'connectors' | 'members' | 'billing' | 'audit';

export const RESOURCES: readonly Resource[] = [
  'tasks', 'plans', 'schedules', 'connectors', 'members', 'billing', 'audit',
];

/** The action verbs a resource may support. Not every resource supports all. */
export type ResourceAction = 'read' | 'create' | 'update' | 'delete' | 'export' | 'manage';

/**
 * (resource, action) → the single v1 capability it requires. A resource omits
 * actions it doesn't support (e.g. `audit` is append-only from the app's view —
 * no create/update/delete verb is exposed; `billing` has no create/delete).
 * Destructive verbs (`delete`) sit at `configure`, one rung above create/update
 * `work`, so a `member` can do work but not tear it down.
 */
export const RESOURCE_PERMISSIONS: Readonly<
  Record<Resource, Readonly<Partial<Record<ResourceAction, Capability>>>>
> = Object.freeze({
  tasks: Object.freeze({
    read: 'read', create: 'work', update: 'work', delete: 'configure', export: 'read',
  }),
  plans: Object.freeze({
    read: 'read', create: 'work', update: 'work', delete: 'configure', export: 'read',
  }),
  schedules: Object.freeze({
    read: 'read', create: 'configure', update: 'configure', delete: 'configure',
  }),
  connectors: Object.freeze({
    read: 'read', create: 'configure', update: 'configure', delete: 'configure',
  }),
  members: Object.freeze({
    read: 'read', create: 'members', update: 'members', delete: 'members', manage: 'members',
  }),
  billing: Object.freeze({
    read: 'billing', update: 'billing', manage: 'billing',
  }),
  audit: Object.freeze({
    read: 'members', export: 'members',
  }),
});

/**
 * The capability required for `(resource, action)`, or undefined if that verb
 * isn't defined for the resource (an undefined verb is NOT silently permitted —
 * `assertResourcePermission` fails closed on it).
 */
export function capabilityForResourceAction(
  resource: Resource,
  action: ResourceAction,
): Capability | undefined {
  return RESOURCE_PERMISSIONS[resource]?.[action];
}

/** True if `role` may perform `action` on `resource` per the matrix. */
export function roleCanResourceAction(role: CtxRole, resource: Resource, action: ResourceAction): boolean {
  const cap = capabilityForResourceAction(resource, action);
  return cap !== undefined && roleHasCapability(role, cap);
}

/** True if the context's effective role may perform `action` on `resource`. */
export function ctxCanResourceAction(
  ctx: Pick<ToolContext, 'role'> | undefined,
  resource: Resource,
  action: ResourceAction,
): boolean {
  return roleCanResourceAction(effectiveRole(ctx), resource, action);
}

/**
 * Per-resource enforcement helper — the v2 twin of `assertCapability`. Throws
 * `AuthError(403, 'FORBIDDEN')` when the role can't perform the action AND
 * enforcement is on; in shadow mode logs the would-be denial and returns.
 * Fails closed on an undefined (resource, action) verb even in shadow mode:
 * an unknown destructive verb must not be treated as pre-RBAC-permitted.
 */
export function assertResourcePermission(
  ctx: ToolContext | undefined,
  resource: Resource,
  action: ResourceAction,
): void {
  const role = effectiveRole(ctx);
  const cap = capabilityForResourceAction(resource, action);
  const label = `${action} ${resource}`;

  if (cap === undefined) {
    // Undefined verb — no matrix entry. Fail closed regardless of mode.
    getLogger().warn(
      { role, resource, action, userId: ctx?.userId, tenantId: ctx?.tenantId },
      'rbac.undefined-resource-action',
    );
    throw new AuthError(`no permission rule for '${label}'`, 403, 'FORBIDDEN');
  }
  // Delegate to the capability chokepoint so shadow/enforce behavior is identical
  // to the v1 path (one source of truth for the RBAC_ENFORCE gate).
  assertCapability(ctx, cap, { action: label });
}

/** One row of the full permission grid — the shape the dashboard viewer renders. */
export interface ResourcePermissionRow {
  resource: Resource;
  action: ResourceAction;
  capability: Capability;
  /** Per-role allow/deny for this cell — the matrix the UI paints. */
  roles: Record<CtxRole, boolean>;
}

const ALL_CTX_ROLES: readonly CtxRole[] = ['viewer', 'member', 'admin', 'owner', 'system', 'operator'];

/**
 * Materialize the entire resource × action × role grid. This is the data the
 * in-dashboard "Permissions" matrix renders and the governance/SOC2 export
 * serializes — a single, testable source of truth derived from the matrix.
 */
export function resourcePermissionGrid(): ResourcePermissionRow[] {
  const rows: ResourcePermissionRow[] = [];
  for (const resource of RESOURCES) {
    const actions = RESOURCE_PERMISSIONS[resource];
    for (const action of Object.keys(actions) as ResourceAction[]) {
      const capability = actions[action]!;
      const roles = {} as Record<CtxRole, boolean>;
      for (const role of ALL_CTX_ROLES) roles[role] = roleHasCapability(role, capability);
      rows.push({ resource, action, capability, roles });
    }
  }
  return rows;
}
