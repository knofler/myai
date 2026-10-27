/**
 * Tenant MCP tool plugins (task-6f9ae8ea) — a runtime registration path that
 * lets a tenant extend the gateway's built-in tool surface with its OWN custom
 * MCP tools (name + JSON-Schema input contract + handler URL) without a
 * gateway redeploy. The gateway PROXIES tools/call for a registered plugin to
 * the tenant's handler URL and returns the handler's response as the tool
 * result.
 *
 * Posture (all non-negotiable):
 *  - ENV-GATED, off by default: nothing lists, registers, or dispatches unless
 *    MYAI_TENANT_TOOL_PLUGINS=1|true. Registered rows survive a gate flip but
 *    are inert while it is off.
 *  - TENANT-SCOPED: every read/write goes through the scoped-query helpers
 *    (ADR-010) — tenant A's plugins never appear in tenant B's tools/list and
 *    can never be invoked from tenant B's context.
 *  - BUILT-INS WIN: mcp/handler.ts only consults the plugin registry AFTER a
 *    TOOL_DEFINITIONS miss, and registration refuses a name colliding with the
 *    built-in surface — a plugin can never shadow or intercept a gateway tool.
 *  - SANDBOXED PROXY: the handler URL must be https (http for loopback only —
 *    same rule as webhook-store), the call carries a hard per-plugin timeout
 *    (clamped to [250ms, 30s]), and the response body is size-capped. The
 *    proxy sends ONLY the tool name + caller args + tenantId — no gateway
 *    credentials, no ctx internals.
 *  - AUDITED: registry changes land in the tenant's tamper-evident audit chain
 *    as `plugintool.change`, every proxied invocation as `plugintool.invoke`
 *    (handler URLs are never written to the trail — they routinely embed
 *    tokens, same reasoning as connector-store's secret-field redaction).
 */
import { TenantToolPluginModel, isConnected } from '../shared/db.js';
import type { ITenantToolPlugin } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import {
  scopedCountDocuments,
  scopedDeleteOne,
  scopedFind,
  scopedFindOne,
  scopedFindOneAndUpdate,
} from '../shared/scoped-query.js';
import { recordAuditEvent, auditActorFromCtx, type AuditActor } from '../core/audit-log.js';
import type { ToolContext } from '../core/tenant-context.js';
import { assertPublicDestination, isBlockedHostLiteral, privateOutboundAllowed } from '../shared/url-guard.js';

const log = createChildLogger({ module: 'plugin-tools' });

const SYSTEM_ACTOR: AuditActor = { role: 'system', via: 'system' };

// ── Limits (constants, exported for tests) ───────────────────────────
export const MAX_PLUGINS_PER_TENANT = 20;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MIN_TIMEOUT_MS = 250;
export const MAX_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 256 * 1024;
/** Same shape rule the contract test enforces on built-in tool names. */
export const PLUGIN_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;

// ── Env gate ─────────────────────────────────────────────────────────
/** Off by default — the whole feature is opt-in via MYAI_TENANT_TOOL_PLUGINS. */
export function tenantToolPluginsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.MYAI_TENANT_TOOL_PLUGINS;
  return v === '1' || v === 'true';
}

function assertEnabled(): void {
  if (!tenantToolPluginsEnabled()) {
    throw new Error('tenant tool plugins are disabled (set MYAI_TENANT_TOOL_PLUGINS=1 to enable)');
  }
}

// ── Views ────────────────────────────────────────────────────────────
export interface PluginToolView {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handlerUrl: string;
  timeoutMs: number;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** The MCP tools/list shape — what gets appended to the built-in surface. */
export interface PluginToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type PluginDoc = Pick<
  ITenantToolPlugin,
  'name' | 'description' | 'inputSchema' | 'handlerUrl' | 'timeoutMs' | 'enabled' | 'createdAt' | 'updatedAt'
>;

function toView(doc: PluginDoc): PluginToolView {
  return {
    name: doc.name,
    description: doc.description,
    inputSchema: doc.inputSchema,
    handlerUrl: doc.handlerUrl,
    timeoutMs: doc.timeoutMs,
    enabled: doc.enabled,
    createdAt: doc.createdAt?.toISOString(),
    updatedAt: doc.updatedAt?.toISOString(),
  };
}

// ── Validation ───────────────────────────────────────────────────────
/**
 * Same https-or-loopback rule as webhook-store's validateWebhookUrl: https
 * required, plain http allowed only for loopback (local dev / self-host).
 * Returns the normalized href or throws.
 */
export function validateHandlerUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('handlerUrl is required');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('handlerUrl must be a valid absolute URL');
  }
  if (isBlockedHostLiteral(u.hostname) && !privateOutboundAllowed()) {
    throw new Error('handlerUrl must not be a private or loopback address (MYAI_ALLOW_PRIVATE_OUTBOUND=1 to allow)');
  }
  const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);
  if (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback)) return u.href;
  throw new Error('handlerUrl must be https (http allowed only for loopback)');
}

