import { prioritizeRepos } from '../repos/repo-registry.js';
import { getAdapter } from '../channels/registry.js';
import { createChildLogger } from '../shared/logger.js';
import { getConfig } from '../shared/config.js';
import { isConnected, TaskModel, ScheduleModel, BudgetUsageModel, DEFAULT_TENANT_ID } from '../shared/db.js';
import { withTenant, tenantScope } from '../shared/scoped-query.js';

const log = createChildLogger({ module: 'evening-sweep' });

export interface EveningSweepInput {
  telegramChatId?: string;
  previewTopN?: number; // how many repos to preview for tomorrow (default 3)
}

export interface EveningSweepResult {
  ranAt: Date;
  tasksCompletedToday: number;
  tasksOpenTotal: number;
  scheduleRunsToday: { success: number; error: number };
  spendToday: number;
  reposWorkedOn: string[];
  tomorrowPreview: Array<{ repo: string; score: number; reasons: string[] }>;
  report: string;
  delivery: { telegram: boolean; telegramChatId?: string; telegramError?: string };
}

const DEFAULT_PREVIEW_TOP_N = 3;

function startOfTodayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function runEveningSweep(input: EveningSweepInput = {}): Promise<EveningSweepResult> {
  const previewTopN = input.previewTopN ?? DEFAULT_PREVIEW_TOP_N;
  const telegramChatId = input.telegramChatId ?? process.env.TELEGRAM_DEFAULT_CHAT;
  const ranAt = new Date();
  const todayStart = startOfTodayUTC();

  log.info({ previewTopN, telegramChatId: telegramChatId ? '<set>' : '<none>' }, 'Evening sweep starting');

  let tasksCompletedToday = 0;
  let tasksOpenTotal = 0;
  let scheduleRunsToday = { success: 0, error: 0 };
  let spendToday = 0;
  let reposWorkedOn: string[] = [];
  let dbAvailable = true;

  if (!isConnected()) {
    dbAvailable = false;
    log.warn('Database unavailable — evening sweep will produce partial report');
  }

  if (dbAvailable) {
    try {
      // System operator report → the default tenant's data. Every scoped query
      // is tenant-filtered via withTenant/tenantScope (ADR-010 §3.4).
      // 1. Tasks completed today
      tasksCompletedToday = await TaskModel.countDocuments(withTenant(DEFAULT_TENANT_ID, {
        status: 'done',
        updatedAt: { $gte: todayStart },
      }));

      // 2. Total open tasks (not done, not blocked — or include all non-done)
      tasksOpenTotal = await TaskModel.countDocuments(withTenant(DEFAULT_TENANT_ID, {
        status: { $ne: 'done' },
      }));

      // 3. Repos worked on today: distinct repos from tasks that changed status today
      reposWorkedOn = await TaskModel.distinct('repo', withTenant(DEFAULT_TENANT_ID, {
        updatedAt: { $gte: todayStart },
      }));

      // 4. Schedule runs today
      const schedules = await ScheduleModel.find(withTenant(DEFAULT_TENANT_ID, {
        lastRun: { $gte: todayStart },
      })).select('lastStatus').lean();

      for (const s of schedules) {
        if (s.lastStatus === 'success') scheduleRunsToday.success++;
        else if (s.lastStatus === 'error') scheduleRunsToday.error++;
      }

      // 5. LLM spend today
      const spendResult = await BudgetUsageModel.aggregate([
        { $match: { ...tenantScope(DEFAULT_TENANT_ID), createdAt: { $gte: todayStart } } },
        { $group: { _id: null, total: { $sum: '$costUsd' } } },
      ]);
      spendToday = spendResult.length > 0 ? spendResult[0].total : 0;
    } catch (err) {
      log.error({ err }, 'Error querying database for evening sweep');
      dbAvailable = false;
    }
  }

  // 6. Tomorrow's priority queue preview
  const ranked = await prioritizeRepos(DEFAULT_TENANT_ID);
  const tomorrowPreview = ranked.slice(0, previewTopN).map(r => ({
    repo: r.repo,
    score: r.score,
    reasons: r.reasons,
  }));

  // 7. Compose report
  const report = composeReport(ranAt, {
    dbAvailable,
    tasksCompletedToday,
    tasksOpenTotal,
    scheduleRunsToday,
    spendToday,
    reposWorkedOn,
    tomorrowPreview,
  });

  // 8. Optionally deliver via Telegram
  const delivery: EveningSweepResult['delivery'] = { telegram: false };
  if (telegramChatId) {
    delivery.telegramChatId = telegramChatId;
    const tg = getAdapter('telegram');
    if (!tg) {
      delivery.telegramError = 'Telegram adapter not registered';
    } else if (!tg.enabled) {
      delivery.telegramError = 'Telegram adapter not enabled';
    } else {
      try {
        await tg.send(telegramChatId, report);
        delivery.telegram = true;
      } catch (err) {
        delivery.telegramError = (err as Error).message;
      }
    }
  }

  log.info({
    tasksCompletedToday,
    tasksOpenTotal,
    scheduleRuns: scheduleRunsToday,
    spendToday: Math.round(spendToday * 10000) / 10000,
    reposWorkedOn: reposWorkedOn.length,
    tomorrowPreview: tomorrowPreview.length,
    delivered: delivery.telegram,
  }, 'Evening sweep complete');

  return {
    ranAt,
    tasksCompletedToday,
    tasksOpenTotal,
    scheduleRunsToday,
    spendToday,
    reposWorkedOn,
    tomorrowPreview,
    report,
    delivery,
  };
}

