// Runner Health — the CLI task-runner's pulse.
//
// Two sources, per the framework's runner architecture:
//   1. runner.out (host log) → state/runner-health.json → readRunnerHealth()
//      Gives: last fire time, last RESULT per repo, and the consecutive
//      zero-work streak used for the stall flag.
//   2. The gateway task store (Mongo `tasks`) → queue depth by status.
//
// RED stall flag: when N consecutive runner fires shipped 0 work — the
// "content_api head-of-line" signature, where a stuck head-of-queue task makes
// the runner fire every ~10 min but commit nothing.

import { connectDB, Task } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { readRunnerHealth, getRunnerLiveness, getFleetRunners, getFleetMaintenanceStatus, getClaimExecutionRatio, type RunnerRepoHealth, type FleetRunnerRow, type ClaimExecutionRatio } from '@/lib/runner-health';
import { readMongoMirrorStatus, formatReplicaSummary, type ReplicaSummary } from '@/lib/mongo-mirror';
import { getAutoshipStatus, type AutoshipStatus } from '@/lib/autoship';
import { timeAgo, fmtSydney } from '@/lib/format';
import { Card, StatCard, EmptyState, THead } from '@/components/ui/card';
import { Badge, TaskStatusBadge, RoutedBadge } from '@/components/ui/badge';
import type { Tone } from '@/components/ui/tone';

export const dynamic = 'force-dynamic';

const STATUSES = ['pending', 'working', 'review', 'blocked', 'done'] as const;

async function queueDepth(): Promise<Record<string, number>> {
  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);
  const rows = (await Task.aggregate([
    { $match: tf },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ])) as Array<{ _id: string; count: number }>;
  const depth: Record<string, number> = {};
  for (const r of rows) depth[r._id] = r.count;
  return depth;
}

interface RoutedTaskRow {
  taskId: string;
  repo: string;
  title: string;
  status: string;
  routedProfile?: string;
  routedModel?: string;
  routedComplexity?: string;
  updatedAt?: Date;
}

/** Router audit trail (task-d9300dac): the runner's route_task_model decision,
 *  stamped onto the task record at claim time — the last N claimed tasks so an
 *  operator can audit WHICH pool/model actually ran without grepping runner.out. */
async function recentRoutedTasks(): Promise<RoutedTaskRow[]> {
  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);
  return (await Task.find({ ...tf, routedModel: { $exists: true, $ne: null } })
    .sort({ updatedAt: -1 })
    .limit(15)
    .select('taskId repo title status routedProfile routedModel routedComplexity updatedAt')
    .lean()) as unknown as RoutedTaskRow[];
}

function OutcomeBadge({ outcome }: { outcome: RunnerRepoHealth['lastOutcome'] }) {
  if (outcome === 'blocked') return <Badge className="bg-red-500/15 text-red-300 border border-red-500/30">blocked</Badge>;
  if (outcome === 'review') return <Badge className="bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">review</Badge>;
  return <Badge className="bg-zinc-700/40 text-[rgb(var(--text-secondary))] border border-zinc-700">running</Badge>;
}

/** Claims-vs-executions churn (task-d85ea318) — how many claims actually routed.
 * A high ratio means the runner is claiming tasks it then releases without ever
 * executing them (a post-claim pacing/routing gate looping on the head of the
 * queue): wasted gateway round trips + log noise that can mask real starvation.
 * ≤2:1 is healthy; >4:1 is the churn signature the fix targets. */
function ChurnCard({ churn }: { churn: ClaimExecutionRatio }) {
  const tone: Tone = churn.ratio >= 4 ? 'err' : churn.ratio >= 2 ? 'warn' : 'ok';
  return (
    <Card title="Claims vs executions" meta={`last ${churn.windowDays}d`}>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 p-4 md:p-5">
        <StatCard
          label="Churn ratio"
          value={`${churn.ratio}:1`}
          sub={churn.ratio >= 4 ? 'claiming without executing' : 'claims per execution'}
          icon="alert"
          tone={tone}
        />
        <StatCard label="Claims" value={churn.claims} sub="tasks claimed in window" icon="runs" tone="muted" />
        <StatCard label="Executions" value={churn.executions} sub="actually routed" icon="status" tone={churn.executions > 0 ? 'ok' : 'muted'} />
        <StatCard
          label="Claimed, never routed"
          value={churn.churnedClaims}
          sub={churn.pacingDeferredClaims > 0 ? `${churn.pacingDeferredClaims} counted pacing-defer` : 'released before routing'}
          icon="cross"
          tone={churn.churnedClaims > 0 ? (tone === 'ok' ? 'warn' : tone) : 'muted'}
        />
      </div>
    </Card>
  );
}

