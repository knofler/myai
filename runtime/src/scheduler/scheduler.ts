import cronParser from 'cron-parser';
import { findDueSchedules, recordRunResult } from './schedule-store.js';

const { parseExpression } = cronParser;
import { executeTool } from '../mcp/tools.js';
import { createChildLogger } from '../shared/logger.js';
import { SYSTEM_CONTEXT, type ToolContext } from '../core/tenant-context.js';

const log = createChildLogger({ module: 'scheduler' });

export const DEFAULT_TICK_INTERVAL_MS = 60_000;

let intervalId: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/**
 * Compute the next fire time for a cron expression after `from`.
 * Throws if the expression is invalid — callers should validate first via `isValidCronExpr`.
 */
export function computeNextRun(cronExpr: string, from: Date = new Date()): Date {
  const interval = parseExpression(cronExpr, { currentDate: from });
  return interval.next().toDate();
}

export function isValidCronExpr(cronExpr: string): boolean {
  try {
    parseExpression(cronExpr);
    return true;
  } catch {
    return false;
  }
}

export interface TickResult {
  due: number;
  ran: number;
  failed: number;
  skipped: number;
}

/**
 * Run one tick of the scheduler: find due schedules and dispatch each.
 * Skips re-entry if a previous tick is still in flight.
 */
export async function tick(now: Date = new Date()): Promise<TickResult> {
  if (ticking) {
    log.warn('Tick re-entry skipped — previous tick still running');
    return { due: 0, ran: 0, failed: 0, skipped: 1 };
  }
  ticking = true;
  const result: TickResult = { due: 0, ran: 0, failed: 0, skipped: 0 };

  try {
    const due = await findDueSchedules(now);
    result.due = due.length;
    if (!due.length) return result;

    log.info({ count: due.length }, 'Dispatching due schedules');

    for (const s of due) {
      // Each schedule fires under ITS OWN tenant context — the per-minute sweep
      // spans tenants (findDueSchedules), but dispatch + bookkeeping must stay
      // scoped to the owning tenant, never cross-tenant.
      const sctx: ToolContext = { ...SYSTEM_CONTEXT, tenantId: s.tenantId };
      const ranAt = now;
      let nextRun: Date;
      try {
        nextRun = computeNextRun(s.cronExpr, ranAt);
      } catch (err) {
        log.error({ scheduleId: s.scheduleId, cronExpr: s.cronExpr, err }, 'Invalid cron — skipping');
        await recordRunResult(s.tenantId, {
          scheduleId: s.scheduleId,
          status: 'error',
          error: `Invalid cron: ${(err as Error).message}`,
          nextRun: new Date(now.getTime() + 60 * 60 * 1000), // park 1h to avoid hot loop
          ranAt,
        });
        result.failed++;
        continue;
      }

      try {
        let toolName: string;
        let args: Record<string, unknown>;
        if (s.kind === 'agent') {
          toolName = 'agents_invoke';
          args = { agent: s.target, message: s.message, repo: s.repo, includeMemoryContext: s.includeMemoryContext };
        } else if (s.kind === 'skill') {
          toolName = 'skills_invoke';
          args = { skill: s.target, message: s.message };
        } else {
          // kind === 'tool' — dispatch the named MCP tool directly with args parsed from message JSON.
          toolName = s.target;
          const rawMessage = typeof s.message === 'string' ? s.message.trim() : '';
          if (!rawMessage) {
            args = {};
          } else {
            let parsed: unknown;
            try {
              parsed = JSON.parse(rawMessage);
            } catch (parseErr) {
              await recordRunResult(s.tenantId, {
                scheduleId: s.scheduleId,
                status: 'error',
                error: `Tool args not valid JSON: ${(parseErr as Error).message}`,
                nextRun,
                ranAt,
              });
              result.failed++;
              continue;
            }
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              await recordRunResult(s.tenantId, {
                scheduleId: s.scheduleId,
                status: 'error',
                error: 'Tool args must be a JSON object literal (got array or primitive)',
                nextRun,
                ranAt,
              });
              result.failed++;
              continue;
            }
            args = parsed as Record<string, unknown>;
          }
        }

        const dispatch = await executeTool(toolName, args, sctx) as { content?: string; error?: string };

        if (dispatch && dispatch.error) {
          await recordRunResult(s.tenantId, {
            scheduleId: s.scheduleId,
            status: 'error',
            error: dispatch.error,
            nextRun,
            ranAt,
          });
          result.failed++;
        } else {
          // Prefer .content for agent/skill responses; fall back to JSON for tool responses.
          const summarySource = dispatch && typeof dispatch.content === 'string'
            ? dispatch.content
            : JSON.stringify(dispatch ?? {});
          await recordRunResult(s.tenantId, {
            scheduleId: s.scheduleId,
            status: 'success',
            summary: summarySource.slice(0, 200),
            nextRun,
            ranAt,
          });
          result.ran++;
        }
      } catch (err) {
        log.error({ scheduleId: s.scheduleId, err }, 'Schedule dispatch threw');
        await recordRunResult(s.tenantId, {
          scheduleId: s.scheduleId,
          status: 'error',
          error: (err as Error).message,
          nextRun,
          ranAt,
        });
        result.failed++;
      }
    }

    log.info(result, 'Tick complete');
    return result;
  } finally {
    ticking = false;
  }
}

export function startScheduler(intervalMs: number = DEFAULT_TICK_INTERVAL_MS): void {
  if (intervalId) {
    log.warn('Scheduler already running');
    return;
  }
  intervalId = setInterval(() => {
    tick().catch(err => log.error({ err }, 'Scheduler tick failed'));
  }, intervalMs);
  log.info({ intervalMs }, 'Scheduler started');
}

export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Scheduler stopped');
  }
}

export function isSchedulerRunning(): boolean {
  return intervalId !== null;
}
