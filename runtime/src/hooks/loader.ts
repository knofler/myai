import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';
import { HookModel, isConnected } from '../shared/db.js';
import { getDbFailoverState } from '../shared/db-failover.js';
import { addBashHook, addHook } from './registry.js';
import { getHookCount, listHooks } from './event-bus.js';
import { readDisabledScripts } from './settings-patch.js';
import type { HookEvent } from './types.js';

// Built-in hooks
import { sessionIdentityHook } from './builtin/session-identity.js';
import { stateSaveHook } from './builtin/state-save.js';

const log = createChildLogger({ module: 'hook-loader' });

// Map Claude Code hook event types → gateway events
const BASH_EVENT_MAP: Record<string, HookEvent[]> = {
  'session': ['session:start'],
  'pre-tool': ['tool:before'],
  'post-tool': ['tool:after'],
  'stop': ['session:end'],
};

/**
 * Load all hooks: built-in TypeScript, then legacy bash hooks.
 */
export function loadAllHooks(): void {
  // 1. Built-in TypeScript hooks
  loadBuiltinHooks();

  // 2. Legacy bash hooks (if enabled)
  const config = getConfig();
  if (config.hooks.enableBashCompat) {
    loadBashHooks(config.hooks.bashHooksDir);
  }

  log.info({ total: getHookCount() }, 'Hooks loaded');
}

/**
 * Upsert all loaded hooks into MongoDB.
 */
export async function syncHooksToDatabase(): Promise<number> {
  if (!isConnected()) {
    log.warn('MongoDB not connected — skipping hook sync');
    return 0;
  }
  if (getDbFailoverState().active) {
    // bulkWrite bypasses the read-only guard plugin — skip explicitly.
    log.warn('READ-ONLY DB failover active — skipping hook sync (mirror must not diverge)');
    return 0;
  }

  const now = new Date();
  const allHooks = listHooks();

  const ops = allHooks.map(h => ({
    updateOne: {
      filter: { name: h.name },
      update: {
        $set: {
          name: h.name,
          events: h.events,
          priority: h.priority,
          timeout: h.timeout,
          enabled: h.enabled,
          source: h.source,
          loadedAt: now,
        },
      },
      upsert: true,
    },
  }));

  if (ops.length > 0) {
    const result = await HookModel.bulkWrite(ops);
    const count = result.upsertedCount + result.modifiedCount;

    // Remove hooks no longer loaded
    const hookNames = allHooks.map(h => h.name);
    await HookModel.deleteMany({ name: { $nin: hookNames } });

    log.info({ count }, 'Hooks synced to MongoDB');
    return count;
  }

  return 0;
}

function loadBuiltinHooks(): void {
  addHook('builtin:session-identity', ['session:start'], sessionIdentityHook, { source: 'builtin', priority: 10 });
  addHook('builtin:state-save', ['session:end'], stateSaveHook, { source: 'builtin', priority: 80 });
  log.debug('Built-in hooks registered');
}

function loadBashHooks(bashHooksDir: string): void {
  const config = getConfig();
  const absDir = resolve(config.aiRoot, bashHooksDir.replace(/^\.\.\//, ''));

  if (!existsSync(absDir)) {
    log.debug({ path: absDir }, 'Bash hooks directory not found — skipping');
    return;
  }

  let bashCount = 0;

  // Hooks parked in settings.json's disabledHooks key (dashboard toggle) are
  // still registered — visible + re-enableable — but never executed.
  const settingsPath = resolve(config.aiRoot, '.claude', 'settings.json');
  const disabledScripts = readDisabledScripts(settingsPath);

  for (const [subdir, events] of Object.entries(BASH_EVENT_MAP)) {
    const hookDir = join(absDir, subdir);
    if (!existsSync(hookDir)) continue;

    const scripts = readdirSync(hookDir)
      .filter(f => f.endsWith('.sh'))
      .sort();

    for (const script of scripts) {
      const scriptPath = join(hookDir, script);
      const name = `bash:${subdir}/${script}`;

      // Read the settings.json to find the timeout for this hook
      let timeout = config.hooks.defaultTimeout;
      try {
        if (existsSync(settingsPath)) {
          const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
          const hookGroups = settings.hooks?.[eventTypeKey(subdir)] ?? [];
          for (const group of hookGroups) {
            for (const h of group.hooks ?? []) {
              if (h.command?.includes(script)) {
                timeout = h.timeout ?? timeout;
              }
            }
          }
        }
      } catch {
        // Ignore settings parse errors — use default timeout
      }

      addBashHook(name, events, scriptPath, { timeout, enabled: !disabledScripts.has(`${subdir}/${script}`) });
      bashCount++;
    }
  }

  log.info({ count: bashCount, dir: absDir }, 'Bash hooks loaded');
}

/** Map subdir name to Claude Code settings.json key */
function eventTypeKey(subdir: string): string {
  switch (subdir) {
    case 'session': return 'SessionStart';
    case 'pre-tool': return 'PreToolUse';
    case 'post-tool': return 'PostToolUse';
    case 'stop': return 'Stop';
    default: return subdir;
  }
}
