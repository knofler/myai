// Today — the operator's home (dashboard redesign phase 4, operator GO
// 2026-10-21). It answers "what needs me today" before anything else:
//   1. Needs you · today — what the swarm is waiting on (client: swarm_live,
//      the same rules and cards as /swarm's Control Room);
//   2. older runner reviews — collapsed by age, so 17-day-old reviews don't
//      bury today's decisions (they used to be the page's only "decision");
//   3. what's running now;
//   4. your Macs — each Mac's last 08:00 boot verdict, worst first, with its age
//      (a silent Mac shows last week's report, and says so).
// Side column: the swarm in one card, and the queue (waiting / running /
// stuck / blocked) — replacing the four count tiles.

import Link from 'next/link';
import { Suspense } from 'react';
import { connectDB, Task, RepoCard } from '@/lib/db';
import { callGateway, fetchRoutingConfig, type RoutingConfig } from '@/lib/gateway';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { timeAgo } from '@/lib/format';
import { PriorityBadge, ModelBadge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import AutoRefresh from '@/components/auto-refresh';
import { OnboardingChecklist } from '@/components/onboarding-checklist';
import { CoachMarks } from '@/components/coach-marks';
import { EmailVerifyBanner } from '@/components/email-verify-banner';
import { ReconsentBanner } from '@/components/reconsent-banner';
import { AskBar } from '@/components/home/ask-bar';
import { buildOnboardingSteps } from '@/lib/onboarding-checklist';
import { StageRail } from '@/components/stage-rail';
import { TONE, type Tone } from '@/components/ui/tone';
import { SectionHead } from '@/components/ui/section-head';
import { TodaySwarmNeeds, TodaySwarmSummary } from '@/components/home/today-swarm';
import { bootAgeDays, readBootReports, type BootReport } from '@/lib/boot-reports';

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

interface RepoCardDoc {
  repoName: string;
}

function effectiveModel(task: TaskDoc, routing: RoutingConfig | null): string {
  if (routing?.fableWindow?.active) return routing.fableWindow.model;
  if (task.recommendedModel) return task.recommendedModel;
  const tier = task.assignedAgent ? routing?.agentMap?.[task.assignedAgent] : undefined;
  return (tier ? routing?.tiers?.[tier]?.model : routing?.tiers?.standard?.model) ?? 'claude-sonnet-4-6';
}

/** "Good evening" by the operator's clock (Sydney), the same tz the rest of the
 *  dashboard formats in (lib/format fmtSydney). */
function greeting(now = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-AU', { hour: 'numeric', hour12: false, timeZone: 'Australia/Sydney' }).format(now),
  );
  if (hour < 5) return 'Still up?';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** The one-line answer. Counts, in words, never a table. What needs you is
 *  the section right below — not a count of every old review in the queue. */
function handledLine(handled: number, running: number): string {
  if (handled === 0 && running === 0) return 'Your AI is standing by — nothing has run in the last 24 hours.';
  const parts: string[] = [];
  if (handled > 0) parts.push(`handled ${handled} ${handled === 1 ? 'thing' : 'things'} in the last 24 hours`);
  if (running > 0) parts.push(`is working on ${running} now`);
  return `Your AI ${parts.join(' and ')}.`;
}

const VERDICT_TONE: Record<BootReport['verdict'], Tone> = { RED: 'err', AMBER: 'warn', UNKNOWN: 'muted', GREEN: 'ok' };

function bootWhen(r: BootReport): string {
  const age = bootAgeDays(r);
  if (age === null) return 'boot time unknown';
  if (age === 0) return 'booted today';
  if (age === 1) return 'last booted yesterday';
  return `last booted ${age} days ago`;
}

function MacCard({ r }: { r: BootReport }) {
  const tone = VERDICT_TONE[r.verdict];
  const stale = (bootAgeDays(r) ?? 0) >= 2;
  const first = r.problems[0];
  return (
    <li className="space-y-2 rounded-2xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-meta font-semibold text-[rgb(var(--text-primary))]">{r.host}</span>
        <span className={`ml-auto rounded-full px-2 py-0.5 text-label font-semibold ${TONE[tone].box} ${TONE[tone].glyph}`}>
          {r.verdict === 'UNKNOWN' ? 'No verdict' : r.verdict.charAt(0) + r.verdict.slice(1).toLowerCase()}
        </span>
      </div>
      <p className={`text-label ${stale ? 'font-medium text-[rgb(var(--warn))]' : 'text-[rgb(var(--text-muted))]'}`}>
        {bootWhen(r)} · {r.summary}
      </p>
      {first && (
        <p className="text-meta text-[rgb(var(--text-secondary))]">
          <span className="font-medium">{first.phase}:</span> {first.detail}
        </p>
      )}
    </li>
  );
}

// ── First run ──────────────────────────────────────────────────────────────
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
      title="Nothing here yet"
      meta={<Link href="/welcome/start" className="text-[rgb(var(--text-secondary))] hover:text-[rgb(var(--text-primary))]">guided first run →</Link>}
    >
      <div className="space-y-4 p-4">
        <p className="text-body text-[rgb(var(--text-secondary))]">
          No repos or tasks are registered yet. Run one of these from your terminal, or take the guided
          four-step first run — Mission Control fills in as soon as the first repo card or task lands.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {QUICKSTARTS.map((q) => (
            <Link
              key={q.title}
              href="/welcome/start"
              className="block rounded-xl bg-[rgb(var(--bg-canvas))] p-4 transition-colors hover:bg-[rgb(var(--bg-hover))]"
            >
              <p className="text-body font-medium text-[rgb(var(--text-primary))]">{q.title} →</p>
              <code className="mt-2 block overflow-x-auto whitespace-nowrap rounded-md bg-[rgb(var(--bg-surface))] px-2.5 py-1.5 font-mono text-label text-[rgb(var(--text-primary))]">
                {q.command}
              </code>
              <p className="mt-2 text-meta text-[rgb(var(--text-muted))]">{q.desc}</p>
            </Link>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ── Queue card ─────────────────────────────────────────────────────────────
// Colour = meaning (DESIGN_LANGUAGE §2): stuck/blocked amber because they need
// a person; waiting/running neutral. Each row opens the matching Work view.

function QueueRow({ href, label, count, warn = false }: { href: string; label: string; count: number; warn?: boolean }) {
  return (
    <Link
      href={href}
      className={`flex min-h-tap items-center justify-between rounded-xl px-3 text-meta transition-colors hover:bg-[rgb(var(--bg-hover))] ${
        warn && count > 0 ? 'text-[rgb(var(--warn))]' : 'text-[rgb(var(--text-secondary))]'
      }`}
    >
      <span>{label}</span>
      <span className="font-mono tabular-nums">{count}</span>
    </Link>
  );
}

// ── Currently running ──────────────────────────────────────────────────────
// StageRail lives in @/components/stage-rail (shared with the task detail page).
// SectionHead lives in @/components/ui/section-head (extracted verbatim, so
// every page's section heading is this one).

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="rounded-2xl bg-[rgb(var(--bg-surface))]/60 px-4 py-5 text-center text-meta text-[rgb(var(--text-muted))]">{children}</p>;
}

export default async function MissionControl() {
  let dbOk = false;
  let working: TaskDoc[] = [];
  let review: TaskDoc[] = [];
  let workingTotal = 0;
  let reviewTotal = 0;
  let pendingTotal = 0;
  let handled = 0;
  let fleet: RepoCardDoc[] = [];
  let taskTotal = 0;
  let doneCount = 0;
  let reviewOld = 0;
  let oldestReview: TaskDoc | undefined;
  let stuckTotal = 0;
  let blockedTotal = 0;

  const dayAgo = new Date(Date.now() - 86_400_000);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  try {
    await connectDB();
    dbOk = true;
    const tenantId = await getActiveTenant();
    const tf = tenantFilter(tenantId);
    const [w, r, wt, rt, pt, h, fl, tt, dc] = await Promise.all([
      Task.find({ ...tf, status: 'working' }).sort({ startedAt: 1 }).limit(1).lean() as unknown as Promise<TaskDoc[]>,
      Task.find({ ...tf, status: 'review' }).sort({ priority: 1, updatedAt: -1 }).limit(1).lean() as unknown as Promise<TaskDoc[]>,
      Task.countDocuments({ ...tf, status: 'working' }) as Promise<number>,
      Task.countDocuments({ ...tf, status: 'review' }) as Promise<number>,
      Task.countDocuments({ ...tf, status: 'pending' }) as Promise<number>,
      Task.countDocuments({ ...tf, status: 'done', completedAt: { $gte: dayAgo } }) as Promise<number>,
      RepoCard.find({ ...tf }).select('repoName').sort({ repoName: 1 }).lean() as unknown as Promise<RepoCardDoc[]>,
      Task.countDocuments({ ...tf }) as Promise<number>,
      Task.countDocuments({ ...tf, status: 'done' }) as Promise<number>,
    ]);
    working = w; review = r;
    workingTotal = wt; reviewTotal = rt; pendingTotal = pt; handled = h;
    fleet = fl; taskTotal = tt; doneCount = dc;
    const [ro, oldest, st, bl] = await Promise.all([
      Task.countDocuments({ ...tf, status: 'review', updatedAt: { $lt: weekAgo } }) as Promise<number>,
      Task.find({ ...tf, status: 'review' }).sort({ updatedAt: 1 }).limit(1).lean() as unknown as Promise<TaskDoc[]>,
      Task.countDocuments({ ...tf, status: 'dead_letter' }) as Promise<number>,
      Task.countDocuments({ ...tf, status: 'blocked' }) as Promise<number>,
    ]);
    reviewOld = ro; oldestReview = oldest[0]; stuckTotal = st; blockedTotal = bl;
  } catch {
    // Mongo down — render the shell with empty states.
  }

  const [routing, health, macs] = await Promise.all([
    fetchRoutingConfig(),
    callGateway<{ mongodb?: { connected?: boolean } }>('health_status'),
    readBootReports(),
  ]);
  const healthy = Boolean(health) && dbOk;

  // Fresh install: db reachable but no repo cards and no tasks anywhere.
  const firstRun = dbOk && fleet.length === 0 && taskTotal === 0;
  const running = working[0];
  const decision = review[0];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <AutoRefresh seconds={15} />

      {/* ── The answer ─────────────────────────────────────────── */}
      <header className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-title font-bold tracking-tight text-[rgb(var(--text-primary))]">{greeting()}</h1>
          <Link
            href="/status"
            className={`inline-flex min-h-tap items-center gap-1.5 rounded-full px-3 text-label font-medium ${
              healthy ? 'bg-[rgb(var(--accent))]/15 text-[rgb(var(--accent))]' : 'bg-[rgb(var(--warn))]/15 text-[rgb(var(--warn))]'
            }`}
          >
            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${healthy ? 'bg-[rgb(var(--accent))]' : 'bg-[rgb(var(--warn))]'}`} />
            {healthy ? 'System healthy' : 'Check system'}
          </Link>
        </div>
        <p className="text-body text-[rgb(var(--text-secondary))]">{handledLine(handled, workingTotal)}</p>
      </header>

      <Suspense fallback={null}>
        <AskBar repos={fleet.map((c) => c.repoName)} />
      </Suspense>

      <EmailVerifyBanner />
      <ReconsentBanner />

      {firstRun ? (
        <FirstRunQuickstart />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(260px,320px)]">
        <div className="min-w-0 space-y-6">
          {/* ── What needs you today (the swarm) ─────────────────── */}
          <TodaySwarmNeeds />

          {/* ── Older runner reviews, collapsed by age ───────────── */}
          {reviewTotal > 0 && (
            <details className="group rounded-2xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))] p-4">
              <summary className="flex min-h-tap cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 text-meta text-[rgb(var(--text-secondary))]">
                <span className="font-medium text-[rgb(var(--text-primary))]">Runner reviews</span>
                <span>
                  {reviewTotal} waiting
                  {reviewOld > 0 ? ` · ${reviewOld} older than 7 days` : ''}
                  {oldestReview?.updatedAt ? ` · oldest ${timeAgo(oldestReview.updatedAt)}` : ''}
                </span>
                <span aria-hidden="true" className="ml-auto text-[rgb(var(--text-muted))] group-open:rotate-90">›</span>
              </summary>
              {decision && (
                <div className="mt-4 flex items-start gap-3 border-t border-[rgb(var(--border-subtle))] pt-4">
                  <PriorityBadge priority={decision.priority} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body font-medium text-[rgb(var(--text-primary))]">{decision.title}</p>
                    <p className="mt-0.5 truncate text-meta text-[rgb(var(--text-secondary))]">
                      {decision.assignedAgent ?? '—'} · {decision.repo} · ready {timeAgo(decision.updatedAt)}
                    </p>
                  </div>
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <Link
                  href="/work?tab=review"
                  className="flex min-h-tap flex-1 items-center justify-center rounded-xl bg-[rgb(var(--bg-canvas))] px-3 text-meta font-medium text-[rgb(var(--text-secondary))] transition-colors hover:text-[rgb(var(--text-primary))]"
                >
                  Review by repo
                </Link>
                {decision && (
                  <Link
                    href={`/work/${encodeURIComponent(decision.taskId)}`}
                    className="flex min-h-tap flex-1 items-center justify-center rounded-xl bg-[rgb(var(--accent))] px-3 text-meta font-semibold text-[rgb(var(--accent-fg))] transition-opacity hover:opacity-90"
                  >
                    Review the top one →
                  </Link>
                )}
              </div>
            </details>
          )}

          {/* ── Currently running ────────────────────────────────── */}
          <section className="space-y-3">
            <SectionHead title="Currently running" count={workingTotal} href="/work?tab=orchestration" />
            {running ? (
              <Link
                href={`/work/${encodeURIComponent(running.taskId)}`}
                className="tap-press block rounded-2xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))] p-4 transition-colors hover:border-[rgb(var(--border-strong))]"
              >
                <div className="flex items-start gap-3">
                  <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[rgb(var(--accent))]/15 text-[rgb(var(--accent))]">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-current" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body font-medium text-[rgb(var(--text-primary))]">{running.title}</p>
                    <p className="mt-0.5 truncate text-meta text-[rgb(var(--text-secondary))]">
                      {running.assignedAgent ?? 'auto-select'} · {running.repo} · started {timeAgo(running.startedAt)}
                    </p>
                  </div>
                  <ModelBadge model={effectiveModel(running, routing)} />
                </div>
                <div className="mt-4">
                  <StageRail status={running.status} />
                </div>
              </Link>
            ) : (
              <Quiet>Nothing running. Your AI picks up the queue on its next free window.</Quiet>
            )}
          </section>

          {/* ── Your Macs ────────────────────────────────────────── */}
          {macs.length > 0 && (
            <section aria-labelledby="macs-h" className="space-y-3">
              <h2 id="macs-h" className="text-body font-semibold text-[rgb(var(--text-primary))]">
                Your Macs
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {macs.map((r) => (
                  <MacCard key={r.host} r={r} />
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="min-w-0 space-y-6">
          <TodaySwarmSummary />
          <section aria-labelledby="queue-h" className="space-y-3">
            <SectionHead title="Queue" href="/work" linkLabel="Open Work ›" />
            <div className="rounded-2xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))] p-2">
              <QueueRow href="/work?tab=queue" label="Waiting to run" count={pendingTotal} />
              <QueueRow href="/work?tab=orchestration" label="Running now" count={workingTotal} />
              <QueueRow href="/work?tab=deadletter" label="Stuck (out of retries)" count={stuckTotal} warn />
              <QueueRow href="/work?tab=orchestration" label="Blocked" count={blockedTotal} warn />
            </div>
          </section>
        </aside>
        </div>
      )}

      {/* First-run guidance — self-hides once the four steps are done. */}
      {dbOk && (() => {
        const onboardingSteps = buildOnboardingSteps({
          repoCount: fleet.length,
          taskCount: taskTotal,
          pickedUpCount: workingTotal + reviewTotal + doneCount,
          doneCount,
        });
        return (
          <>
            <OnboardingChecklist steps={onboardingSteps} />
            <CoachMarks steps={onboardingSteps} />
          </>
        );
      })()}
    </div>
  );
}
