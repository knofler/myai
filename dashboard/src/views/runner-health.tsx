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
import { readRunnerHealth, getRunnerLiveness, getFleetMaintenanceStatus, type RunnerRepoHealth } from '@/lib/runner-health';
import { timeAgo, fmtSydney } from '@/lib/format';
import { Card, StatCard, EmptyState, THead } from '@/components/ui/card';
import { Badge, TaskStatusBadge } from '@/components/ui/badge';

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

function OutcomeBadge({ outcome }: { outcome: RunnerRepoHealth['lastOutcome'] }) {
  if (outcome === 'blocked') return <Badge className="bg-red-500/15 text-red-300 border border-red-500/30">blocked</Badge>;
  if (outcome === 'review') return <Badge className="bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">review</Badge>;
  return <Badge className="bg-zinc-700/40 text-zinc-400 border border-zinc-700">running</Badge>;
}

/** Operator kill-switch banner (fleet-maintenance-store.ts) — every runner across
 * the fleet is currently refused a claim, regardless of what the queue/liveness
 * signals below say. Rendered ahead of everything else so it can never be missed. */
function MaintenanceBanner({ maintenance }: { maintenance: Awaited<ReturnType<typeof getFleetMaintenanceStatus>> }) {
  if (!maintenance.active) return null;
  return (
    <div className="bg-amber-950/40 border border-amber-500/50 rounded-xl p-5">
      <div className="flex items-start gap-3">
        <span className="text-2xl leading-none">🚧</span>
        <div>
          <h2 className="text-base font-semibold text-amber-300">
            Fleet maintenance active — all runner claims paused
          </h2>
          <p className="text-sm text-zinc-300 mt-1">
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

function timeAgoFromMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

export default async function RunnerHealthView() {
  await connectDB();
  const [health, depth, liveness, maintenance] = await Promise.all([
    readRunnerHealth(), queueDepth(), getRunnerLiveness(), getFleetMaintenanceStatus(),
  ]);

  if (!health || !health.available) {
    return (
      <div className="space-y-6">
        <MaintenanceBanner maintenance={maintenance} />
        <Card title="Runner Health">
          <EmptyState>
            No runner-health artifact yet. Generate it on the runner host with{' '}
            <code className="text-emerald-400">./scripts/runner_health.sh</code> — it parses{' '}
            <code className="text-zinc-400">~/.ai-cli-runner/runner.out</code> into{' '}
            <code className="text-zinc-400">state/runner-health.json</code>.
          </EmptyState>
        </Card>
      </div>
    );
  }

  const g = health.global;
  const pending = depth.pending ?? 0;
  const blocked = depth.blocked ?? 0;

  return (
    <div className="space-y-6">
      <MaintenanceBanner maintenance={maintenance} />
      {/* ── RED runner-down banner (liveness heartbeat lapsed) ────── */}
      {!liveness.alive && (
        <div className="bg-red-950/40 border border-red-600/50 rounded-xl p-5">
          <div className="flex items-start gap-3">
            <span className="text-2xl leading-none">📡</span>
            <div>
              <h2 className="text-base font-semibold text-red-300">
                {liveness.machines.length === 0
                  ? 'Runner down — no heartbeat ever recorded'
                  : `Runner down — no heartbeat in ${timeAgoFromMinutes(liveness.machines[0].minutesSince)}`}
              </h2>
              <p className="text-sm text-zinc-300 mt-1">
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
            <span className="text-2xl leading-none">🛑</span>
            <div>
              <h2 className="text-base font-semibold text-red-300">
                Zero-work stall — {g.consecutiveZeroWork} consecutive fires shipped nothing
              </h2>
              <p className="text-sm text-zinc-300 mt-1">
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

      {/* ── At-a-glance stats ───────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        <StatCard
          label="Runner liveness"
          value={liveness.alive ? 'alive' : 'down'}
          sub={liveness.machines.length > 0 ? `${liveness.lastMachine} · ${timeAgoFromMinutes(liveness.machines[0].minutesSince)} ago` : 'no heartbeat yet'}
          accent={liveness.alive ? 'green' : 'red'}
        />
        <StatCard
          label="Last fire"
          value={timeAgo(g.lastFireAt)}
          sub={g.lastRepo ? `${g.lastRepo} · ${fmtSydney(g.lastFireAt, 'time')}` : '—'}
          accent={g.lastFireAt ? 'green' : 'gray'}
        />
        <StatCard label="Fires (24h)" value={g.firesLast24h} sub={`${g.totalFires} logged total`} accent="blue" />
        <StatCard
          label="Consecutive 0-work"
          value={g.consecutiveZeroWork}
          sub={`stall at ${health.stallThreshold}`}
          accent={g.stall ? 'red' : g.consecutiveZeroWork > 0 ? 'yellow' : 'green'}
        />
        <StatCard label="Queue: pending" value={pending} sub="awaiting a runner" accent={pending > 0 ? 'yellow' : 'gray'} />
        <StatCard label="Queue: blocked" value={blocked} sub="needs unblocking" accent={blocked > 0 ? 'red' : 'gray'} />
      </div>

      {/* ── Queue depth by status (gateway task store) ──────────── */}
      <Card title="Queue depth — gateway task store" meta="by status">
        <div className="grid grid-cols-2 sm:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-zinc-800/60">
          {STATUSES.map((s) => (
            <div key={s} className="px-4 py-3 flex items-center justify-between sm:flex-col sm:items-start sm:gap-1">
              <TaskStatusBadge status={s} />
              <span className="text-xl font-bold text-zinc-100 font-mono">{depth[s] ?? 0}</span>
            </div>
          ))}
        </div>
      </Card>

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
              <tbody className="divide-y divide-zinc-800/50">
                {health.repos.map((r) => (
                  <tr key={r.repo} className={`hover:bg-zinc-800/30 ${r.stalled ? 'bg-red-950/20' : ''}`}>
                    <td className="m-title px-4 py-2.5 text-zinc-200 font-mono text-xs">{r.repo}</td>
                    <td data-label="Last fire" className="px-4 py-2.5 text-zinc-500 text-xs">{timeAgo(r.lastFireAt)}</td>
                    <td data-label="Outcome" className="px-4 py-2.5"><OutcomeBadge outcome={r.lastOutcome} /></td>
                    <td data-label="Fires" className="px-4 py-2.5 text-right font-mono text-zinc-400">{r.fires}</td>
                    <td data-label="0-work" className="px-4 py-2.5 text-right font-mono text-zinc-500">{r.zeroWork}</td>
                    <td data-label="Streak" className="px-4 py-2.5 text-right font-mono">
                      <span className={r.stalled ? 'text-red-400 font-bold' : r.consecutiveZeroWork > 0 ? 'text-yellow-400' : 'text-zinc-600'}>
                        {r.consecutiveZeroWork}
                      </span>
                    </td>
                    <td data-label="Last RESULT" className="px-4 py-2.5 text-zinc-400 text-xs max-w-md truncate" title={r.lastResult ?? ''}>
                      {r.lastResult ?? <span className="text-zinc-600">running…</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
