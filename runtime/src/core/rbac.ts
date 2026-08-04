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
import { recordShadowDenial } from '../monitoring/rbac-shadow-store.js';

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

  // Shadow mode: soak-record the would-be denial (ADR-013 §6) so an operator
  // can answer "what would 403 if RBAC_ENFORCE flips on today" from the
  // dashboard instead of grepping structured logs across every gateway
  // process. Tenant-scoped, same fail-soft discipline as the audit path above.
  if (ctx?.tenantId) {
    recordShadowDenial({
      tenantId: ctx.tenantId,
      role,
      capability: cap,
      action: opts.action ?? 'unknown',
      userId: ctx?.userId,
    });
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

  // Outbound webhooks — tenant-registered integrations. No prior role gate
  // (only tenantId scoping via ctxFromReq) — any authenticated member,
  // including viewer, could create/delete endpoints or replay deliveries.
  // Shadow-mode soak at `configure` (same rung as connectors/schedules).
  { method: 'POST',   path: '/api/webhooks',                       capability: 'configure', mode: 'shadow', enforce: true, note: 'create webhook endpoint' },
  { method: 'PUT',    path: '/api/webhooks/:id',                   capability: 'configure', mode: 'shadow', enforce: true, note: 'update webhook endpoint' },
  { method: 'DELETE', path: '/api/webhooks/:id',                   capability: 'configure', mode: 'shadow', enforce: true, note: 'delete webhook endpoint' },
  { method: 'POST',   path: '/api/webhooks/deliveries/:id/replay', capability: 'configure', mode: 'shadow', enforce: true, note: 'replay webhook delivery' },

  // Memory/vector corpus import — overwrites the tenant's memory/vector
  // corpus with caller-supplied content. No prior role gate. Shadow-mode
  // soak at `work` (same rung as other content-mutation routes).
  { method: 'POST',   path: '/api/memory/import',                  capability: 'work', mode: 'shadow', enforce: true, note: 'import memory bundle' },
  { method: 'POST',   path: '/api/vectors/import',                 capability: 'work', mode: 'shadow', enforce: true, note: 'import vector corpus' },
]);