/** Operator kill-switch banner (fleet-maintenance-store.ts) — every runner across
 * the fleet is currently refused a claim, regardless of what the queue/liveness
 * signals below say. Rendered ahead of everything else so it can never be missed. */
function MaintenanceBanner({ maintenance }: { maintenance: Awaited<ReturnType<typeof getFleetMaintenanceStatus>> }) {
  if (!maintenance.active) return null;
  return (
    <div className="bg-amber-950/40 border border-amber-500/50 rounded-xl p-5">
      <div className="flex items-start gap-3">
        <span className="text-2xl leading-none" aria-hidden="true">🚧</span>
        <div>
          <h2 className="text-base font-semibold text-amber-300">
            Fleet maintenance active — all runner claims paused
          </h2>
          <p className="text-sm text-[rgb(var(--text-primary))] mt-1">
            {maintenance.reason ? <>Reason: <span className="text-amber-200">{maintenance.reason}</span>. </> : null}
            {maintenance.operator ? <>Started by <span className="text-amber-200">{maintenance.operator}</span>. </> : null}
            No runner on any machine will claim a task until this ends
            {maintenance.resumeAt
              ? <> — scheduled to auto-resume at {new Date(maintenance.resumeAt).toLocaleString()}.</>
              : <>; use fleet_maintenance_exit (or wait for a scheduled resumeAt) to resume.</>}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Operator auto-ship kill switch (config/autoship.off, task-79a07a7c) — while
 * this committed marker exists, scripts/runner_ship_step.sh exits before it
 * ever opens or merges a test->main PR, fleet-wide. Previously invisible in
 * this view; rendered ahead of the fleet/queue panels so it can't be missed,
 * mirroring MaintenanceBanner's layout above. */
function AutoshipBanner({ killSwitch }: { killSwitch: AutoshipStatus['killSwitch'] }) {
  if (!killSwitch.active) return null;
  return (
    <div className="bg-amber-950/40 border border-amber-500/50 rounded-xl p-5">
      <div className="flex items-start gap-3">
        <span className="text-2xl leading-none" aria-hidden="true">⛔</span>
        <div>
          <h2 className="text-base font-semibold text-amber-300">AUTO-SHIP OFF — operator kill switch active</h2>
          <p className="text-sm text-[rgb(var(--text-primary))] mt-1">
            <code className="text-amber-200">config/autoship.off</code> is in force
            {killSwitch.since && <> since {fmtSydney(killSwitch.since, 'date')} ({timeAgo(killSwitch.since)})</>}.
            The runner will open and merge NO test→main PR on its own, on any machine — ship manually with the{' '}
            <code className="text-amber-200">ship it</code> keyword. Re-enable with{' '}
            <code className="text-amber-200">git rm config/autoship.off</code>.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Last ship-step decision (scripts/runner_ship_step.sh, task-79a07a7c) — the
 * script used to print its verdict to stdout only (runner.out), invisible
 * once the log rotated. It now persists the same decision to
 * state/ship-step.json after every run; this renders that artifact via
 * lib/autoship.ts so an operator can see WHY the last fire did or didn't
 * ship without grepping runner.out. */
function verdictTone(result: string): Tone {
  if (result === 'shipped') return 'ok';
  if (result.includes('fail')) return 'err';
  if (result === 'autoship-off' || result.includes('pending') || result === 'pr-guard-refused') return 'warn';
  return 'muted';
}

function LastShipVerdictCard({ verdict }: { verdict: AutoshipStatus['lastVerdict'] }) {
  return (
    <Card title="Last ship-step verdict" meta="scripts/runner_ship_step.sh">
      {!verdict ? (
        <EmptyState>No ship-step verdict recorded yet — it runs after the runner flips a task to review.</EmptyState>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 p-4 md:p-5">
          <StatCard
            label="Result"
            value={verdict.result}
            sub={verdict.detail ?? undefined}
            icon={verdict.result === 'shipped' ? 'check' : 'status'}
            tone={verdictTone(verdict.result)}
          />
          <StatCard label="When" value={timeAgo(verdict.at)} sub={verdict.at ? fmtSydney(verdict.at, 'datetime') : undefined} icon="clock" tone="muted" />
          <StatCard label="Repo / task" value={verdict.repo ?? '—'} sub={verdict.taskId ?? undefined} icon="projects" tone="muted" />
          <StatCard
            label="PR"
            value={verdict.prNumber != null ? `#${verdict.prNumber}` : '—'}
            sub={verdict.drift != null ? `drift ${verdict.drift} · review ${verdict.reviewCount ?? 0}` : undefined}
            icon="runs"
            tone="muted"
          />
        </div>
      )}
    </Card>
  );
}

/** Router audit trail (task-d9300dac): last N claimed tasks with the runner's
 *  actual {routedProfile, routedModel, routedComplexity} pick, so an operator
 *  can audit WHICH pool/model a task ran on without grepping runner.out. */
function RecentRoutingCard({ routedTasks }: { routedTasks: RoutedTaskRow[] }) {
  return (
    <Card
      title="Recent routing decisions"
      meta="capability×cost×availability router — stamped at claim time"
    >
      {routedTasks.length === 0 ? (
        <EmptyState>
          No routed tasks yet — the router (route_task_model) stamps routedProfile/routedModel/routedComplexity
          onto a task the first time the runner claims it.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="card-table w-full text-sm">
            <THead
              cols={[
                { label: 'Repo' },
                { label: 'Task' },
                { label: 'Routed' },
                { label: 'Status' },
                { label: 'When' },
              ]}
            />
            <tbody className="divide-y divide-[rgb(var(--border-subtle))]/50">
              {routedTasks.map((t) => (
                <tr key={t.taskId} className="hover:bg-[rgb(var(--bg-hover))]/30">
                  <td className="px-4 py-2.5 text-[rgb(var(--text-muted))] font-mono text-xs">{t.repo}</td>
                  <td data-label="Task" className="m-title px-4 py-2.5 text-[rgb(var(--text-primary))] max-w-xs truncate">{t.title}</td>
                  <td data-label="Routed" className="px-4 py-2.5">
                    <RoutedBadge routedProfile={t.routedProfile} routedModel={t.routedModel} routedComplexity={t.routedComplexity} />
                  </td>
                  <td data-label="Status" className="px-4 py-2.5"><TaskStatusBadge status={t.status} /></td>
                  <td data-label="When" className="px-4 py-2.5 text-zinc-600 text-xs">{timeAgo(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RunnerStatusBadge({ online, busy }: { online: boolean; busy: boolean }) {
  if (!online) return <Badge className="bg-red-500/15 text-red-300 border border-red-500/30">offline</Badge>;
  if (busy) return <Badge className="bg-blue-500/15 text-blue-300 border border-blue-500/30">busy</Badge>;
  return <Badge className="bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">online</Badge>;
}

/** Fleet panel (task-c0a03fcc): every registered runner in the shared pool —
 *  name/host, online/busy, last job, last-seen — sourced from
 *  lib/fleet-runners.ts's join of heartbeat + lease + lease-history. A
 *  runner that stops heartbeating stays in the table (marked offline, sunk
 *  to the bottom) rather than disappearing once its pulse lapses. */
function FleetRunnersCard({ runners }: { runners: FleetRunnerRow[] }) {
  return (
    <Card title="Fleet — registered runners" meta={`${runners.length} machine(s) in the pool`}>
      {runners.length === 0 ? (
        <EmptyState>No runner has heartbeated, held a lease, or appeared in the runs log yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="card-table w-full text-sm">
            <THead
              cols={[
                { label: 'Runner' },
                { label: 'Status' },
                { label: 'Last job' },
                { label: 'Last seen' },
              ]}
            />
            <tbody className="divide-y divide-[rgb(var(--border-subtle))]/50">
              {runners.map((r) => (
                <tr key={r.machine} className={`hover:bg-[rgb(var(--bg-hover))]/30 ${!r.online ? 'bg-red-950/10' : ''}`}>
                  <td className="m-title px-4 py-2.5">
                    <p className="text-[rgb(var(--text-primary))] font-mono text-xs">{r.machine}</p>
                    {r.holder && <p className="text-zinc-600 text-label font-mono mt-0.5">{r.holder}</p>}
                  </td>
                  <td data-label="Status" className="px-4 py-2.5">
                    <RunnerStatusBadge online={r.online} busy={r.busy} />
                  </td>
                  <td data-label="Last job" className="px-4 py-2.5 text-[rgb(var(--text-secondary))] text-xs max-w-xs truncate" title={r.lastJobLabel ?? ''}>
                    {r.lastJobLabel ?? <span className="text-zinc-600">—</span>}
                  </td>
                  <td data-label="Last seen" className="px-4 py-2.5 text-xs">
                    <span className={r.online ? 'text-[rgb(var(--text-muted))]' : 'text-red-400 font-semibold'}>
                      {r.lastHeartbeatAt ? timeAgo(r.lastHeartbeatAt) : 'never'}
                    </span>
                    {r.lastHeartbeatAt && <span className="text-zinc-600 ml-2">{fmtSydney(r.lastHeartbeatAt, 'time')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Local Mongo read-replica coverage (documentation/MONGO_MIRROR.md) — Atlas is
 *  the source of truth; scripts/mongo_mirror.sh keeps the local myai-mongo as a
 *  warm read replica and records per-run freshness + the per-collection count
 *  delta. This surfaces the one-line "local replica: N/73 collections, last sync
 *  Xm ago" status the operator asked for, with a RAM-pressure flag when the
 *  replica nears the 512m slice. */
function ReplicaCard({ replica }: { replica: ReplicaSummary | null }) {
  return (
    <Card title="Local Mongo replica" meta="Atlas = source of truth · local = read replica">
      {!replica ? (
        <EmptyState>
          No mirror coverage recorded yet. Run{' '}
          <code className="text-emerald-400">./scripts/mongo_mirror.sh</code> on the host — it records
          per-collection freshness to{' '}
          <code className="text-[rgb(var(--text-secondary))]">state/mongo-mirror-status.json</code>.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 p-4 md:p-5">
          <StatCard
            label="Collections mirrored"
            value={`${replica.mirrored}/${replica.total}`}
            sub="Atlas → local, one-way"
            icon="projects"
            tone={replica.healthy ? 'ok' : 'warn'}
          />
          <StatCard
            label="Last sync"
            value={replica.lastSync}
            sub={replica.healthy ? 'last run OK' : 'last run failed / never'}
            icon="clock"
            tone={replica.healthy ? 'ok' : 'err'}
          />
          <StatCard
            label="RAM headroom"
            value={replica.ramFlag ? 'tight' : 'ok'}
            sub="vs the 512m slice"
            icon={replica.ramFlag ? 'alert' : 'status'}
            tone={replica.ramFlag ? 'warn' : 'muted'}
          />
          <StatCard
            label="Status"
            value={replica.label}
            icon="status"
            tone="muted"
          />
        </div>
      )}
    </Card>
  );
}

function timeAgoFromMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

export default async function RunnerHealthView() {
  await connectDB();
  const [health, depth, liveness, fleetRunners, maintenance, routedTasks, autoship, mirrorStatus, churn] = await Promise.all([
    readRunnerHealth(), queueDepth(), getRunnerLiveness(), getFleetRunners(), getFleetMaintenanceStatus(), recentRoutedTasks(), getAutoshipStatus(), readMongoMirrorStatus(), getClaimExecutionRatio(),
  ]);
  const replica = formatReplicaSummary(mirrorStatus);

  if (!health || !health.available) {
    return (
      <div className="space-y-6">
        <MaintenanceBanner maintenance={maintenance} />
        <AutoshipBanner killSwitch={autoship.killSwitch} />
        <ReplicaCard replica={replica} />
        <FleetRunnersCard runners={fleetRunners} />
        <ChurnCard churn={churn} />
        <Card title="Runner Health">
          <EmptyState>
            No runner-health artifact yet. Generate it on the runner host with{' '}
            <code className="text-emerald-400">./scripts/runner_health.sh</code> — it parses{' '}
            <code className="text-[rgb(var(--text-secondary))]">~/.ai-cli-runner/runner.out</code> into{' '}
            <code className="text-[rgb(var(--text-secondary))]">state/runner-health.json</code>.
          </EmptyState>
        </Card>
        <LastShipVerdictCard verdict={autoship.lastVerdict} />
        <RecentRoutingCard routedTasks={routedTasks} />
      </div>
    );
  }

  const g = health.global;
  const pending = depth.pending ?? 0;
  const blocked = depth.blocked ?? 0;

  return (
    <div className="space-y-6">
      <MaintenanceBanner maintenance={maintenance} />
      <AutoshipBanner killSwitch={autoship.killSwitch} />
      {/* ── RED runner-down banner (liveness heartbeat lapsed) ────── */}
      {!liveness.alive && (
        <div className="bg-red-950/40 border border-red-600/50 rounded-xl p-5">
          <div className="flex items-start gap-3">
            <span className="text-2xl leading-none" aria-hidden="true">📡</span>
            <div>
              <h2 className="text-base font-semibold text-red-300">
                {liveness.machines.length === 0
                  ? 'Runner down — no heartbeat ever recorded'
                  : `Runner down — no heartbeat in ${timeAgoFromMinutes(liveness.machines[0].minutesSince)}`}
              </h2>
              <p className="text-sm text-[rgb(var(--text-primary))] mt-1">
                {liveness.lastMachine
                  ? <>Last seen <code className="text-red-300 font-mono">{liveness.lastMachine}</code> at {new Date(liveness.lastHeartbeatAt!).toLocaleString()}. </>
                  : null}
                No machine has fired within the {liveness.thresholdMinutes}-minute liveness window — the off-hours
                runner (launchd job) may have died, not just have an empty queue.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── RED stall banner ─────────────────────────────────────── */}
      {g.stall && (
        <div className="bg-red-950/40 border border-red-600/50 rounded-xl p-5">
          <div className="flex items-start gap-3">
            <span className="text-2xl leading-none" aria-hidden="true">🛑</span>
            <div>
              <h2 className="text-base font-semibold text-red-300">
                Zero-work stall — {g.consecutiveZeroWork} consecutive fires shipped nothing
              </h2>
              <p className="text-sm text-[rgb(var(--text-primary))] mt-1">
                The runner keeps firing but commits no work
                {g.stalledRepo && (
                  <> — head-of-line repo <code className="text-red-300 font-mono">{g.stalledRepo}</code></>
                )}. This is the head-of-queue stall signature: a stuck top task blocks the queue.
                Re-point or unblock it, or it will burn every fire.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Local Mongo read-replica coverage (Atlas = source of truth) ── */}
      <ReplicaCard replica={replica} />

      {/* ── Fleet — registered runners (task-c0a03fcc) ──────────── */}
      <FleetRunnersCard runners={fleetRunners} />

      {/* ── Claims vs executions churn (task-d85ea318) ──────────── */}
      <ChurnCard churn={churn} />

      {/* ── At-a-glance stats ───────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        <StatCard
          label="Runner liveness"
          value={liveness.alive ? 'alive' : 'down'}
          sub={liveness.machines.length > 0 ? `${liveness.lastMachine} · ${timeAgoFromMinutes(liveness.machines[0].minutesSince)} ago` : 'no heartbeat yet'}
          icon={liveness.alive ? 'status' : 'cross'}
          tone={liveness.alive ? 'accent' : 'err'}
        />
        <StatCard
          label="Last fire"
          value={timeAgo(g.lastFireAt)}
          sub={g.lastRepo ? `${g.lastRepo} · ${fmtSydney(g.lastFireAt, 'time')}` : '—'}
          icon="clock"
          tone={g.lastFireAt ? 'ok' : 'muted'}
        />
        <StatCard label="Fires (24h)" value={g.firesLast24h} sub={`${g.totalFires} logged total`} icon="runs" tone={g.firesLast24h > 0 ? 'ok' : 'muted'} />
        <StatCard
          label="Consecutive 0-work"
          value={g.consecutiveZeroWork}
          sub={`stall at ${health.stallThreshold}`}
          icon="alert"
          tone={g.stall ? 'err' : g.consecutiveZeroWork > 0 ? 'warn' : 'muted'}
        />
        <StatCard label="Queue: pending" value={pending} sub="awaiting a runner" icon="queue" tone={pending > 0 ? 'warn' : 'muted'} />
        <StatCard label="Queue: blocked" value={blocked} sub="needs unblocking" icon="cross" tone={blocked > 0 ? 'err' : 'muted'} />
      </div>

      {/* ── Queue depth by status (gateway task store) ──────────── */}
      <Card title="Queue depth — gateway task store" meta="by status">
        <div className="grid grid-cols-2 sm:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-[rgb(var(--border-subtle))]/60">
          {STATUSES.map((s) => (
            <div key={s} className="px-4 py-3 flex items-center justify-between sm:flex-col sm:items-start sm:gap-1">
              <TaskStatusBadge status={s} />
              <span className="text-xl font-bold text-[rgb(var(--text-primary))] font-mono">{depth[s] ?? 0}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* ── Last ship-step verdict (task-79a07a7c) ──────────────── */}
      <LastShipVerdictCard verdict={autoship.lastVerdict} />

      {/* ── Per-repo runner activity (runner.out) ───────────────── */}
      <Card
        title="Per-repo runner activity"
        meta={`${health.repos.length} repo(s) · generated ${timeAgo(health.generatedAt)}`}
      >
        {health.repos.length === 0 ? (
          <EmptyState>No fires recorded in the runner log yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="card-table w-full text-sm">
              <THead
                cols={[
                  { label: 'Repo' },
                  { label: 'Last fire' },
                  { label: 'Outcome' },
                  { label: 'Fires', align: 'right' },
                  { label: '0-work', align: 'right' },
                  { label: 'Streak', align: 'right' },
                  { label: 'Last RESULT' },
                ]}
              />
              <tbody className="divide-y divide-[rgb(var(--border-subtle))]/50">
                {health.repos.map((r) => (
                  <tr key={r.repo} className={`hover:bg-[rgb(var(--bg-hover))]/30 ${r.stalled ? 'bg-red-950/20' : ''}`}>
                    <td className="m-title px-4 py-2.5 text-[rgb(var(--text-primary))] font-mono text-xs">{r.repo}</td>
                    <td data-label="Last fire" className="px-4 py-2.5 text-[rgb(var(--text-muted))] text-xs">{timeAgo(r.lastFireAt)}</td>
                    <td data-label="Outcome" className="px-4 py-2.5"><OutcomeBadge outcome={r.lastOutcome} /></td>
                    <td data-label="Fires" className="px-4 py-2.5 text-right font-mono text-[rgb(var(--text-secondary))]">{r.fires}</td>
                    <td data-label="0-work" className="px-4 py-2.5 text-right font-mono text-[rgb(var(--text-muted))]">{r.zeroWork}</td>
                    <td data-label="Streak" className="px-4 py-2.5 text-right font-mono">
                      <span className={r.stalled ? 'text-red-400 font-bold' : r.consecutiveZeroWork > 0 ? 'text-yellow-400' : 'text-zinc-600'}>
                        {r.consecutiveZeroWork}
                      </span>
                    </td>
                    <td data-label="Last RESULT" className="px-4 py-2.5 text-[rgb(var(--text-secondary))] text-xs max-w-md truncate" title={r.lastResult ?? ''}>
                      {r.lastResult ?? <span className="text-zinc-600">running…</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <RecentRoutingCard routedTasks={routedTasks} />
    </div>
  );
}
