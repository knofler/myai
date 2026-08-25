/**
 * AsyncAPI 3.0 spec for the gateway WebSocket event surface (GATEWAY_WS_ASYNCAPI,
 * task-c3abf505). Hand-authored as a plain object literal (no spec-generation
 * library), same convention as core/openapi.ts for the REST surface.
 *
 * Covers the single bidirectional connection on `ws://<host>:<wsPort>`
 * (ws/handler.ts):
 *   - client → server "commands" (session/agent RPCs + ping), driven by the
 *     `WsIncoming` zod schema in shared/types.ts;
 *   - server → client "events", which is two families on the wire:
 *       1. request-scoped replies (`event`/`error`/`pong`, correlated by `id`), and
 *       2. unsolicited task/plan/runner lifecycle pushes — the notify bus
 *          (notifications/event-bus.ts) events task-store.ts, plan-store.ts, and
 *          runner-lease-store.ts already emit, now also re-broadcast on this
 *          channel (ws/handler.ts `toLifecycleMessage`/`subscribeLifecycleEvents`),
 *          tenant-scoped exactly like the session-lifecycle broadcasts already on
 *          this channel (ADR-010 §3.2c).
 *
 * LIFECYCLE_EVENT_TYPES (ws/handler.ts) is imported directly so the message
 * catalog below can never drift silently out of sync with the actual allowlist
 * the runtime broadcasts — the hardening goal for this seam (GRAND_PRODUCT §3.2).
 *
 * Exposed via GET /api/asyncapi.json (core/server.ts), alongside the existing
 * GET /api/openapi.json REST reference.
 */
import { LIFECYCLE_EVENT_TYPES } from '../ws/handler.js';

type Obj = Record<string, unknown>;

function ref(name: string): Obj {
  return { $ref: `#/components/schemas/${name}` };
}

function msgRef(name: string): Obj {
  return { $ref: `#/components/messages/${name}` };
}

// ── Shared field schemas ──────────────────────────────────────

const idField: Obj = { type: 'string', description: 'Client-supplied correlation id, echoed back verbatim on the matching reply.' };
const timestampField: Obj = { type: 'string', format: 'date-time' };

// ── components/schemas ─────────────────────────────────────────

const schemas: Obj = {
  TaskLifecycleData: {
    type: 'object',
    description: 'Payload shared by task.created/task.updated/task.completed/task.dead_letter — mirrors tasks/task-store.ts emitNotifyEvent() call sites.',
    required: ['taskId', 'repo', 'status'],
    properties: {
      taskId: { type: 'string' },
      repo: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'working', 'review', 'done', 'blocked', 'dead_letter'] },
      prevStatus: { type: 'string' },
      priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
      claimedBy: { type: 'string' },
    },
    additionalProperties: true,
  },
  PlanUpdatedData: {
    type: 'object',
    description: 'plan.updated payload — repos/plan-store.ts setPlan()/setPlanDayStatus().',
    required: ['repo'],
    properties: {
      repo: { type: 'string' },
      planId: { type: 'string' },
      day: { type: 'integer' },
      status: { type: 'string' },
    },
    additionalProperties: true,
  },
  RunnerFiredData: {
    type: 'object',
    description: 'runner.fired payload — tasks/runner-lease-store.ts acquireLease().',
    required: ['repo'],
    properties: {
      repo: { type: 'string' },
      taskId: { type: 'string' },
      lane: { type: 'string' },
      claimedBy: { type: 'string' },
    },
    additionalProperties: true,
  },
  ErrorPayload: {
    type: 'object',
    required: ['type', 'error', 'timestamp'],
    properties: {
      type: { type: 'string', const: 'error' },
      id: idField,
      error: { type: 'string' },
      timestamp: timestampField,
    },
  },
  PongPayload: {
    type: 'object',
    required: ['type', 'timestamp'],
    properties: {
      type: { type: 'string', const: 'pong' },
      timestamp: timestampField,
    },
  },
};

