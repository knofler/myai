// Mission Control — the only place you start. Answers the operator's three
// questions without scrolling: what's running, what needs me, what's next.
// Header strip: Fable window chip + health dots. Footer strip: next fires +
// fleet health + today's numbers.

import Link from 'next/link';
import { connectDB, Task, Schedule, RepoCard, BudgetUsage } from '@/lib/db';
import { callGateway, fetchRoutingConfig, type RoutingConfig } from '@/lib/gateway';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { timeAgo, timeUntil, fmtSydney, fmtUsd } from '@/lib/format';
import { PriorityBadge, ModelBadge, LevelDot, Badge } from '@/components/ui/badge';
import { Card, EmptyState } from '@/components/ui/card';
import { SydneyClock } from '@/components/sydney-clock';
import AutoRefresh from '@/components/auto-refresh';
import { OnboardingChecklist } from '@/components/onboarding-checklist';
import { buildOnboardingSteps } from '@/lib/onboarding-checklist';

export const dynamic = 'force-dynamic';

interface TaskDoc {
  taskId: string;
  repo: string;
  title: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  status: string;
  assignedAgent?: string;
  recommendedModel?: string;
  notes?: string;
  startedAt?: Date;
  updatedAt?: Date;
  createdAt?: Date;
}

interface ScheduleDoc {
  scheduleId: string;
  name: string;
  repo?: string;
  nextRun?: Date;
  lastRun?: Date;
  lastStatus: string;
  lastResultSummary?: string;
}

interface RepoCardDoc {
  repoName: string;
  lastStatusLevel?: 'ok' | 'warn' | 'error' | 'unknown';
}

function effectiveModel(task: TaskDoc, routing: RoutingConfig | null): string {
  if (routing?.fableWindow?.active) return routing.fableWindow.model;
  if (task.recommendedModel) return task.recommendedModel;
  const tier = task.assignedAgent ? routing?.agentMap?.[task.assignedAgent] : undefined;
  return (tier ? routing?.tiers?.[tier]?.model : routing?.tiers?.standard?.model) ?? 'claude-sonnet-4-6';
}

// First-run quickstart — a zero-repo install has nothing to put in the three
// columns, so show the three actions that bring Mission Control to life
// instead of six empty boxes. Each card deep-links to the guided wizard.
const QUICKSTARTS = [
  {
    title: 'Register your repos',
    command: 'myai scan ~/code --register',
    desc: 'Point the scanner at your code folder — every repo gets a directory card and appears in Fleet health.',
  },
  {
    title: 'Start a new app',
    command: 'myai new-app ~/code/my-idea',
    desc: 'Scaffold a full-stack blueprint app (Next.js + Mongo + CI) that is fleet-managed from its first commit.',
  },
  {
    title: 'Connect the runner',
    command: 'myai up --runner',
    desc: 'Start the off-hours runner — queued tasks build autonomously and land in Needs review for your ship it.',
  },
] as const;

function FirstRunQuickstart() {
  return (
    <Card
      accent="emerald"
      title="Welcome — nothing here yet"
      meta={<Link href="/welcome/start" className="hover:text-emerald-400">guided first run →</Link>}
    >
      <div className="p-4 space-y-4">
        <p className="text-sm text-zinc-400">
          No repos or tasks are registered yet. Run one of these from your terminal, or take the guided
          four-step first run — Mission Control fills in as soon as the first repo card or task lands.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {QUICKSTARTS.map((q) => (
            <Link
              key={q.title}
              href="/welcome/start"
              className="block p-4 rounded-lg border border-zinc-800 bg-zinc-900/60 hover:border-emerald-700 transition-colors"
            >
              <p className="text-sm font-medium text-zinc-200">{q.title} →</p>
              <code className="mt-2 block px-2.5 py-1.5 rounded-md bg-zinc-950 border border-zinc-800 text-xs text-teal-300 font-mono overflow-x-auto whitespace-nowrap">
                {q.command}
              </code>
              <p className="mt-2 text-xs text-zinc-500">{q.desc}</p>
            </Link>
          ))}
        </div>
      </div>
    </Card>
  );
}

function ColumnRow({ top, bottom, right }: { top: React.ReactNode; bottom: React.ReactNode; right?: React.ReactNode }) {
  return (
    <li className="px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-zinc-800/30">
      <div className="min-w-0">
        <p className="text-sm text-zinc-200 truncate">{top}</p>
        <p className="text-xs text-zinc-500 truncate mt-0.5">{bottom}</p>
      </div>
      {right && <div className="shrink-0 text-right">{right}</div>}
    </li>
  );
}

