/**
 * Autonomous agent task dispatch worker.
 *
 * Picks pending tasks from the queue, selects the appropriate specialist
 * agent based on task content, dispatches the agent, and records results.
 *
 * Designed to run as a scheduled job (daily at 06:05 UTC, after morning
 * sweep at 06:00) or on demand via MCP tool invocation.
 *
 * Budget safety: when `dailySpendCapUsd` is set, the worker queries today's
 * LLM spend via `budgets_status` and skips dispatch if the cap is exceeded.
 */

import { executeTool } from '../mcp/tools.js';
import { getAdapter } from '../channels/registry.js';
import { createChildLogger } from '../shared/logger.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';
import { DEFAULT_TENANT_ID } from '../shared/db.js';

const log = createChildLogger({ module: 'dispatch-worker' });

// ── Public types ────────────────────────────────────────────

export interface DispatchConfig {
  maxConcurrent?: number;          // default 1
  maxTasksPerCycle?: number;       // default 3
  autoSelectAgent?: boolean;       // map task source/priority to specialist
  telegramChatId?: string;
  /** Budget safety: skip dispatch if daily spend exceeds this (USD). */
  dailySpendCapUsd?: number;
}

export interface DispatchResult {
  tasksProcessed: number;
  tasksSucceeded: number;
  tasksFailed: number;
  tasksSkipped: number;
  totalCostUsd: number;
  details: Array<{
    taskId: string;
    repo: string;
    agent: string;
    status: 'success' | 'error' | 'skipped';
    error?: string;
    duration: number;
  }>;
}

// ── Task shape returned by tasks_list / tasks_next ──────────

interface TaskView {
  taskId: string;
  repo: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  assignedAgent?: string;
  recommendedModel?: string;
  source: string;
  sourceId?: string;
  notes?: string;
}

// ── Agent selection ─────────────────────────────────────────

/**
 * Keyword-to-agent mapping rules. Evaluated top-to-bottom; first match wins.
 * The default fallback is `solution-architect`.
 */
const AGENT_RULES: Array<{ pattern: RegExp; agent: string }> = [
  { pattern: /\bsecurity\b/,                                    agent: 'security-specialist' },
  { pattern: /\btest(?:s|ing)?\b|\bqa\b/,                       agent: 'qa-specialist' },
  { pattern: /\bui\b|\bfrontend\b|\bcomponent\b|\bpage\b/,      agent: 'frontend-specialist' },
  { pattern: /\bapi\b|\bendpoint\b|\broute\b/,                  agent: 'api-specialist' },
  { pattern: /\bdeploy\b|\bdocker\b|\bci\b/,                    agent: 'devops-specialist' },
  { pattern: /\bschema\b|\bdatabase\b|\bmongo\b/,               agent: 'database-specialist' },
];

const DEFAULT_AGENT = 'solution-architect';

/**
 * Select the best specialist agent for a task based on keyword matching
 * against the task's title, description, and notes.
 *
 * When `task.assignedAgent` is already set, it is returned as-is
 * (manual override).
 */
export function selectAgent(task: {
  title?: string;
  description?: string;
  notes?: string;
  assignedAgent?: string;
}): string {
  // Honour explicit assignment.
  if (task.assignedAgent) return task.assignedAgent;

  const haystack = [
    task.title ?? '',
    task.description ?? '',
    task.notes ?? '',
  ].join(' ').toLowerCase();

  for (const rule of AGENT_RULES) {
    if (rule.pattern.test(haystack)) {
      return rule.agent;
    }
  }

  return DEFAULT_AGENT;
}

// ── Budget check ────────────────────────────────────────────

async function isDailyBudgetExceeded(capUsd: number): Promise<boolean> {
  try {
    const status = await executeTool('budgets_status', {}) as {
      today?: number;
      enabled?: boolean;
    };
    if (typeof status?.today === 'number' && status.today >= capUsd) {
      log.warn({ today: status.today, cap: capUsd }, 'Daily spend cap exceeded — skipping dispatch');
      return true;
    }
    return false;
  } catch (err) {
    // If we cannot check the budget, allow dispatch to proceed
    // (consistent with budget-guard's fail-open philosophy).
    log.warn({ err }, 'Budget check failed — allowing dispatch');
    return false;
  }
}

// ── Prompt builder ──────────────────────────────────────────

function buildPrompt(task: TaskView): string {
  const parts: string[] = [];
  parts.push(`Task: ${task.title}`);
  if (task.description) {
    parts.push('');
    parts.push(`Description: ${task.description}`);
  }
  if (task.notes) {
    parts.push('');
    parts.push(`Notes: ${task.notes}`);
  }
  parts.push('');
  parts.push(`Repo: ${task.repo}`);
  parts.push(`Priority: ${task.priority}`);
  parts.push(`Source: ${task.source}${task.sourceId ? ` (${task.sourceId})` : ''}`);
  parts.push('');
  parts.push('Analyse this task and provide a concrete implementation plan or resolution. Be specific and actionable.');
  return parts.join('\n');
}

