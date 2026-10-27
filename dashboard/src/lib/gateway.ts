// Single gateway MCP fetch helper — previously duplicated across fleet,
// api-health, routing and schedule pages.

export const GATEWAY_URL = process.env.GATEWAY_MCP_URL ?? 'http://gateway:3100/mcp';

// The gateway's REST/HTTP server (auth endpoints, /api/auth/*) listens on a
// DIFFERENT port than the MCP server (GATEWAY_HTTP_PORT=3200 vs MCP_PORT=3100).
// Use GATEWAY_HTTP_URL when set, else derive it by stripping /mcp and swapping
// the 3100 MCP port for the 3200 HTTP port.
export const GATEWAY_HTTP_URL =
  process.env.GATEWAY_HTTP_URL ??
  GATEWAY_URL.replace(/\/mcp\/?$/, '').replace(/:3100$/, ':3200');

// ADR-010: under tenancy enforce=true the gateway requires the bridge token for
// non-loopback (in-cluster) callers. Sent as x-gateway-local-token; absent → the
// gateway treats the call as unauthenticated and 401s under enforcement.
export const GATEWAY_LOCAL_TOKEN = process.env.GATEWAY_LOCAL_TOKEN;

/** Build gateway request headers, including the local bridge token when set. */
export function gatewayHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (GATEWAY_LOCAL_TOKEN) h['x-gateway-local-token'] = GATEWAY_LOCAL_TOKEN;
  return h;
}

/**
 * Cloud fallback (operator decision 2026-10-02, "Atlas, no tunnel"): when the
 * gateway is UNREACHABLE — always the case on Vercel, where the office-Mac
 * gateway is deliberately not exposed — answer the tool from Atlas instead.
 * The Atlas implementation (lib/gateway-atlas.ts: mongoose + next/headers) is
 * SERVER-ONLY and this module is also bundled into client pages, so it is never
 * imported here: instrumentation.ts registers it on globalThis at server boot
 * (lib/gateway-fallback-register.ts). Tool-level errors from a reachable
 * gateway are never masked — only unreachable / 5xx falls back.
 */
export const GATEWAY_FALLBACK_KEY = '__myaiGatewayAtlasFallback';
type GatewayFallback = (toolName: string, args: Record<string, unknown>) => Promise<unknown | null>;

async function atlasFallback<T>(toolName: string, args: Record<string, unknown>): Promise<T | null> {
  const fb = (globalThis as Record<string, unknown>)[GATEWAY_FALLBACK_KEY] as GatewayFallback | undefined;
  if (typeof fb !== 'function') return null;
  try {
    return (await fb(toolName, args)) as T | null;
  } catch (err) {
    console.warn(`[myAI] Atlas fallback ${toolName}:`, err instanceof Error ? err.message : 'failed');
    return null;
  }
}

export async function callGateway<T>(toolName: string, args: Record<string, unknown> = {}): Promise<T | null> {
  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: gatewayHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: toolName, arguments: args },
        id: 1,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return res.status >= 500 ? atlasFallback<T>(toolName, args) : null;
    const json = await res.json();
    const content = json?.result?.content;
    if (!content || !Array.isArray(content) || content.length === 0) return null;
    const textEntry = content.find((c: { type: string }) => c.type === 'text');
    if (!textEntry) return null;
    try {
      return JSON.parse(textEntry.text) as T;
    } catch {
      console.warn(`[myAI] Gateway ${toolName}: malformed JSON in response`);
      return null;
    }
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      console.warn(`[myAI] Gateway ${toolName}:`, err instanceof Error ? err.message : 'fetch failed');
    }
    // Network failure / timeout = gateway unreachable → Atlas.
    return atlasFallback<T>(toolName, args);
  }
}

export interface GatewayToolResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Call a gateway MCP tool AS a specific tenant — forwards the caller's own
 * `Authorization: Bearer <tenant api key>` header instead of the shared
 * system/local context `callGateway` uses, so tenant-scoped tools (e.g.
 * `brain_host_provision`) resolve the paying tenant, not the dashboard's
 * default/local one (`resolveTenant` in runtime/src/core/auth.ts accepts the
 * same Bearer key on the MCP transport as it does on REST).
 *
 * Unlike `callGateway`, this surfaces tool-level errors (the executor's
 * `isError` text, e.g. "plan has no hosted brain") instead of collapsing them
 * to `null`, so callers can show the caller *why* the action failed.
 */
export async function callGatewayAsTenant<T>(
  toolName: string,
  authHeader: string | null,
  args: Record<string, unknown> = {},
): Promise<GatewayToolResult<T>> {
  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: { ...gatewayHeaders(), ...(authHeader ? { Authorization: authHeader } : {}) },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: toolName, arguments: args },
        id: 1,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      if (res.status >= 500) {
        const data = await atlasFallback<T>(toolName, args);
        if (data !== null) return { ok: true, data };
      }
      return { ok: false, error: `gateway HTTP ${res.status}` };
    }
    const json = await res.json();
    if (json?.error) return { ok: false, error: json.error.message || 'gateway error' };
    const content = json?.result?.content;
    const textEntry = Array.isArray(content)
      ? content.find((c: { type: string }) => c.type === 'text')
      : undefined;
    if (!textEntry) return { ok: false, error: 'empty gateway response' };
    if (json.result.isError) {
      return { ok: false, error: String(textEntry.text ?? '').replace(/^Error:\s*/, '') };
    }
    try {
      return { ok: true, data: JSON.parse(textEntry.text) as T };
    } catch {
      return { ok: false, error: 'malformed gateway response' };
    }
  } catch (err) {
    const data = await atlasFallback<T>(toolName, args);
    if (data !== null) return { ok: true, data };
    return { ok: false, error: err instanceof Error ? err.message : 'gateway unreachable' };
  }
}

export interface RoutingConfig {
  tiers: Record<string, { provider: string; model: string; chain?: string[]; cacheable?: boolean; batchable?: boolean }>;
  agentMap: Record<string, string>;
  channelMap?: Record<string, string>;
  channelOverrides?: Record<string, { tier?: string; forceCache?: boolean; forceBatch?: boolean;[key: string]: unknown }>;
  toolMap?: Record<string, { tier?: string;[key: string]: unknown }>;
  complexityThreshold?: number;
  fableWindow?: { active: boolean; until: string; model: string };
}

export function fetchRoutingConfig(): Promise<RoutingConfig | null> {
  return callGateway<RoutingConfig>('routing_config');
}
