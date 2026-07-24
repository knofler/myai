import { v4 as uuid } from 'uuid';
import { createSession, getSession, addMessage, closeSession } from '../core/session-manager.js';
import { executeAgent } from './runtime.js';
import { createChildLogger } from '../shared/logger.js';
import { DEFAULT_TENANT_ID } from '../shared/db.js';
import type { AgentExecuteOptions, AgentRunResult } from './runtime.js';
import type { GatewayMessage } from '../shared/types.js';

const log = createChildLogger({ module: 'agent-spawner' });

/**
 * Sub-agent dispatch (MYAI_GATEWAY Phase 6).
 *
 * A running agent session can spawn specialist sub-agents. Each spawn creates
 * a linked child session (metadata carries `parentSessionId` + `spawnDepth`),
 * executes the sub-agent through the in-gateway runtime, records the exchange
 * on the child session, and closes it.
 *
 * Hard limits (per plan):
 *   - `MAX_SPAWN_DEPTH` = 3 — a chain parent → child → grandchild is the deepest allowed.
 *   - `MAX_CONCURRENT_PER_PARENT` = 3 — at most 3 in-flight sub-agents per parent session.
 */
export const MAX_SPAWN_DEPTH = 3;
export const MAX_CONCURRENT_PER_PARENT = 3;

/** In-flight spawn count per parent session id. */
const activeSpawns = new Map<string, number>();

export function getActiveSpawnCount(parentSessionId: string): number {
  return activeSpawns.get(parentSessionId) ?? 0;
}

export interface SpawnRequest {
  parentSessionId: string;
  agentName: string;
  task: string;
  /** Defaults to the parent session's tenant, else the default tenant. */
  tenantId?: string;
  options?: AgentExecuteOptions;
}

export interface SpawnResult extends AgentRunResult {
  childSessionId: string;
  parentSessionId: string;
  depth: number;
}

/**
 * Spawn a sub-agent under a parent session and run it to completion.
 * Throws when the depth or concurrency limit would be exceeded.
 */
export async function spawnSubAgent(req: SpawnRequest): Promise<SpawnResult> {
  const parent = getSession(req.parentSessionId);

  // Depth: the parent's own spawnDepth (0 for a top-level session) + 1.
  const parentDepth = typeof parent?.metadata?.spawnDepth === 'number' ? parent.metadata.spawnDepth : 0;
  const depth = parentDepth + 1;
  if (depth > MAX_SPAWN_DEPTH) {
    throw new Error(`Max sub-agent depth (${MAX_SPAWN_DEPTH}) exceeded for session ${req.parentSessionId}`);
  }

  const inFlight = getActiveSpawnCount(req.parentSessionId);
  if (inFlight >= MAX_CONCURRENT_PER_PARENT) {
    throw new Error(`Max concurrent sub-agents (${MAX_CONCURRENT_PER_PARENT}) reached for session ${req.parentSessionId}`);
  }
  activeSpawns.set(req.parentSessionId, inFlight + 1);

  const tenantId = req.tenantId ?? parent?.tenantId ?? DEFAULT_TENANT_ID;

  try {
    const child = await createSession(tenantId, req.agentName, {
      parentSessionId: req.parentSessionId,
      spawnDepth: depth,
      spawned: true,
    });

    log.info({
      parentSessionId: req.parentSessionId,
      childSessionId: child.id,
      agentName: req.agentName,
      depth,
    }, 'Sub-agent spawned');

    const taskMessage: GatewayMessage = {
      id: uuid(),
      sessionId: child.id,
      role: 'user',
      content: req.task,
      agentName: req.agentName,
      metadata: { spawned: true },
      timestamp: new Date(),
    };
    await addMessage(child.id, taskMessage);

    const result = await executeAgent(req.agentName, req.task, {
      ...req.options,
      sessionId: child.id,
    });

    const responseMessage: GatewayMessage = {
      id: uuid(),
      sessionId: child.id,
      role: 'assistant',
      content: result.output,
      agentName: req.agentName,
      metadata: { spawned: true, executed: result.executed, provider: result.provider },
      timestamp: new Date(),
    };
    await addMessage(child.id, responseMessage);

    await closeSession(child.id);

    return {
      ...result,
      childSessionId: child.id,
      parentSessionId: req.parentSessionId,
      depth,
    };
  } finally {
    const remaining = getActiveSpawnCount(req.parentSessionId) - 1;
    if (remaining <= 0) activeSpawns.delete(req.parentSessionId);
    else activeSpawns.set(req.parentSessionId, remaining);
  }
}