// ── MCP tool → capability inventory (ADR-013 §3 — slice 2, tool adapter) ─────
//
// The tool-side twin of REST_ROUTE_CAPS: every tool in the `executeTool`
// dispatch switch maps to the single capability it requires, and
// `assertToolCapability` applies the matrix at that ONE chokepoint — MCP parity
// with the REST `enforceRbac` gate. Rungs follow RESOURCE_PERMISSIONS:
//   read      — pure reads / analysis (viewer+)
//   work      — create/update work product: tasks, memory, logs, sessions,
//               brain content, agent/skill invocation, queue advancement (member+)
//   configure — tenant/fleet configuration + operational state: schedules,
//               connectors, repos registry, provider/fleet maintenance, sweeps,
//               retention purge, hosted-brain provisioning (admin+)
//   members   — cross-tenant sharing grants (admin+)
// A parity test (rbac-tool-caps.test.ts) asserts every TOOL_DEFINITIONS entry
// is inventoried so a new tool cannot ship unmapped.
export const TOOL_CAPS: Readonly<Record<string, Capability>> = Object.freeze({
  // Memory / RAG
  memory_search: 'read',
  recall_session: 'read',
  memory_store: 'work',
  memory_context: 'read',
  memory_stats: 'read',
  memory_reindex: 'work',
  // State + handoff + plans
  state_read: 'read',
  state_update: 'work',
  plan_list: 'read',
  plan_set: 'work',
  handoff_write: 'work',
  handoff_read: 'read',
  // Tasks (matches REST: POST/PATCH /api/tasks → work)
  tasks_list: 'read',
  tasks_create: 'work',
  tasks_update: 'work',
  tasks_next: 'read',
  tasks_claim: 'work',
  tasks_fail: 'work',
  // Traces / logs / artifacts
  traces_record: 'work',
  traces_list: 'read',
  logs_record: 'work',
  logs_list: 'read',
  artifacts_register: 'work',
  artifacts_list: 'read',
  // Runner coordination
  runner_lease_acquire: 'work',
  runner_lease_heartbeat: 'work',
  runner_lease_release: 'work',
  runner_lease_list: 'read',
  runner_lease_history: 'read',
  runner_heartbeat: 'work',
  runner_liveness: 'read',
  // Repos registry + code graph
  repos_list: 'read',
  repos_status: 'read',
  repos_priority: 'read',
  repos_scan: 'work',
  repos_upsert: 'configure',
  repos_card_list: 'read',
  repos_card_upsert: 'configure',
  get_pr_impact: 'read',
  triage_prs: 'read',
  get_neighbors: 'read',
  shortest_path: 'read',
  new_app: 'work',
  // Connectors (matches RESOURCE_PERMISSIONS.connectors → configure)
  connectors_list: 'read',
  connectors_seed_defaults: 'configure',
  connectors_set: 'configure',
  connectors_toggle: 'configure',
  connectors_remove: 'configure',
  connectors_mcp_config: 'read',
  // Sessions / continuity
  session_export: 'work',
  session_import: 'work',
  session_recall: 'read',
  context_boot: 'read',
  continuity_stats: 'read',
  user_savings: 'read',
  activation_funnel: 'read',
  // Observability
  perf_stats: 'read',
  slo_status: 'read',
  health_status: 'read',
  health_alerts_status: 'read',
  health_alerts_run: 'work',
  standing_agents_status: 'read',
  pattern_analyze: 'read',
  // Fleet runs + orchestration
  fleet_run_start: 'work',
  fleet_run_repo_update: 'work',
  fleet_run_finish: 'work',
  fleet_run_latest: 'read',
  fleet_run_list: 'read',
  fleet_overview: 'read',
  dispatch_cycle: 'work',
  inline_execute: 'work', // delegated inner tool re-asserts its own capability
  morning_sweep: 'configure',
  evening_sweep: 'configure',
  // Agents + skills
  agents_list: 'read',
  skills_list: 'read',
  agents_invoke: 'work',
  skills_invoke: 'work',
  // Schedules (matches REST: POST/PATCH/DELETE /api/schedules → configure)
  schedules_list: 'read',
  schedules_create: 'configure',
  schedules_update: 'configure',
  schedules_run_now: 'configure',
  schedules_delete: 'configure',
  schedules_seed: 'configure',
  // Budgets + usage
  budgets_status: 'read',
  budgets_breakdown: 'read',
  budgets_suggestions: 'read',
  usage_summary: 'read',
  // Provider / fleet operational state
  provider_health: 'read',
  provider_reset: 'configure',
  provider_maintenance_enter: 'configure',
  provider_maintenance_exit: 'configure',
  fleet_maintenance_enter: 'configure',
  fleet_maintenance_exit: 'configure',
  routing_info: 'read',
  routing_config: 'read',
  data_retention_purge: 'configure',
  mrr_snapshot_sweep: 'configure',
  erasure_sweep: 'configure',
  task_lease_reap: 'configure',
  // Notifications
  notifications_send: 'work',
  notifications_history: 'read',
  notifications_test: 'work',
  // Brain (content = work, reads = read — mirrors tasks/plans rungs)
  brain_status: 'read',
  brain_health: 'read',
  brain_manifest: 'read',
  brain_bandit_stats: 'read',
  brain_explore: 'read',
  brain_commit: 'work',
  brain_stash: 'work',
  brain_pop: 'work',
  brain_branch: 'work',
  brain_checkout: 'work',
  brain_merge: 'work',
  brain_log: 'read',
  brain_diff: 'read',
  brain_delta: 'read',
  brain_lookup: 'read',
  brain_blame: 'read',
  brain_entity: 'read',
  brain_timeline: 'read',
  brain_communities: 'read',
  brain_revert: 'work',
  brain_search: 'read',
  // Brain namespace sharing (cross-tenant grants → members; grantee I/O keeps
  // its own grant-level checks inside namespace-share.ts)
  brain_namespace_share: 'members',
  brain_namespace_unshare: 'members',
  brain_namespace_grants: 'read',
  brain_namespace_read: 'read',
  brain_namespace_write: 'work',
  // Hosted brain remote (ADR-017)
  brain_host_provision: 'configure',
  brain_host_status: 'read',
  brain_host_rotate: 'configure',
  // Marketplace (ADR-019 §5: "marketplace.publish — creator owner/admin —
  // submit/publish own listings"; the closest existing rung to that
  // owner/admin restriction is `configure`, admin+).
  marketplace_publish: 'configure',
});

/** The capability a tool requires, or undefined for an uninventoried tool. */
export function capabilityForTool(tool: string): Capability | undefined {
  return TOOL_CAPS[tool];
}

