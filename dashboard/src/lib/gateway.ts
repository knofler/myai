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
    if (!res.ok) return null;
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
    return null;
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