interface ReportData {
  dbAvailable: boolean;
  tasksCompletedToday: number;
  tasksOpenTotal: number;
  scheduleRunsToday: { success: number; error: number };
  spendToday: number;
  reposWorkedOn: string[];
  tomorrowPreview: Array<{ repo: string; score: number; reasons: string[] }>;
}

function composeReport(ranAt: Date, data: ReportData): string {
  const date = ranAt.toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Daily Evening Summary — ${date}`);
  lines.push('');

  if (!data.dbAvailable) {
    lines.push('> **Note:** Database unavailable — some metrics may be incomplete.');
    lines.push('');
  }

  // Tasks section
  lines.push('## Tasks');
  lines.push('');
  lines.push(`- **Completed today:** ${data.tasksCompletedToday}`);
  lines.push(`- **Open total:** ${data.tasksOpenTotal}`);
  lines.push('');

  // Schedule runs section
  const totalRuns = data.scheduleRunsToday.success + data.scheduleRunsToday.error;
  lines.push('## Schedule Runs');
  lines.push('');
  lines.push(`- **Total runs today:** ${totalRuns}`);
  lines.push(`- **Successful:** ${data.scheduleRunsToday.success}`);
  lines.push(`- **Errors:** ${data.scheduleRunsToday.error}`);
  lines.push('');

  // LLM spend section
  lines.push('## LLM Spend');
  lines.push('');
  lines.push(`- **Today:** $${data.spendToday.toFixed(4)}`);
  lines.push('');

  // Repos worked on section
  lines.push('## Repos Worked On');
  lines.push('');
  if (data.reposWorkedOn.length === 0) {
    lines.push('_No repos had task activity today._');
  } else {
    for (const repo of data.reposWorkedOn) {
      lines.push(`- ${repo}`);
    }
  }
  lines.push('');

  // Tomorrow's priority queue
  lines.push('## Tomorrow\'s Priority Queue');
  lines.push('');
  if (data.tomorrowPreview.length === 0) {
    lines.push('_No repos in the priority queue._');
  } else {
    data.tomorrowPreview.forEach((entry, i) => {
      lines.push(`### ${i + 1}. ${entry.repo} — score ${entry.score}`);
      lines.push('');
      if (entry.reasons.length) {
        lines.push(`**Signals:** ${entry.reasons.join(' · ')}`);
      } else {
        lines.push('**Signals:** no specific signals');
      }
      lines.push('');
    });
  }

  return lines.join('\n').trimEnd();
}