/**
 * The `executeTool` chokepoint gate (ADR-013 §3 slice 2). Loopback/local-trust
 * callers (Claude Code, the runner) and internal `system`/`operator` principals
 * bypass — their behavior is unchanged. Everyone else is checked against the
 * tool→capability inventory via `assertCapability` (shadow/enforce semantics
 * identical to the REST gate). An uninventoried tool logs `rbac.unmapped-tool`
 * and is allowed in shadow mode (the ADR-013 §6 must-not-change-behavior soak
 * invariant) but DENIED once `RBAC_ENFORCE` is on — fail closed under
 * enforcement; the parity test keeps the inventory complete before that bites.
 */
export function assertToolCapability(ctx: ToolContext | undefined, tool: string): void {
  if (ctx?.local || ctx?.role === 'system' || ctx?.role === 'operator') return;
  const cap = TOOL_CAPS[tool];
  if (cap === undefined) {
    const enforced = rbacEnforceEnabled();
    getLogger().warn(
      { tool, role: effectiveRole(ctx), tenantId: ctx?.tenantId, enforced },
      'rbac.unmapped-tool',
    );
    if (enforced) {
      throw new AuthError(`no capability rule for tool '${tool}'`, 403, 'FORBIDDEN');
    }
    return;
  }
  assertCapability(ctx, cap, { action: tool });
}

// ── Per-org MCP tool VISIBILITY (Wave-2 #15 — GAP_BACKLOG_SCHEDULE.md) ──────
//
// `assertToolCapability` above gates by ROLE only: any tenant admin/owner
// holds `configure` and can call ops-plane tools (fleet run orchestration,
// provider/fleet maintenance, retention purge, hosted-brain provisioning)
// that were built for the OPERATOR fleet console, not tenant self-serve — a
// Solo-tier owner sees the identical tool surface as an operator. This is an
// ORTHOGONAL gate — tool VISIBILITY, not capability — applied at the SAME
// `executeTool` chokepoint right after `assertToolCapability`, and used to
// filter `tools/list` (mcp/handler.ts) so a hidden tool doesn't even appear.
//
// Default: every tool in `OPERATOR_ONLY_TOOLS` is hidden from every tenant
// context (local/system/operator bypass — same posture as
// `assertToolCapability`'s bypass, since those callers ARE the operator
// plane). Per-org override via `ToolContext.mcpToolAllowlist` /
// `mcpToolDenylist` (sourced from the `ITenant` record, db.ts) lets an
// operator punch a documented hole for one org (allow), or additionally hide
// a normally-visible tool for one org (deny). Allowlist wins over the
// default denial; denylist wins over default visibility.

/**
 * Tools that operate on cross-tenant / platform-wide state rather than a
 * single org's own data — the fleet console's tool surface. Hidden from
 * every tenant by default regardless of role or plan tier.
 */
export const OPERATOR_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // Fleet run orchestration — cross-tenant ops console, not a tenant action.
  'fleet_run_start', 'fleet_run_repo_update', 'fleet_run_finish',
  'fleet_run_latest', 'fleet_run_list', 'fleet_overview', 'dispatch_cycle',
  'morning_sweep', 'evening_sweep',
  // Provider / fleet operational state — platform-wide, not per-tenant.
  'provider_health', 'provider_reset',
  'provider_maintenance_enter', 'provider_maintenance_exit',
  'fleet_maintenance_enter', 'fleet_maintenance_exit',
  'routing_info', 'routing_config',
  // Data-retention purge — legal/compliance operator action, all tenants.
  'data_retention_purge',
  // MRR-snapshot sweep — cross-tenant revenue analytics job, all tenants.
  'mrr_snapshot_sweep',
  // Erasure sweep — legal/compliance operator action (irreversible purge of
  // due GDPR/CCPA requests), all tenants. Same posture as data_retention_purge.
  'erasure_sweep',
  // Task-lease reaper — walks status:'working' tasks past leaseUntil across
  // EVERY tenant to release runner-died stale claims, same cross-tenant
  // posture as data_retention_purge/erasure_sweep.
  'task_lease_reap',
  // Hosted-brain remote provisioning — operator-provisioned infra, not
  // self-serve (ADR-017).
  'brain_host_provision', 'brain_host_rotate',
  // Standing-agent framework health — operator/fleet observability, not a
  // tenant's own data.
  'standing_agents_status',
]);