export default async function MissionControl() {
  let dbOk = false;
  let working: TaskDoc[] = [];
  let review: TaskDoc[] = [];
  let pending: TaskDoc[] = [];
  let pendingTotal = 0;
  let nextFires: ScheduleDoc[] = [];
  let lastRuns: ScheduleDoc[] = [];
  let fleet: RepoCardDoc[] = [];
  let todaySpend = 0;
  let taskTotal = 0;
  let doneCount = 0;

  const startOfDayUTC = (() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  })();

  try {
    await connectDB();
    dbOk = true;
    const tenantId = await getActiveTenant();
    const tf = tenantFilter(tenantId);
    const [w, r, p, pt, nf, lr, fl, spend, tt, dc] = await Promise.all([
      Task.find({ ...tf, status: 'working' }).sort({ startedAt: 1 }).limit(7).lean() as unknown as Promise<TaskDoc[]>,
      Task.find({ ...tf, status: 'review' }).sort({ updatedAt: -1 }).limit(7).lean() as unknown as Promise<TaskDoc[]>,
      Task.find({ ...tf, status: 'pending' }).sort({ priority: 1, createdAt: 1 }).limit(7).lean() as unknown as Promise<TaskDoc[]>,
      Task.countDocuments({ ...tf, status: 'pending' }) as Promise<number>,
      Schedule.find({ ...tf, enabled: true, nextRun: { $ne: null } }).sort({ nextRun: 1 }).limit(4).lean() as unknown as Promise<ScheduleDoc[]>,
      Schedule.find({ ...tf, lastRun: { $ne: null } }).sort({ lastRun: -1 }).limit(1).lean() as unknown as Promise<ScheduleDoc[]>,
      RepoCard.find({ ...tf }).select('repoName lastStatusLevel').sort({ repoName: 1 }).lean() as unknown as Promise<RepoCardDoc[]>,
      BudgetUsage.aggregate([
        { $match: { ...tf, createdAt: { $gte: startOfDayUTC } } },
        { $group: { _id: null, total: { $sum: '$costUsd' } } },
      ]) as Promise<Array<{ total: number }>>,
      Task.countDocuments({ ...tf }) as Promise<number>,
      Task.countDocuments({ ...tf, status: 'done' }) as Promise<number>,
    ]);
    working = w; review = r; pending = p; pendingTotal = pt;
    nextFires = nf; lastRuns = lr; fleet = fl;
    todaySpend = spend[0]?.total ?? 0;
    taskTotal = tt; doneCount = dc;
  } catch {
    // Mongo down — render the shell with empty states.
  }

  const [routing, health] = await Promise.all([
    fetchRoutingConfig(),
    callGateway<{ mongodb?: { connected?: boolean } }>('health_status'),
  ]);
  const fable = routing?.fableWindow;
  const fableDaysLeft = fable?.active
    ? Math.max(0, Math.ceil((new Date(fable.until).getTime() - Date.now()) / 86_400_000))
    : 0;
  const lastRun = lastRuns[0];

  // Fresh install: db reachable but no repo cards and no tasks anywhere.
  // (Mongo down is an outage, not a first run — keep the normal shell then.)
  const firstRun =
    dbOk && fleet.length === 0 && working.length === 0 && review.length === 0 && pendingTotal === 0;

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <AutoRefresh seconds={15} />

      {/* ── Header strip ──────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-brand-orange tracking-tight">Mission Control</h1>
          <p className="text-sm text-zinc-500 mt-0.5">What&apos;s running · what needs you · what&apos;s next — live, 15s refresh</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {fable?.active && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-purple-500/15 border border-purple-500/40 text-xs font-medium text-purple-300">
              FABLE FREE · {fableDaysLeft}d left
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-800/80 border border-zinc-700/60 text-xs text-zinc-400">
            <LevelDot level={health ? 'ok' : 'error'} className="!w-1.5 !h-1.5" /> gateway
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-800/80 border border-zinc-700/60 text-xs text-zinc-400">
            <LevelDot level={dbOk ? 'ok' : 'error'} className="!w-1.5 !h-1.5" /> mongo
          </span>
          <SydneyClock />
          <span className="hidden md:inline-flex items-center px-2 py-1 rounded-md bg-zinc-800/50 border border-zinc-700/40 text-[10px] text-zinc-500">⌘K</span>
        </div>
      </div>

      {dbOk && (
        <OnboardingChecklist
          steps={buildOnboardingSteps({
            repoCount: fleet.length,
            taskCount: taskTotal,
            pickedUpCount: working.length + review.length + doneCount,
            doneCount,
          })}
        />
      )}

      {firstRun ? (
        <FirstRunQuickstart />
      ) : (
        <>
      {/* ── The three questions ───────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card
          accent="blue"
          title={<><span className="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse mr-2" />Running now</>}
          meta={<Link href="/work?tab=orchestration" className="hover:text-emerald-400">{working.length} working →</Link>}
        >
          {working.length === 0 ? (
            <EmptyState>No agents working right now.</EmptyState>
          ) : (
            <ul className="divide-y divide-zinc-800/50">
              {working.map((t) => (
                <ColumnRow
                  key={t.taskId}
                  top={t.title}
                  bottom={<>{t.assignedAgent ?? 'unassigned'} · <span className="font-mono">{t.repo}</span> · {timeAgo(t.startedAt)}</>}
                  right={<ModelBadge model={effectiveModel(t, routing)} />}
                />
              ))}
            </ul>
          )}
        </Card>

        <Card
          accent="purple"
          title="Needs review"
          meta={<Link href="/work?tab=review" className="hover:text-emerald-400">{review.length} waiting →</Link>}
        >
          {review.length === 0 ? (
            <EmptyState>Nothing waiting on you. ✨</EmptyState>
          ) : (
            <ul className="divide-y divide-zinc-800/50">
              {review.map((t) => (
                <ColumnRow
                  key={t.taskId}
                  top={t.title}
                  bottom={<>{(t.notes ?? '').replace(/^RESULT: /, '') || `${t.assignedAgent ?? '—'} · ${t.repo}`}</>}
                  right={<span className="text-xs text-zinc-600">{timeAgo(t.updatedAt)}</span>}
                />
              ))}
            </ul>
          )}
        </Card>

        <Card
          accent="emerald"
          title="Up next"
          meta={<Link href="/work" className="hover:text-emerald-400">{pendingTotal} queued →</Link>}
        >
          {pending.length === 0 ? (
            <EmptyState>Queue empty.</EmptyState>
          ) : (
            <ul className="divide-y divide-zinc-800/50">
              {pending.map((t) => (
                <ColumnRow
                  key={t.taskId}
                  top={t.title}
                  bottom={<><span className="font-mono">{t.repo}</span> · {t.assignedAgent ?? 'auto-select'}</>}
                  right={<PriorityBadge priority={t.priority} />}
                />
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* ── Footer strip ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Next scheduled fires" meta={<Link href="/work?tab=schedules" className="hover:text-emerald-400">all schedules →</Link>}>
          {nextFires.length === 0 ? (
            <EmptyState>No upcoming runs.</EmptyState>
          ) : (
            <ul className="divide-y divide-zinc-800/50">
              {nextFires.map((s) => (
                <li key={s.scheduleId} className="px-4 py-2 flex items-center justify-between gap-3 text-sm">
                  <span className="text-zinc-300 truncate">{s.name}</span>
                  <span className="text-xs text-zinc-500 shrink-0">
                    {timeUntil(s.nextRun)} · {fmtSydney(s.nextRun)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Fleet health" meta={<Link href="/apps" className="hover:text-emerald-400">{fleet.length} apps →</Link>}>
          {fleet.length === 0 ? (
            <EmptyState>No app cards reported yet.</EmptyState>
          ) : (
            <div className="p-4 flex flex-wrap gap-x-4 gap-y-2">
              {fleet.map((c) => (
                <Link key={c.repoName} href="/apps" className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200">
                  <LevelDot level={c.lastStatusLevel} className="!w-2 !h-2" />
                  {c.repoName}
                </Link>
              ))}
            </div>
          )}
        </Card>

        <Card title="Last runner activity" meta={<Link href="/system?tab=costs" className="hover:text-emerald-400">costs →</Link>}>
          <div className="p-4 space-y-2.5 text-sm">
            {lastRun ? (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-zinc-300 truncate">{lastRun.name}</p>
                  <p className="text-xs text-zinc-500 truncate mt-0.5">{lastRun.lastResultSummary ?? '—'}</p>
                </div>
                <Badge className={lastRun.lastStatus === 'success' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : lastRun.lastStatus === 'error' ? 'bg-red-500/15 text-red-400 border-red-500/30' : ''}>
                  {lastRun.lastStatus} · {timeAgo(lastRun.lastRun)}
                </Badge>
              </div>
            ) : (
              <p className="text-zinc-600">No schedule has run yet.</p>
            )}
            <div className="flex items-center justify-between border-t border-zinc-800/70 pt-2.5">
              <span className="text-xs text-zinc-500">Today&apos;s LLM spend (UTC day)</span>
              <span className={`text-sm font-semibold ${todaySpend > 10 ? 'text-red-400' : todaySpend > 5 ? 'text-yellow-400' : 'text-emerald-400'}`}>
                {fmtUsd(todaySpend)}
              </span>
            </div>
          </div>
        </Card>
      </div>
        </>
      )}
    </div>
  );
}