// ── components/messages ────────────────────────────────────────

/** One client→server command message per WsMessageType (shared/types.ts WsIncoming, minus ping/pong/error/event). */
function commandMessage(name: string, wsType: string, summary: string, extraRequired: string[] = []): [string, Obj] {
  return [
    name,
    {
      name: wsType,
      title: name,
      summary,
      payload: {
        type: 'object',
        required: ['type', ...extraRequired],
        properties: {
          type: { type: 'string', const: wsType },
          id: idField,
          sessionId: { type: 'string' },
          agentName: { type: 'string' },
          content: { type: 'string' },
          metadata: { type: 'object', additionalProperties: true },
          bundle: { description: 'Session export bundle (session.import only).' },
          preserveId: { type: 'boolean' },
        },
      },
    },
  ];
}

/** One server→client lifecycle-event message per LIFECYCLE_EVENT_TYPES entry. */
function lifecycleMessage(eventType: string, dataSchemaName: string, summary: string): [string, Obj] {
  const camel = eventType.replace(/[._](\w)/g, (_, c: string) => c.toUpperCase());
  const name = `${camel.charAt(0).toUpperCase()}${camel.slice(1)}Event`;
  return [
    name,
    {
      name: eventType,
      title: name,
      summary,
      payload: {
        type: 'object',
        required: ['type', 'data', 'timestamp'],
        properties: {
          type: { type: 'string', const: 'event' },
          timestamp: timestampField,
          data: {
            allOf: [
              {
                type: 'object',
                required: ['event'],
                properties: {
                  event: { type: 'string', const: eventType },
                  title: { type: 'string' },
                  message: { type: 'string' },
                },
              },
              ref(dataSchemaName),
            ],
          },
        },
      },
    },
  ];
}

const LIFECYCLE_MESSAGE_SPECS: Record<(typeof LIFECYCLE_EVENT_TYPES)[number], [string, string]> = {
  'task.created': ['TaskLifecycleData', 'A new task was queued.'],
  'task.updated': ['TaskLifecycleData', 'A task changed status (excluding terminal completion/dead-letter).'],
  'task.completed': ['TaskLifecycleData', 'A task reached status "done".'],
  'task.dead_letter': ['TaskLifecycleData', 'A task exhausted its retry budget and needs operator triage.'],
  'plan.updated': ['PlanUpdatedData', "A repo's plan or plan-day status changed."],
  'runner.fired': ['RunnerFiredData', 'A runner claimed a lease slot and started working a task.'],
};

const messageEntries: Array<[string, Obj]> = [
  // client → server
  commandMessage('Ping', 'ping', 'Liveness probe; server replies with pong.'),
  commandMessage('AgentList', 'agent.list', 'List registered specialist agents.'),
  commandMessage('AgentDetail', 'agent.detail', 'Fetch one agent definition by name.', ['agentName']),
  commandMessage('SessionCreate', 'session.create', 'Start a new agent session and route the first message.', ['agentName']),
  commandMessage('SessionMessage', 'session.message', 'Route a follow-up message into an existing session.', ['sessionId', 'content']),
  commandMessage('SessionClose', 'session.close', 'Close a session.', ['sessionId']),
  commandMessage('SessionList', 'session.list', "List the caller tenant's sessions."),
  commandMessage('SessionExport', 'session.export', 'Export a session bundle for cross-device context sharing (betaC).', ['sessionId']),
  commandMessage('SessionImport', 'session.import', 'Rehydrate an exported session bundle on this device.', ['bundle']),
  commandMessage('SessionRecall', 'session.recall', 'Recall recent cross-session context for the caller tenant.'),
  // server → client, request-scoped replies
  ['Pong', { name: 'pong', title: 'Pong', summary: 'Reply to a ping command.', payload: ref('PongPayload') }],
  ['Error', { name: 'error', title: 'Error', summary: 'Reply when a command is malformed or fails; `id` echoes the request when present.', payload: ref('ErrorPayload') }],
  [
    'SessionEvent',
    {
      name: 'event',
      title: 'SessionEvent',
      summary: 'Reply to a session/agent command, OR an unsolicited same-tenant broadcast for "connected", "session.created", "session.imported".',
      payload: {
        type: 'object',
        required: ['type', 'data', 'timestamp'],
        properties: {
          type: { type: 'string', const: 'event' },
          id: idField,
          sessionId: { type: 'string' },
          data: { type: 'object', additionalProperties: true },
          timestamp: timestampField,
        },
      },
    },
  ],
  // server → client, unsolicited fleet-lifecycle pushes (the hardened seam)
  ...LIFECYCLE_EVENT_TYPES.map((eventType) => {
    const [dataSchema, summary] = LIFECYCLE_MESSAGE_SPECS[eventType];
    return lifecycleMessage(eventType, dataSchema, summary);
  }),
];