// ── Telegram notification ───────────────────────────────────

async function notifyTelegram(
  chatId: string,
  message: string,
): Promise<void> {
  const tg = getAdapter('telegram');
  if (!tg || !tg.enabled) return;
  try {
    await tg.send(chatId, message);
  } catch (err) {
    log.warn({ err, chatId }, 'Telegram notification failed');
  }
}

// ── Main dispatch cycle ─────────────────────────────────────

/**
 * Run one dispatch cycle: fetch pending tasks, dispatch agents, record results.
 *
 * Tasks are processed sequentially (maxConcurrent is reserved for a future
 * parallel dispatch lane but defaults to 1 today).
 */
export async function runDispatchCycle(config: DispatchConfig = {}): Promise<DispatchResult> {
  const maxTasksPerCycle = config.maxTasksPerCycle ?? 3;
  const autoSelectAgent = config.autoSelectAgent ?? true;
  const telegramChatId = config.telegramChatId ?? process.env.TELEGRAM_DEFAULT_CHAT;

  const result: DispatchResult = {
    tasksProcessed: 0,
    tasksSucceeded: 0,
    tasksFailed: 0,
    tasksSkipped: 0,
    totalCostUsd: 0,
    details: [],
  };

  log.info({ maxTasksPerCycle, autoSelectAgent }, 'Dispatch cycle starting');

  // Budget gate: if a daily cap is configured and exceeded, bail early.
  if (typeof config.dailySpendCapUsd === 'number' && config.dailySpendCapUsd > 0) {
    const exceeded = await isDailyBudgetExceeded(config.dailySpendCapUsd);
    if (exceeded) {
      log.info('Dispatch cycle skipped — daily budget cap exceeded');
      if (telegramChatId) {
        await notifyTelegram(
          telegramChatId,
          'Dispatch worker: skipped — daily LLM spend cap exceeded.',
        );
      }
      return result;
    }
  }

  // Fetch pending tasks, ordered by priority.
  let tasks: TaskView[];
  try {
    const listResult = await executeTool('tasks_list', {
      status: 'pending',
      limit: maxTasksPerCycle,
    }) as { tasks?: TaskView[]; count?: number };
    tasks = listResult?.tasks ?? [];
  } catch (err) {
    log.error({ err }, 'Failed to fetch pending tasks');
    return result;
  }

  if (tasks.length === 0) {
    log.info('No pending tasks — dispatch cycle complete');
    return result;
  }

  log.info({ count: tasks.length }, 'Pending tasks fetched');

  emitNotifyEvent({
    type: 'dispatch.started',
    tenantId: DEFAULT_TENANT_ID,
    title: `Dispatch cycle started — ${tasks.length} task(s)`,
    level: 'info',
    source: 'dispatch-worker',
    data: { taskCount: tasks.length },
  });

  for (const task of tasks) {
    result.tasksProcessed++;
    const startMs = Date.now();

    // Select agent.
    const agent = autoSelectAgent ? selectAgent(task) : (task.assignedAgent ?? DEFAULT_AGENT);

    // Mark task as working.
    try {
      await executeTool('tasks_update', {
        taskId: task.taskId,
        status: 'working',
        assignedAgent: agent,
      });
    } catch (err) {
      log.error({ taskId: task.taskId, err }, 'Failed to mark task as working');
      result.tasksFailed++;
      result.details.push({
        taskId: task.taskId,
        repo: task.repo,
        agent,
        status: 'error',
        error: `Failed to update status: ${(err as Error).message}`,
        duration: Date.now() - startMs,
      });
      continue;
    }

    // Re-check budget before each dispatch (spend accumulates).
    if (typeof config.dailySpendCapUsd === 'number' && config.dailySpendCapUsd > 0) {
      const exceeded = await isDailyBudgetExceeded(config.dailySpendCapUsd);
      if (exceeded) {
        // Revert task to pending.
        await executeTool('tasks_update', {
          taskId: task.taskId,
          status: 'pending',
          notes: 'Dispatch skipped — daily budget cap exceeded',
        }).catch(() => {});
        result.tasksSkipped++;
        result.details.push({
          taskId: task.taskId,
          repo: task.repo,
          agent,
          status: 'skipped',
          error: 'Daily budget cap exceeded',
          duration: Date.now() - startMs,
        });
        // Stop processing further tasks.
        break;
      }
    }

    // Build prompt and dispatch agent.
    const prompt = buildPrompt(task);

    try {
      const dispatch = await executeTool('agents_invoke', {
        agent,
        message: prompt,
        repo: task.repo,
        includeMemoryContext: true,
      }) as {
        content?: string;
        error?: string;
        costUsd?: number;
      };

      const durationMs = Date.now() - startMs;

      if (dispatch?.error) {
        // Agent invocation returned an error — mark task as blocked.
        await executeTool('tasks_update', {
          taskId: task.taskId,
          status: 'blocked',
          notes: `Agent error: ${dispatch.error}`,
        }).catch(() => {});

        result.tasksFailed++;
        result.details.push({
          taskId: task.taskId,
          repo: task.repo,
          agent,
          status: 'error',
          error: dispatch.error,
          duration: durationMs,
        });

        log.warn({ taskId: task.taskId, agent, error: dispatch.error }, 'Agent dispatch returned error');
      } else {
        // Success — mark task for review with agent's response summary.
        const summary = dispatch?.content?.slice(0, 500) ?? '';
        await executeTool('tasks_update', {
          taskId: task.taskId,
          status: 'review',
          notes: summary,
        }).catch(() => {});

        const costUsd = typeof dispatch?.costUsd === 'number' ? dispatch.costUsd : 0;
        result.totalCostUsd += costUsd;
        result.tasksSucceeded++;
        result.details.push({
          taskId: task.taskId,
          repo: task.repo,
          agent,
          status: 'success',
          duration: durationMs,
        });

        log.info({ taskId: task.taskId, agent, durationMs, costUsd }, 'Task dispatched successfully');
      }
    } catch (err) {
      const durationMs = Date.now() - startMs;

      // Dispatch threw — mark task as blocked.
      await executeTool('tasks_update', {
        taskId: task.taskId,
        status: 'blocked',
        notes: `Dispatch error: ${(err as Error).message}`,
      }).catch(() => {});

      result.tasksFailed++;
      result.details.push({
        taskId: task.taskId,
        repo: task.repo,
        agent,
        status: 'error',
        error: (err as Error).message,
        duration: durationMs,
      });

      log.error({ taskId: task.taskId, agent, err }, 'Agent dispatch threw');
    }

    // Telegram progress notification.
    if (telegramChatId) {
      const last = result.details[result.details.length - 1];
      const icon = last.status === 'success' ? 'Done' : last.status === 'error' ? 'Error' : 'Skipped';
      await notifyTelegram(
        telegramChatId,
        `Dispatch [${result.tasksProcessed}/${tasks.length}]: ${icon} — ${task.title} (${agent}, ${last.duration}ms)`,
      );
    }
  }

  log.info({
    processed: result.tasksProcessed,
    succeeded: result.tasksSucceeded,
    failed: result.tasksFailed,
    skipped: result.tasksSkipped,
    costUsd: result.totalCostUsd,
  }, 'Dispatch cycle complete');

  emitNotifyEvent({
    type: 'dispatch.completed',
    tenantId: DEFAULT_TENANT_ID,
    title: `Dispatch cycle complete — ${result.tasksSucceeded}/${result.tasksProcessed} succeeded`,
    message: `Failed: ${result.tasksFailed}, Skipped: ${result.tasksSkipped}, Cost: $${result.totalCostUsd.toFixed(4)}`,
    level: result.tasksFailed > 0 ? 'warning' : 'info',
    source: 'dispatch-worker',
    data: {
      processed: result.tasksProcessed,
      succeeded: result.tasksSucceeded,
      failed: result.tasksFailed,
      skipped: result.tasksSkipped,
      costUsd: result.totalCostUsd,
    },
  });

  // Final summary notification.
  if (telegramChatId && result.tasksProcessed > 0) {
    await notifyTelegram(
      telegramChatId,
      [
        `Dispatch cycle complete:`,
        `  Processed: ${result.tasksProcessed}`,
        `  Succeeded: ${result.tasksSucceeded}`,
        `  Failed: ${result.tasksFailed}`,
        `  Skipped: ${result.tasksSkipped}`,
        `  Cost: $${result.totalCostUsd.toFixed(4)}`,
      ].join('\n'),
    );
  }

  return result;
}

// ── Schedule registration ───────────────────────────────────

/**
 * Register a schedule entry for the dispatch worker to run daily at 06:05 UTC
 * (5 minutes after morning sweep at 06:00, giving the sweep time to finish
 * and surface priorities before tasks are dispatched).
 */
export async function registerDispatchSchedule(): Promise<unknown> {
  const schedule = await executeTool('schedules_create', {
    name: 'daily-dispatch-worker',
    cronExpr: '5 6 * * *',
    kind: 'tool',
    target: 'dispatch_cycle',
    message: '{}',
    enabled: true,
  });

  log.info('Dispatch schedule registered: daily at 06:05 UTC');
  return schedule;
}
