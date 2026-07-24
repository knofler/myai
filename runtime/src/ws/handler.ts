import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';
import { listAgents, getAgent } from '../agents/loader.js';
import { listSessions, getSession, exportSession, importSession, recallSessionContext } from '../core/session-manager.js';
import type { SessionExport } from '../core/session-manager.js';
import { routeMessage } from '../core/message-router.js';
import { WsIncoming } from '../shared/types.js';
import type { WsOutgoing } from '../shared/types.js';
import { authenticateWs } from '../core/auth.js';
import { rejectWsOnRegionMismatch } from '../core/region-guard.js';

const log = createChildLogger({ module: 'ws-handler' });

const clients = new Set<WebSocket>();
/** Per-socket tenant, set at connection (ADR-010 §3.2c). Drives broadcast scoping. */
const clientTenants = new WeakMap<WebSocket, string>();

function send(ws: WebSocket, msg: WsOutgoing): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Fan a message out to connected clients. When `tenantId` is given, ONLY
 * same-tenant sockets receive it (ADR-010 §3.2c CRITICAL — a global fan-out is
 * a cross-tenant leak once a 2nd tenant exists). Omitting `tenantId` keeps the
 * legacy all-clients behaviour for tenant-agnostic system events.
 */
function broadcast(msg: WsOutgoing, exclude?: WebSocket, tenantId?: string): void {
  for (const client of clients) {
    if (client === exclude || client.readyState !== WebSocket.OPEN) continue;
    if (tenantId !== undefined && clientTenants.get(client) !== tenantId) continue;
    client.send(JSON.stringify(msg));
  }
}

function handleMessage(ws: WebSocket, raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    send(ws, { type: 'error', error: 'Invalid JSON', timestamp: new Date().toISOString() });
    return;
  }

  const result = WsIncoming.safeParse(parsed);
  if (!result.success) {
    send(ws, { type: 'error', error: `Invalid message: ${result.error.message}`, timestamp: new Date().toISOString() });
    return;
  }

  const msg = result.data;

  switch (msg.type) {
    case 'ping':
      send(ws, { type: 'pong', timestamp: new Date().toISOString() });
      break;

    case 'agent.list': {
      const agents = listAgents();
      send(ws, {
        type: 'event',
        id: msg.id,
        data: {
          agents: agents.map(a => ({ name: a.name, description: a.description.slice(0, 200), category: a.category })),
        },
        timestamp: new Date().toISOString(),
      });
      break;
    }

    case 'agent.detail': {
      const agent = msg.agentName ? getAgent(msg.agentName) : undefined;
      if (!agent) {
        send(ws, { type: 'error', id: msg.id, error: `Agent "${msg.agentName}" not found`, timestamp: new Date().toISOString() });
        break;
      }
      send(ws, { type: 'event', id: msg.id, data: agent, timestamp: new Date().toISOString() });
      break;
    }

    case 'session.list': {
      // Scope to the connection's tenant so one tenant never sees another's
      // live sessions (ADR-010 §3.5).
      const sessions = listSessions(undefined, clientTenants.get(ws));
      send(ws, {
        type: 'event',
        id: msg.id,
        data: {
          sessions: sessions.map(s => ({
            id: s.id, agentName: s.agentName, status: s.status,
            messageCount: s.messages.length, lastActivity: s.lastActivity,
          })),
        },
        timestamp: new Date().toISOString(),
      });
      break;
    }

    case 'session.create': {
      if (!msg.agentName) {
        send(ws, { type: 'error', id: msg.id, error: 'agentName required', timestamp: new Date().toISOString() });
        break;
      }
      routeMessage(undefined, msg.agentName, msg.content || 'Session started', msg.metadata || {})
        .then(result => {
          send(ws, {
            type: 'event',
            id: msg.id,
            sessionId: result.sessionId,
            data: { sessionId: result.sessionId, agentName: result.agentName, response: result.response },
            timestamp: new Date().toISOString(),
          });
          // Broadcast session creation to other SAME-TENANT clients only.
          broadcast({
            type: 'event',
            data: { event: 'session.created', sessionId: result.sessionId, agentName: result.agentName },
            timestamp: new Date().toISOString(),
          }, ws, clientTenants.get(ws));
        })
        .catch(err => {
          send(ws, { type: 'error', id: msg.id, error: (err as Error).message, timestamp: new Date().toISOString() });
        });
      break;
    }

    case 'session.message': {
      if (!msg.sessionId || !msg.content) {
        send(ws, { type: 'error', id: msg.id, error: 'sessionId and content required', timestamp: new Date().toISOString() });
        break;
      }
      const session = getSession(msg.sessionId);
      if (!session) {
        send(ws, { type: 'error', id: msg.id, error: 'Session not found', timestamp: new Date().toISOString() });
        break;
      }
      routeMessage(msg.sessionId, session.agentName, msg.content, msg.metadata || {})
        .then(result => {
          send(ws, {
            type: 'event',
            id: msg.id,
            sessionId: result.sessionId,
            data: { messageId: result.message.id, response: result.response },
            timestamp: new Date().toISOString(),
          });
        })
        .catch(err => {
          send(ws, { type: 'error', id: msg.id, error: (err as Error).message, timestamp: new Date().toISOString() });
        });
      break;
    }

    case 'session.close': {
      if (!msg.sessionId) {
        send(ws, { type: 'error', id: msg.id, error: 'sessionId required', timestamp: new Date().toISOString() });
        break;
      }
      import('../core/session-manager.js').then(({ closeSession }) => {
        closeSession(msg.sessionId!)
          .then(() => {
            send(ws, { type: 'event', id: msg.id, data: { status: 'closed' }, timestamp: new Date().toISOString() });
          })
          .catch(err => {
            send(ws, { type: 'error', id: msg.id, error: (err as Error).message, timestamp: new Date().toISOString() });
          });
      });
      break;
    }

    case 'session.export': {
      // Export a session bundle so its context can follow the user to another
      // device (betaC context-sharing). Tenant-scoped to the connection.
      if (!msg.sessionId) {
        send(ws, { type: 'error', id: msg.id, error: 'sessionId required', timestamp: new Date().toISOString() });
        break;
      }
      const tenantId = clientTenants.get(ws)!;
      exportSession(tenantId, msg.sessionId)
        .then(bundle => {
          if (!bundle) {
            send(ws, { type: 'error', id: msg.id, error: 'Session not found', timestamp: new Date().toISOString() });
            return;
          }
          send(ws, { type: 'event', id: msg.id, sessionId: msg.sessionId, data: { bundle }, timestamp: new Date().toISOString() });
        })
        .catch(err => {
          send(ws, { type: 'error', id: msg.id, error: (err as Error).message, timestamp: new Date().toISOString() });
        });
      break;
    }

    case 'session.import': {
      // Rehydrate a bundle on this device — stamped with the connection's tenant.
      if (!msg.bundle) {
        send(ws, { type: 'error', id: msg.id, error: 'bundle required', timestamp: new Date().toISOString() });
        break;
      }
      const tenantId = clientTenants.get(ws)!;
      importSession(tenantId, msg.bundle as SessionExport, { preserveId: msg.preserveId })
        .then(session => {
          send(ws, {
            type: 'event', id: msg.id, sessionId: session.id,
            data: { sessionId: session.id, agentName: session.agentName, messageCount: session.messages.length },
            timestamp: new Date().toISOString(),
          });
          // Tell other same-tenant clients a session arrived from another device.
          broadcast({
            type: 'event',
            data: { event: 'session.imported', sessionId: session.id, agentName: session.agentName },
            timestamp: new Date().toISOString(),
          }, ws, tenantId);
        })
        .catch(err => {
          send(ws, { type: 'error', id: msg.id, error: (err as Error).message, timestamp: new Date().toISOString() });
        });
      break;
    }

    case 'session.recall': {
      // Recall recent cross-session context for the connection's tenant.
      const tenantId = clientTenants.get(ws)!;
      const m = msg.metadata || {};
      recallSessionContext(tenantId, {
        agentName: (m.agentName as string | undefined) ?? msg.agentName,
        limit: m.limit as number | undefined,
        perSessionMessages: m.perSessionMessages as number | undefined,
      })
        .then(result => {
          send(ws, { type: 'event', id: msg.id, data: result, timestamp: new Date().toISOString() });
        })
        .catch(err => {
          send(ws, { type: 'error', id: msg.id, error: (err as Error).message, timestamp: new Date().toISOString() });
        });
      break;
    }

    default:
      send(ws, { type: 'error', id: msg.id, error: `Unknown message type: ${msg.type}`, timestamp: new Date().toISOString() });
  }
}

