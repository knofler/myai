import express from 'express';
import type { Request, Response } from 'express';
import { createChildLogger } from '../shared/logger.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { buildContextBundle } from './context-bundle.js';
import { authenticate, ctxFromReq } from '../core/auth.js';
import { filterToolsForTenant } from '../core/rbac.js';
import { tenantQuota } from '../core/tenant-quota.js';
import { regionGuard } from '../core/region-guard.js';
import { tenantDbGuard } from '../shared/tenant-db-registry.js';
import { getConfig } from '../shared/config.js';
import { type ToolContext, SYSTEM_CONTEXT, AuthError } from '../core/tenant-context.js';
import { IDEMPOTENT_TOOLS, lookupIdempotency, storeIdempotency } from '../core/idempotency-store.js';

const log = createChildLogger({ module: 'mcp-handler' });

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'myai-framework';
const SERVER_VERSION = '0.1.0';

// ── JSON-RPC Types ────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── MCP Request Handler ───────────────────────────────────

export async function handleMcpRequest(
  req: JsonRpcRequest,
  ctx: ToolContext = SYSTEM_CONTEXT,
  idempotencyKey?: string,
): Promise<JsonRpcResponse> {
  log.debug({ method: req.method, id: req.id }, 'MCP request');

  switch (req.method) {
    case 'initialize': {
      // betaC auto-boot: force-load a TIGHT context bundle into cooperating MCP
      // clients via the standard `instructions` field. Best-effort — assembly
      // never throws, and a disabled/empty bundle simply omits the field so the
      // handshake is byte-identical to pre-betaC behaviour. See context-bundle.ts.
      let instructions: string | undefined;
      try {
        instructions = await buildContextBundle(ctx.tenantId);
      } catch (err) {
        log.warn({ err }, 'betaC auto-boot bundle skipped');
      }
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
          },
          ...(instructions ? { instructions } : {}),
        },
      };
    }

    case 'notifications/initialized':
      // Client acknowledgement — no response needed for notifications
      return { jsonrpc: '2.0', id: req.id ?? null, result: {} };

    case 'tools/list':
      // Per-org MCP tool visibility (Wave-2 #15): hide operator-only /
      // org-denylisted tools from tools/list so a restricted tenant never
      // even sees them advertised (core/rbac.ts filterToolsForTenant).
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        result: {
          tools: filterToolsForTenant(ctx, TOOL_DEFINITIONS),
        },
      };

    case 'tools/call': {
      const params = req.params || {};
      const toolName = params.name as string;
      const toolArgs = (params.arguments || {}) as Record<string, unknown>;

      if (!toolName) {
        return {
          jsonrpc: '2.0',
          id: req.id ?? null,
          error: { code: -32602, message: 'Missing tool name' },
        };
      }

      const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
      if (!toolDef) {
        return {
          jsonrpc: '2.0',
          id: req.id ?? null,
          error: { code: -32602, message: `Unknown tool: ${toolName}` },
        };
      }

      // Idempotency (dedup tasks_create/plan_set retries + double-clicks): a
      // client-supplied Idempotency-Key on one of IDEMPOTENT_TOOLS replays the
      // first response for this (tenant, tool, key) instead of re-running the
      // tool. Absent header or a non-idempotent tool → unchanged behaviour.
      const useIdempotency = Boolean(idempotencyKey) && IDEMPOTENT_TOOLS.has(toolName);
      if (useIdempotency) {
        const lookup = lookupIdempotency(ctx.tenantId, toolName, idempotencyKey!, toolArgs);
        if (lookup.status === 'hit') {
          return { jsonrpc: '2.0', id: req.id ?? null, result: lookup.response };
        }
        if (lookup.status === 'conflict') {
          return {
            jsonrpc: '2.0',
            id: req.id ?? null,
            error: { code: -32602, message: 'Idempotency-Key already used with a different request' },
          };
        }
      }

      try {
        const result = await executeTool(toolName, toolArgs, ctx);
        const rpcResult = {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
        if (useIdempotency) {
          storeIdempotency(ctx.tenantId, toolName, idempotencyKey!, toolArgs, rpcResult);
        }
        return {
          jsonrpc: '2.0',
          id: req.id ?? null,
          result: rpcResult,
        };
      } catch (err) {
        if (err instanceof AuthError) {
          // RBAC/auth denial (ADR-013 §3): a structured 403/401-equivalent
          // JSON-RPC error — code -32003 forbidden / -32001 unauthorized, with
          // the HTTP status + stable code in `data` — instead of the generic
          // isError text blob, so clients can branch on the denial.
          log.warn({ tool: toolName, code: err.code, status: err.status }, 'Tool call denied');
          return {
            jsonrpc: '2.0',
            id: req.id ?? null,
            error: {
              code: err.status === 403 ? -32003 : -32001,
              message: err.message,
              data: { httpStatus: err.status, code: err.code, tool: toolName },
            },
          };
        }
        log.error({ err, tool: toolName }, 'Tool execution failed');
        return {
          jsonrpc: '2.0',
          id: req.id ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: `Error: ${(err as Error).message}`,
              },
            ],
            isError: true,
          },
        };
      }
    }

    case 'ping':
      return { jsonrpc: '2.0', id: req.id ?? null, result: {} };

    default:
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}

