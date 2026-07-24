import { createChildLogger } from '../shared/logger.js';
import type { HookEvent, HookContext, HookResult, HookRegistration } from './types.js';

const log = createChildLogger({ module: 'event-bus' });

const hooks: HookRegistration[] = [];

export function registerHook(registration: HookRegistration): void {
  hooks.push(registration);
  // Keep sorted by priority (lower = first)
  hooks.sort((a, b) => a.priority - b.priority);
  log.debug({ name: registration.name, events: registration.events, priority: registration.priority }, 'Hook registered');
}

export function unregisterHook(name: string): boolean {
  const idx = hooks.findIndex(h => h.name === name);
  if (idx === -1) return false;
  hooks.splice(idx, 1);
  return true;
}

export function enableHook(name: string, enabled: boolean): boolean {
  const hook = hooks.find(h => h.name === name);
  if (!hook) return false;
  hook.enabled = enabled;
  return true;
}

/**
 * Emit an event and run all matching hooks in priority order.
 * Returns aggregated result — if any hook blocks, the overall result blocks.
 */
export async function emit(event: HookEvent, ctx: Partial<HookContext> = {}): Promise<HookResult> {
  const context: HookContext = {
    event,
    timestamp: new Date(),
    metadata: {},
    ...ctx,
  };

  const matching = hooks.filter(h => h.enabled && h.events.includes(event));

  if (matching.length === 0) return {};

  let blocked = false;
  let blockReason = '';
  const aggregatedMetadata: Record<string, unknown> = {};

  for (const hook of matching) {
    try {
      const result = await runWithTimeout(hook, context);

      if (result?.metadata) {
        Object.assign(aggregatedMetadata, result.metadata);
      }

      if (result?.block) {
        blocked = true;
        blockReason = result.reason || `Blocked by hook: ${hook.name}`;
        log.warn({ hook: hook.name, event, reason: blockReason }, 'Hook blocked action');
        break; // Stop processing further hooks
      }
    } catch (err) {
      log.error({ hook: hook.name, event, err }, 'Hook execution failed');
      // Hook failures don't block by default — they just log
    }
  }

  return {
    block: blocked,
    reason: blockReason || undefined,
    metadata: Object.keys(aggregatedMetadata).length > 0 ? aggregatedMetadata : undefined,
  };
}

async function runWithTimeout(hook: HookRegistration, ctx: HookContext): Promise<HookResult | void> {
  if (hook.timeout <= 0) {
    return hook.handler(ctx);
  }

  return Promise.race([
    hook.handler(ctx),
    new Promise<HookResult>((_, reject) =>
      setTimeout(() => reject(new Error(`Hook "${hook.name}" timed out after ${hook.timeout}ms`)), hook.timeout),
    ),
  ]);
}

// ── Inspection ──────────────────────────────────────────

export function listHooks(): HookRegistration[] {
  return [...hooks];
}

export function getHookCount(): number {
  return hooks.length;
}

export function getHooksByEvent(event: HookEvent): HookRegistration[] {
  return hooks.filter(h => h.enabled && h.events.includes(event));
}
