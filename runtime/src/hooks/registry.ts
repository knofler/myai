import { execFile } from 'node:child_process';
import { registerHook } from './event-bus.js';
import { createChildLogger } from '../shared/logger.js';
import type { HookEvent, HookHandler, HookRegistration, HookContext, HookResult } from './types.js';

const log = createChildLogger({ module: 'hook-registry' });

/**
 * Register a TypeScript hook handler.
 */
export function addHook(
  name: string,
  events: HookEvent[],
  handler: HookHandler,
  options: { priority?: number; timeout?: number; source?: 'builtin' | 'user' } = {},
): void {
  const registration: HookRegistration = {
    name,
    events,
    handler,
    priority: options.priority ?? (options.source === 'builtin' ? 50 : 75),
    timeout: options.timeout ?? 5000,
    enabled: true,
    source: options.source ?? 'user',
  };
  registerHook(registration);
}

/**
 * Register a bash script as a hook (backward compatibility with existing 28 hooks).
 * The script is executed as a child process with the hook context as JSON on stdin.
 */
export function addBashHook(
  name: string,
  events: HookEvent[],
  command: string,
  options: { priority?: number; timeout?: number; enabled?: boolean } = {},
): void {
  const handler: HookHandler = async (ctx: HookContext): Promise<HookResult | void> => {
    return new Promise((resolve) => {
      const child = execFile('bash', ['-c', command], {
        timeout: options.timeout ?? 5000,
        env: {
          ...process.env,
          HOOK_EVENT: ctx.event,
          HOOK_SESSION_ID: ctx.sessionId ?? '',
          HOOK_AGENT_NAME: ctx.agentName ?? '',
          HOOK_TOOL_NAME: ctx.toolName ?? '',
        },
      }, (error, stdout, stderr) => {
        if (error) {
          // Exit code 2 = hook wants to block the action
          if (error.code === 2) {
            const reason = stderr.trim() || stdout.trim() || `Blocked by bash hook: ${name}`;
            resolve({ block: true, reason });
            return;
          }
          // Other errors are non-blocking
          log.warn({ hook: name, error: error.message, stderr: stderr.trim() }, 'Bash hook error');
          resolve();
          return;
        }

        // Log stdout if any
        const output = stdout.trim();
        if (output) {
          log.info({ hook: name, output }, 'Bash hook output');
        }

        resolve();
      });

      // Send context as JSON on stdin
      if (child.stdin) {
        child.stdin.write(JSON.stringify({
          event: ctx.event,
          sessionId: ctx.sessionId,
          agentName: ctx.agentName,
          toolName: ctx.toolName,
          metadata: ctx.metadata,
        }));
        child.stdin.end();
      }
    });
  };

  const registration: HookRegistration = {
    name,
    events,
    handler,
    priority: options.priority ?? 90,
    timeout: options.timeout ?? 5000,
    enabled: options.enabled ?? true,
    source: 'bash',
  };
  registerHook(registration);
}