function clampTimeout(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('timeoutMs must be a number');
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}

function validateName(raw: unknown, reservedNames: ReadonlySet<string>): string {
  if (typeof raw !== 'string' || !PLUGIN_NAME_RE.test(raw)) {
    throw new Error('name must be snake_case, 3-64 chars ([a-z][a-z0-9_]{2,63})');
  }
  if (reservedNames.has(raw)) {
    throw new Error(`name "${raw}" collides with a built-in gateway tool`);
  }
  return raw;
}

function validateInputSchema(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('inputSchema must be a JSON-Schema object');
  }
  const schema = raw as Record<string, unknown>;
  if (schema.type !== 'object') throw new Error('inputSchema.type must be "object"');
  if (schema.properties !== undefined && (typeof schema.properties !== 'object' || schema.properties === null)) {
    throw new Error('inputSchema.properties must be an object when present');
  }
  return schema;
}

// ── Registry CRUD ────────────────────────────────────────────────────
export interface RegisterPluginToolInput {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  handlerUrl?: unknown;
  timeoutMs?: unknown;
  enabled?: unknown;
}

/**
 * Register (create) or update (upsert-by-name) a tenant's custom tool.
 * Validates everything, enforces the per-tenant cap on NEW names, and audits
 * the change. Throws a plain Error on validation failure (the MCP handler
 * surfaces it as `{ error }`).
 */
export async function registerPluginTool(
  tenantId: string,
  input: RegisterPluginToolInput,
  opts: { reservedNames: ReadonlySet<string>; actor?: AuditActor },
): Promise<PluginToolView> {
  assertEnabled();
  if (!isConnected()) throw new Error('DB not connected — plugin not saved');

  const name = validateName(input.name, opts.reservedNames);
  if (typeof input.description !== 'string' || !input.description.trim()) {
    throw new Error('description is required');
  }
  const inputSchema = validateInputSchema(input.inputSchema);
  const handlerUrl = validateHandlerUrl(input.handlerUrl);
  const timeoutMs = clampTimeout(input.timeoutMs);
  const enabled = input.enabled === undefined ? true : Boolean(input.enabled);

  const existing = await scopedFindOne(TenantToolPluginModel, tenantId, { name }).lean<PluginDoc | null>();
  if (!existing) {
    const count = await scopedCountDocuments(TenantToolPluginModel, tenantId, {});
    if (count >= MAX_PLUGINS_PER_TENANT) {
      throw new Error(`plugin limit reached (${MAX_PLUGINS_PER_TENANT} per tenant)`);
    }
  }

  const doc = await scopedFindOneAndUpdate(
    TenantToolPluginModel,
    tenantId,
    { name },
    { $set: { description: input.description, inputSchema, handlerUrl, timeoutMs, enabled } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean<PluginDoc>();

  // Handler URLs routinely embed tokens — record WHICH fields changed, never
  // the URL value itself (connector-store secret-field posture).
  recordAuditEvent({
    tenantId,
    actor: opts.actor ?? SYSTEM_ACTOR,
    action: 'plugintool.change',
    target: name,
    detail: existing
      ? { updated: true, enabled, timeoutMs }
      : { created: true, enabled, timeoutMs },
  });
  log.info({ tenantId, name, created: !existing, enabled, timeoutMs }, 'tenant tool plugin registered');
  return toView(doc!);
}

/** All of a tenant's registered plugins (enabled or not) — the registry view. */
export async function listPluginTools(tenantId: string): Promise<PluginToolView[]> {
  if (!tenantToolPluginsEnabled() || !isConnected()) return [];
  const docs = await scopedFind(TenantToolPluginModel, tenantId, {})
    .sort({ name: 1 })
    .lean<PluginDoc[]>();
  return docs.map(toView);
}

/** Remove a plugin by name. Returns whether a row was deleted. Audited. */
export async function removePluginTool(
  tenantId: string,
  name: unknown,
  actor?: AuditActor,
): Promise<{ removed: boolean }> {
  assertEnabled();
  if (!isConnected()) throw new Error('DB not connected — plugin not removed');
  if (typeof name !== 'string' || !name.trim()) throw new Error('name is required');
  const res = await scopedDeleteOne(TenantToolPluginModel, tenantId, { name });
  const removed = (res?.deletedCount ?? 0) > 0;
  if (removed) {
    recordAuditEvent({
      tenantId,
      actor: actor ?? SYSTEM_ACTOR,
      action: 'plugintool.change',
      target: name,
      detail: { removed: true },
    });
    log.info({ tenantId, name }, 'tenant tool plugin removed');
  }
  return { removed };
}

/**
 * The tenant's ENABLED plugins in MCP tools/list shape — what mcp/handler.ts
 * appends after the built-in surface. [] when the gate is off or the DB is
 * down, so tools/list is byte-identical to pre-feature behaviour by default.
 */
export async function pluginToolDefsForTenant(tenantId: string | undefined): Promise<PluginToolDef[]> {
  if (!tenantId || !tenantToolPluginsEnabled() || !isConnected()) return [];
  try {
    const docs = await scopedFind(TenantToolPluginModel, tenantId, { enabled: true })
      .sort({ name: 1 })
      .lean<PluginDoc[]>();
    return docs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }));
  } catch (err) {
    log.warn({ err, tenantId }, 'plugin tools/list lookup failed — omitting plugins');
    return [];
  }
}