/** True for contexts that already bypass `assertToolCapability` — they ARE
 *  the operator plane, so tool visibility never restricts them either. */
function toolVisibilityBypass(ctx: ToolContext | undefined): boolean {
  return Boolean(ctx?.local || ctx?.role === 'system' || ctx?.role === 'operator');
}

/** True if `ctx` may see/call `tool`, folding in the per-org allow/deny
 *  override before the `OPERATOR_ONLY_TOOLS` default. Pure — no I/O. */
export function isToolVisibleForTenant(ctx: ToolContext | undefined, tool: string): boolean {
  if (toolVisibilityBypass(ctx)) return true;
  if (ctx?.mcpToolAllowlist?.includes(tool)) return true;
  if (ctx?.mcpToolDenylist?.includes(tool)) return false;
  return !OPERATOR_ONLY_TOOLS.has(tool);
}

/** Filter a `TOOL_DEFINITIONS`-shaped list down to what `ctx` may see —
 *  the `tools/list` chokepoint (mcp/handler.ts). */
export function filterToolsForTenant<T extends { name: string }>(
  ctx: ToolContext | undefined,
  tools: readonly T[],
): T[] {
  return tools.filter((t) => isToolVisibleForTenant(ctx, t.name));
}

/**
 * The `executeTool` chokepoint gate, alongside `assertToolCapability`. Throws
 * `AuthError(403, 'TOOL_NOT_AVAILABLE')` when `tool` is hidden from this
 * org's context — same shadow-free posture as an unmapped-tool denial under
 * enforcement (this is an additive restriction, not a role-capability soak,
 * so it is NOT gated by `RBAC_ENFORCE`).
 */
export function assertToolVisibility(ctx: ToolContext | undefined, tool: string): void {
  if (isToolVisibleForTenant(ctx, tool)) return;
  getLogger().warn(
    { tool, tenantId: ctx?.tenantId, role: effectiveRole(ctx) },
    'rbac.tool-hidden',
  );
  throw new AuthError(`tool '${tool}' is not available on this plan/org`, 403, 'TOOL_NOT_AVAILABLE');
}

// ── Marketplace-exposable tool allowlist (ADR-028 §5) ────────────────────────
//
// `capabilities.declaredTools` in a marketplace package manifest may only
// reference tools a third-party package could legitimately request — never
// the full gateway surface. ADR-028 §5 fixes this as a mechanical
// set-subtraction over predicates that already exist here, specifically so
// the local CLI validator and the review pipeline compute it from the same
// source instead of each hand-maintaining a copy (the drift risk flagged in
// that ADR's own Risks table):
//
//   marketplace-exposable tools = ALL_TOOL_DEFINITIONS
//                                   − OPERATOR_ONLY_TOOLS
//                                   − { tools whose minimum required role > 'member' }
//
// `TOOL_CAPS`'s keys ARE `ALL_TOOL_DEFINITIONS`'s name set — the
// `rbac-tool-caps.test.ts` parity test asserts every `TOOL_DEFINITIONS` entry
// (and every `dispatchTool` case) is inventoried in `TOOL_CAPS` with no stale
// keys — so no import of `mcp/tools.ts` is needed here (that would also be a
// circular import, since `tools.ts` imports this module).
//
// "minimum required role > 'member'" is `!roleHasCapability('member', cap)`:
// `ROLE_CAPS` is monotonically increasing by role, so if `member` holds the
// tool's capability, no role below `member` requires more than `member` does.

/**
 * The marketplace-exposable tool allowlist (ADR-028 §5) — a pure derivation
 * from `TOOL_CAPS` + `OPERATOR_ONLY_TOOLS`, never a new policy decision.
 * Tracks additions to either automatically; no hand-maintained list to drift.
 *
 * `toolCaps`/`operatorOnlyTools` default to the real, frozen module
 * singletons — callers never pass these in production. The parameters exist
 * so tests can inject an extended copy (e.g. `{ ...TOOL_CAPS, x: 'work' }`)
 * and assert the output tracks it, without mutating the frozen singletons.
 */
export function marketplaceExposableTools(
  toolCaps: Readonly<Record<string, Capability>> = TOOL_CAPS,
  operatorOnlyTools: ReadonlySet<string> = OPERATOR_ONLY_TOOLS,
): string[] {
  return Object.keys(toolCaps).filter((tool) => {
    if (operatorOnlyTools.has(tool)) return false;
    return roleHasCapability('member', toolCaps[tool]);
  });
}

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