const messages: Obj = Object.fromEntries(messageEntries);

// ── channels / operations ──────────────────────────────────────

const clientToServerMessageNames = [
  'Ping', 'AgentList', 'AgentDetail', 'SessionCreate', 'SessionMessage',
  'SessionClose', 'SessionList', 'SessionExport', 'SessionImport', 'SessionRecall',
];

const serverToClientMessageNames = [
  'Pong', 'Error', 'SessionEvent',
  ...LIFECYCLE_EVENT_TYPES.map((t) => {
    const camel = t.replace(/[._](\w)/g, (_, c: string) => c.toUpperCase());
    return `${camel.charAt(0).toUpperCase()}${camel.slice(1)}Event`;
  }),
];

export function buildAsyncApiSpec(): Record<string, unknown> {
  return {
    asyncapi: '3.0.0',
    info: {
      title: 'myAI Gateway WebSocket Events',
      version: '0.1.0',
      description:
        'Event surface of the single bidirectional WS connection the gateway exposes on `wsPort` ' +
        '(ws/handler.ts). Two message families ride the same connection: client-issued session/agent ' +
        'commands with request-scoped replies (event/error/pong correlated by `id`), and unsolicited ' +
        'task/plan/runner lifecycle pushes fanned out from the internal notify bus ' +
        '(notifications/event-bus.ts) — the same events task-store.ts, plan-store.ts, and ' +
        'runner-lease-store.ts already emit for the SSE/webhook channels, now also on this one. ' +
        'Every push (session or lifecycle) is tenant-scoped: a socket only ever receives events for the ' +
        'tenant it authenticated as (ADR-010 §3.2c) — never a cross-tenant broadcast.',
    },
    defaultContentType: 'application/json',
    servers: {
      gateway: {
        host: 'localhost:{port}',
        protocol: 'ws',
        description: 'Local gateway WS port (GATEWAY_WS_PORT, default 3201). Auth: `Sec-WebSocket-Protocol: myai-key.<key>` header, or `?api_key=<key>` query param; loopback callers with no key resolve to the local default tenant.',
        variables: {
          port: { default: '3201' },
        },
      },
    },
    channels: {
      gatewayConnection: {
        address: '/',
        description: 'The single WS connection. Commands and events share this one channel/socket.',
        messages: Object.fromEntries(
          [...clientToServerMessageNames, ...serverToClientMessageNames].map((n) => [n, msgRef(n)]),
        ),
      },
    },
    operations: {
      sendCommand: {
        action: 'send',
        channel: { $ref: '#/channels/gatewayConnection' },
        summary: 'Client issues a session/agent command.',
        messages: clientToServerMessageNames.map((n) => msgRef(n)),
      },
      receiveEvent: {
        action: 'receive',
        channel: { $ref: '#/channels/gatewayConnection' },
        summary: 'Client receives a command reply, or an unsolicited same-tenant lifecycle push.',
        messages: serverToClientMessageNames.map((n) => msgRef(n)),
      },
    },
    components: {
      messages,
      schemas,
    },
  };
}