// ── Proxy dispatch ───────────────────────────────────────────────────
export type PluginCallOutcome =
  | { found: false }
  | { found: true; ok: true; result: unknown }
  | { found: true; ok: false; error: string };

/**
 * Dispatch a tools/call miss against the tenant's plugin registry. Returns
 * `{ found: false }` (caller falls through to its normal Unknown-tool error)
 * when the gate is off, the DB is down, or no ENABLED plugin matches. When a
 * plugin matches, POSTs `{ tool, arguments, tenantId }` to its handler URL
 * with the plugin's clamped timeout, caps the response size, and audits the
 * invocation either way.
 */
export async function callPluginTool(
  ctx: ToolContext | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<PluginCallOutcome> {
  const tenantId = ctx?.tenantId;
  if (!tenantId || !tenantToolPluginsEnabled() || !isConnected()) return { found: false };
  let plugin: PluginDoc | null = null;
  try {
    plugin = await scopedFindOne(TenantToolPluginModel, tenantId, { name, enabled: true }).lean<PluginDoc | null>();
  } catch (err) {
    log.warn({ err, tenantId, name }, 'plugin lookup failed');
    return { found: false };
  }
  if (!plugin) return { found: false };

  const startedAt = Date.now();
  const outcome = await proxyToHandler(tenantId, plugin, args);
  recordAuditEvent({
    tenantId,
    actor: auditActorFromCtx(ctx),
    action: 'plugintool.invoke',
    target: name,
    detail: { ok: outcome.ok, ms: Date.now() - startedAt, ...(outcome.ok ? {} : { error: outcome.error }) },
  });
  return { found: true, ...outcome };
}

async function proxyToHandler(
  tenantId: string,
  plugin: PluginDoc,
  args: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    await assertPublicDestination(plugin.handlerUrl);
    const res = await fetch(plugin.handlerUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'x-myai-plugin-tool': plugin.name,
        'x-myai-tenant': tenantId,
      },
      body: JSON.stringify({ tool: plugin.name, arguments: args, tenantId }),
      signal: AbortSignal.timeout(plugin.timeoutMs),
    });
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      return { ok: false, error: `plugin response too large (> ${MAX_RESPONSE_BYTES} bytes)` };
    }
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, error: `plugin handler redirected (HTTP ${res.status}); redirects are not followed` };
    }
    if (!res.ok) {
      return { ok: false, error: `plugin handler returned HTTP ${res.status}` };
    }
    try {
      return { ok: true, result: JSON.parse(text) };
    } catch {
      return { ok: true, result: text };
    }
  } catch (err) {
    const isTimeout = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
    const error = isTimeout
      ? `plugin handler timed out after ${plugin.timeoutMs}ms`
      : `plugin handler unreachable: ${(err as Error).message}`;
    log.warn({ tenantId, name: plugin.name, error }, 'plugin proxy call failed');
    return { ok: false, error };
  }
}