/** Register an authenticated socket: track tenant, send welcome, wire handlers. */
function setupClient(ws: WebSocket, tenantId: string, clientIp: string): void {
  clientTenants.set(ws, tenantId);
  clients.add(ws);
  log.info({ clientIp, tenantId, clients: clients.size }, 'WebSocket client connected');

  // Send welcome
  send(ws, {
    type: 'event',
    data: { event: 'connected', message: 'Connected to myAI gateway' },
    timestamp: new Date().toISOString(),
  });

  ws.on('message', (data) => {
    handleMessage(ws, data.toString());
  });

  ws.on('close', () => {
    clients.delete(ws);
    clientTenants.delete(ws);
    log.info({ clients: clients.size }, 'WebSocket client disconnected');
  });

  ws.on('error', (err) => {
    log.error({ err }, 'WebSocket error');
    clients.delete(ws);
    clientTenants.delete(ws);
  });

  // Heartbeat
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);

  ws.on('close', () => clearInterval(pingInterval));
}

export function startWsServer(): WebSocketServer {
  const config = getConfig();

  const wss = new WebSocketServer({
    port: config.server.wsPort,
    host: config.server.host,
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const clientIp = req.socket.remoteAddress || 'unknown';

    // ADR-010 §3.2c: authenticate the upgrade. Bad key → reject (4401). Under
    // tenancy.enforce=false, no-key local connections resolve to the default
    // tenant (unchanged behaviour for the dashboard/runner).
    authenticateWs(req)
      .then((ctx) => {
        // ADR-023: reject a tenant pinned to a different region than this
        // gateway serves — inert unless GATEWAY_REGION + REGION_ENFORCE are set.
        if (rejectWsOnRegionMismatch(ws, req, ctx, config.region)) return;
        setupClient(ws, ctx.tenantId, clientIp);
      })
      .catch((err) => {
        log.warn({ clientIp, err: (err as Error).message }, 'WebSocket auth rejected');
        const tenancy = config.tenancy ?? { defaultTenantId: 'default', enforce: false };
        if (tenancy.enforce) {
          try { ws.close(4401, 'unauthorized'); } catch { /* already closed */ }
          return;
        }
        // enforce=false: never hard-fail a local operator; fall back to default tenant.
        setupClient(ws, tenancy.defaultTenantId, clientIp);
      });
  });

  log.info({ port: config.server.wsPort, host: config.server.host }, 'WebSocket server listening');
  return wss;
}

export function getClientCount(): number {
  return clients.size;
}