// ── Express Router ────────────────────────────────────────

export function createMcpRouter(): express.Router {
  const router = express.Router();

  // MCP Streamable HTTP — POST /mcp
  router.post('/', async (req: Request, res: Response) => {
    try {
      const body = req.body as JsonRpcRequest;

      if (!body.jsonrpc || body.jsonrpc !== '2.0' || !body.method) {
        return res.status(400).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid JSON-RPC request' },
        });
      }

      const idempotencyKey = req.get('Idempotency-Key') || undefined;
      const response = await handleMcpRequest(body, ctxFromReq(req), idempotencyKey);
      res.json(response);
    } catch (err) {
      log.error({ err }, 'MCP handler error');
      res.status(500).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'Internal error' },
      });
    }
  });

  // MCP discovery — GET /mcp (optional, for debugging)
  router.get('/', (_req: Request, res: Response) => {
    res.json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      protocolVersion: MCP_PROTOCOL_VERSION,
      transport: 'streamable-http',
      tools: TOOL_DEFINITIONS.length,
      toolNames: TOOL_DEFINITIONS.map(t => t.name),
    });
  });

  return router;
}

/**
 * Create and start a standalone MCP Express server on the given port.
 */
export function startMcpServer(port: number, host: string = '0.0.0.0'): void {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // ADR-010 §3.2(b) CRITICAL: the MCP listener was previously unauthenticated.
  // Resolve a tenant on every POST /mcp; the read-only GET /mcp discovery and
  // /health stay exempt. Under tenancy.enforce=false, loopback/local callers
  // (Claude Code, the runner) resolve to the default tenant — no behaviour change.
  app.use(authenticate({ exemptGet: true, exemptPaths: new Set(['/health']) }));
  // Per-tenant rate limit + monthly quota (ADR-010 abuse/DoS guard). Inert for
  // local/loopback callers and unlimited plans — see core/tenant-quota.ts.
  app.use(tenantQuota());
  // Data-residency region guard (ADR-023) — the MCP surface is where the
  // runner's tasks_claim lands (the "off-hours execution" half of region
  // pinning), so it MUST be gated here too, not only on REST.
  app.use(regionGuard(() => getConfig().region));
  // Physical DB isolation chokepoint (ADR-030 §2) — same placement as REST
  // (core/middleware.ts): after auth, before any tool/store call. Inert no-op
  // for the shared-tier majority; only rejects a dedicated-tier tenant with
  // no provisioned binding yet.
  app.use(tenantDbGuard());
  app.use('/mcp', createMcpRouter());

  // Health endpoint for MCP server
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', server: SERVER_NAME, version: SERVER_VERSION });
  });

  app.listen(port, host, () => {
    log.info({ port, host }, 'MCP server listening');
  });
}
