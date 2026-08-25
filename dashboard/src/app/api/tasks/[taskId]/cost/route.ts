// GET /api/tasks/[taskId]/cost — per-task cost + duration detail (per-task ROI).
// Joins three tenant-scoped sources into one read for the /work drill-in drawer:
//   • Task doc            → status, retry ledger, routed model, start/end stamps
//   • UsageEvent meter    → task.executed (durationSec/premium/finalStatus) +
//                           offhours.minutes (metered wall-clock), keyed by taskId
//   • BudgetUsage meter   → token spend + model + $ per LLM call. BudgetUsage is
//                           NOT taskId-keyed (the runner lane bills the Claude
//                           subscription, the gateway lane meters per call), so
//                           spend is attributed by repo + run window — every
//                           metered call on this task's repo between startedAt
//                           and completedAt(+tail). Labeled in the response
//                           (`attribution`) so the UI can say so honestly.
import { NextResponse } from 'next/server';
import { connectDB, Task, UsageEvent, BudgetUsage } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** Grace after completedAt: the meter row for a call in flight at task close
 *  lands a moment later (fire-and-forget write). */
const WINDOW_TAIL_MS = 2 * 60 * 1000;

interface TaskLean {
  taskId: string;
  repo?: string;
  title?: string;
  status?: string;
  assignedAgent?: string;
  executionLane?: string;
  executionProvider?: string;
  routedModel?: string;
  routedProfile?: string;
  retryCount?: number;
  maxRetries?: number;
  startedAt?: Date;
  completedAt?: Date;
  updatedAt?: Date;
}

interface UsageEventLean {
  type: string;
  quantity?: number;
  metadata?: Record<string, unknown>;
}

interface ModelRow {
  _id: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
}

const TERMINAL = new Set(['review', 'done', 'blocked', 'dead_letter']);

export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  await connectDB();
  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);

  const task = await Task.findOne({ ...tf, taskId })
    .select('taskId repo title status assignedAgent executionLane executionProvider routedModel routedProfile retryCount maxRetries startedAt completedAt updatedAt -_id')
    .lean() as unknown as TaskLean | null;
  if (!task) return NextResponse.json({ error: 'task not found' }, { status: 404 });

  const events = await UsageEvent.find({ ...tf, taskId })
    .select('type quantity unit source occurredAt metadata -_id')
    .lean() as unknown as UsageEventLean[];

  const executed = events.find((e) => e.type === 'task.executed');
  const offhours = events.find((e) => e.type === 'offhours.minutes');

  // Wall-clock: the meter's durationSec (stamped on the working→terminal edge)
  // is authoritative; the task's own timestamps are the fallback.
  const startedAt = task.startedAt ? new Date(task.startedAt) : undefined;
  const endedAt = task.completedAt
    ? new Date(task.completedAt)
    : task.status && TERMINAL.has(task.status) && task.updatedAt
      ? new Date(task.updatedAt)
      : undefined;
  const meteredSec = typeof executed?.metadata?.durationSec === 'number' ? executed.metadata.durationSec : undefined;
  const computedSec = startedAt && endedAt
    ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000))
    : undefined;
  const durationSec = meteredSec ?? computedSec;

  // Token spend — repo + run-window attribution over the resource meter.
  let attribution: 'repo-window' | 'none' = 'none';
  let windowFrom: string | undefined;
  let windowTo: string | undefined;
  let byModel: Array<{ model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }> = [];
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0 };

  if (task.repo && startedAt) {
    const windowEnd = endedAt ? new Date(endedAt.getTime() + WINDOW_TAIL_MS) : new Date();
    attribution = 'repo-window';
    windowFrom = startedAt.toISOString();
    windowTo = windowEnd.toISOString();
    const rows = await BudgetUsage.aggregate([
      { $match: { ...tf, repo: task.repo, createdAt: { $gte: startedAt, $lte: windowEnd } } },
      {
        $group: {
          _id: '$model',
          calls: { $sum: 1 },
          inputTokens: { $sum: '$inputTokens' },
          outputTokens: { $sum: '$outputTokens' },
          cacheCreationInputTokens: { $sum: { $ifNull: ['$cacheCreationInputTokens', 0] } },
          cacheReadInputTokens: { $sum: { $ifNull: ['$cacheReadInputTokens', 0] } },
          costUsd: { $sum: '$costUsd' },
        },
      },
      { $sort: { costUsd: -1, calls: -1 } },
    ]) as ModelRow[];
    for (const r of rows) {
      totals.calls += r.calls;
      totals.inputTokens += r.inputTokens;
      totals.outputTokens += r.outputTokens;
      totals.cacheCreationInputTokens += r.cacheCreationInputTokens;
      totals.cacheReadInputTokens += r.cacheReadInputTokens;
      totals.costUsd += r.costUsd;
    }
    byModel = rows.map((r) => ({
      model: r._id ?? 'unknown',
      calls: r.calls,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costUsd: r.costUsd,
    }));
  }

  return NextResponse.json({
    task: {
      taskId: task.taskId,
      repo: task.repo,
      title: task.title,
      status: task.status,
      assignedAgent: task.assignedAgent,
      executionLane: task.executionLane,
      executionProvider: task.executionProvider,
      routedModel: task.routedModel,
      routedProfile: task.routedProfile,
      retryCount: task.retryCount ?? 0,
      maxRetries: task.maxRetries,
    },
    run: {
      startedAt: startedAt?.toISOString(),
      completedAt: endedAt?.toISOString(),
      durationSec,
      durationSource: meteredSec !== undefined ? 'meter' : computedSec !== undefined ? 'timestamps' : 'unknown',
      offhoursMinutes: typeof offhours?.quantity === 'number' ? offhours.quantity : undefined,
      premium: executed?.metadata?.premium === true,
      finalStatus: typeof executed?.metadata?.finalStatus === 'string' ? executed.metadata.finalStatus : undefined,
      meterEvents: events.length,
    },
    spend: { attribution, windowFrom, windowTo, ...totals, byModel },
  });
}
