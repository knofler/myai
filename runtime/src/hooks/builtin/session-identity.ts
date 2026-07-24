import { hostname } from 'node:os';
import { getConfig } from '../../shared/config.js';
import { getAgentCount, getSkillCount } from '../../agents/loader.js';
import { getSessionCount } from '../../core/session-manager.js';
import { createChildLogger } from '../../shared/logger.js';
import type { HookContext, HookResult } from '../types.js';

const log = createChildLogger({ module: 'hook:session-identity' });

export async function sessionIdentityHook(ctx: HookContext): Promise<HookResult | void> {
  const config = getConfig();
  const machine = hostname();

  log.info({
    event: ctx.event,
    machine,
    aiRoot: config.aiRoot,
    agents: getAgentCount(),
    skills: getSkillCount(),
    sessions: getSessionCount(),
  }, `myAI gateway — ${machine} — ${getAgentCount()} agents, ${getSkillCount()} skills`);

  return {
    metadata: { machine, aiRoot: config.aiRoot },
  };
}
