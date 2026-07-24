import { createChildLogger } from '../../shared/logger.js';
import { listSessions } from '../../core/session-manager.js';
import type { HookContext, HookResult } from '../types.js';

const log = createChildLogger({ module: 'hook:state-save' });

export async function stateSaveHook(ctx: HookContext): Promise<HookResult | void> {
  const activeSessions = listSessions('active');

  if (activeSessions.length > 0) {
    log.warn({
      activeSessions: activeSessions.length,
      sessionIds: activeSessions.map(s => s.id.slice(0, 8)),
    }, 'Sessions still active at shutdown — state persisted in MongoDB');
  } else {
    log.info('No active sessions — clean shutdown');
  }

  return {
    metadata: { activeSessions: activeSessions.length },
  };
}
