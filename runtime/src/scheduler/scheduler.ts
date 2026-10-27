import cronParser from 'cron-parser';
import { findDueSchedules, recordRunResult, updateSchedule } from './schedule-store.js';
import { scheduleRunContext, scheduleTargetAllowed, scheduleTenantInactive, scheduleToolName } from './schedule-auth.js';

const { parseExpression } = cronParser;
import { executeTool } from '../mcp/tools.js';
import { createChildLogger } from '../shared/logger.js';
import type { ToolContext } from '../core/tenant-context.js';

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
      // scoped to the owning tenant, never cross-tenant. Only the operator's
      // (default tenant) schedules run as `system`; any other tenant's run as
      // that tenant (G5 N-1), so operator-only tools stay out of reach.
      const sctx: ToolContext = await scheduleRunContext(s.tenantId);
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

      const inactive = await scheduleTenantInactive(s.tenantId);
      if (inactive) {
        log.warn({ scheduleId: s.scheduleId, tenantId: s.tenantId, status: inactive }, 'schedule skipped — tenant is not active');
        await recordRunResult(s.tenantId, {
          scheduleId: s.scheduleId,
          status: 'error',
          error: `Skipped: tenant is ${inactive}`,
          nextRun,
          ranAt,
        });
        result.skipped++;
        continue;
      }

      if (!scheduleTargetAllowed(sctx, s.kind, s.target)) {
        // Saved before create-time checks existed, or the tool became
        // operator-only later. Refuse loudly and disable — never retry per minute.
        const tool = scheduleToolName(s.kind, s.target);
        log.error({ scheduleId: s.scheduleId, tenantId: s.tenantId, tool }, 'SECURITY: schedule targets a tool its tenant cannot use — refused and disabled');
        try {
          await recordRunResult(s.tenantId, {
            scheduleId: s.scheduleId,
            status: 'error',
            error: `Refused: tool ${tool} is not available to this tenant; schedule disabled`,
            nextRun: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            ranAt,
          });
          await updateSchedule(s.tenantId, { scheduleId: s.scheduleId, enabled: false });
        } catch (err) {
          log.error({ scheduleId: s.scheduleId, err }, 'could not disable refused schedule');
        }
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
