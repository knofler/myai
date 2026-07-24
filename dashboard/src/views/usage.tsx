import { StatCard } from '@/components/ui/card';
import { connectDB, UsageEvent, User } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

// ADR-014 S2 slice 2 — Product-usage meter panel (the /system → Usage tab).
//
// Sibling to the Costs tab (BudgetUsage / LLM spend). Where Costs answers
// "what did we SPEND?", this answers "what did the customer USE?" in the
// billable product units the pricing page sells — runner tasks executed,
// off-hours minutes, apps generated, agents invoked.
//
// Tenant-scoped exactly like every other dashboard view (ADR-010 §7.2): it
// renders the ACTIVE tenant's own consumption (the "by tenant" dimension is the
// scoping context shown in the header, never a cross-tenant leak). Within that
// tenant it breaks usage down by tool (event type), member (userId), and day
// buckets. Reads Mongo directly (read-only mirror), matching costs.tsx.

interface AggTotal { _id: null; total: number }
interface GroupBucket { _id: string | null; quantity: number; events: number }
interface DayBucket { _id: string; quantity: number; events: number }

// Friendly labels for the closed UsageEventType vocabulary (runtime/db.ts).
const TYPE_LABELS: Record<string, string> = {
  'task.executed': 'Tasks executed',
  'offhours.minutes': 'Off-hours minutes',
  'app.generated': 'Apps generated',
  'ticket.bridged': 'Tickets bridged',
  'agent.invoked': 'Agents invoked',
  'schedule.dispatched': 'Schedules dispatched',
};

function labelType(t: string | null): string {
  if (!t) return '(unknown)';
  return TYPE_LABELS[t] ?? t;
}

function startOfMonthUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function startOfDayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function thirtyDaysAgoUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29));
}

function lastNDates(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export default async function UsagePage() {
  await connectDB();

  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);

  const monthStart = startOfMonthUTC();
  const dayStart = startOfDayUTC();
  const thirtyDaysStart = thirtyDaysAgoUTC();

  const [
    allTimeAgg,
    mtdAgg,
    todayAgg,
    byType,
    byUserRaw,
    byRepo,
    dayBuckets,
    members,
  ] = await Promise.all([
    // Total events (all time) — quantity summed
    UsageEvent.aggregate<AggTotal>([
      { $match: { ...tf } },
      { $group: { _id: null, total: { $sum: '$quantity' } } },
    ]),
    // This month
    UsageEvent.aggregate<AggTotal>([
      { $match: { ...tf, occurredAt: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: '$quantity' } } },
    ]),
    // Today
    UsageEvent.aggregate<AggTotal>([
      { $match: { ...tf, occurredAt: { $gte: dayStart } } },
      { $group: { _id: null, total: { $sum: '$quantity' } } },
    ]),
    // By tool (event type) — MTD
    UsageEvent.aggregate<GroupBucket>([
      { $match: { ...tf, occurredAt: { $gte: monthStart } } },
      { $group: { _id: '$type', quantity: { $sum: '$quantity' }, events: { $sum: 1 } } },
      { $sort: { quantity: -1 } },
    ]),
    // By member (userId) — MTD
    UsageEvent.aggregate<GroupBucket>([
      { $match: { ...tf, occurredAt: { $gte: monthStart } } },
      { $group: { _id: '$userId', quantity: { $sum: '$quantity' }, events: { $sum: 1 } } },
      { $sort: { quantity: -1 } },
    ]),
    // By repo — MTD
    UsageEvent.aggregate<GroupBucket>([
      { $match: { ...tf, occurredAt: { $gte: monthStart } } },
      { $group: { _id: '$repo', quantity: { $sum: '$quantity' }, events: { $sum: 1 } } },
      { $sort: { quantity: -1 } },
    ]),
    // Day buckets (30 days) — quantity + events
    UsageEvent.aggregate<DayBucket>([
      { $match: { ...tf, occurredAt: { $gte: thirtyDaysStart } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt', timezone: 'UTC' } },
          quantity: { $sum: '$quantity' },
          events: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    // Member display names for the by-member table
    User.find({ ...tf }).select('userId email displayName').lean() as Promise<Array<{ userId?: string; email?: string; displayName?: string }>>,
  ]);

  const allTime = allTimeAgg[0]?.total ?? 0;
  const mtd = mtdAgg[0]?.total ?? 0;
  const today = todayAgg[0]?.total ?? 0;

  // Off-hours minutes MTD (a distinct billable unit worth a stat card).
  const offhoursMtd = byType.find(t => t._id === 'offhours.minutes')?.quantity ?? 0;

  const nameByUser = new Map<string, string>(
    members
      .filter(m => m.userId)
      .map(m => [m.userId as string, m.displayName || m.email || (m.userId as string)]),
  );

  // Build 30-day series, filling missing days with 0.
  const dates = lastNDates(30);
  const bucketsByDate = new Map<string, DayBucket>(dayBuckets.map(b => [b._id, b]));
  const daySeries: DayBucket[] = dates.map(d => bucketsByDate.get(d) ?? { _id: d, quantity: 0, events: 0 });
  const maxDayQty = Math.max(...daySeries.map(d => d.quantity), 1);
  const numFmt = new Intl.NumberFormat('en-US');

  const anyData = allTime > 0;

  return (
    <div>
      {/* ── Stat cards ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total units (all time)" value={numFmt.format(allTime)} sub="Across all event types" accent="green" />
        <StatCard label="This month" value={numFmt.format(mtd)} sub={`Since ${monthStart.toISOString().slice(0, 10)} UTC`} accent="blue" />
        <StatCard label="Today" value={numFmt.format(today)} sub={`Since ${dayStart.toISOString().slice(0, 10)} UTC`} accent={today > 0 ? 'yellow' : 'gray'} />
        <StatCard label="Off-hours minutes (MTD)" value={numFmt.format(offhoursMtd)} sub="Runner wall-clock consumed" accent="purple" />
      </div>

      {!anyData && (
        <div className="mb-8 bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center text-sm text-zinc-500">
          No product-usage events recorded yet for this tenant. Metering is on by default (set
          <code className="text-zinc-400"> METERING_ENABLED=false</code> to disable); events are emitted fire-and-forget
          from gateway chokepoints — run a task, generate an app, or invoke an agent to populate the meter.
        </div>
      )}

      {/* ── By tool (event type) — MTD ─────────────────────────── */}
      <div className="mb-8 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">By tool (MTD)</h2>
          <span className="text-xs text-zinc-500">{byType.length} type(s)</span>
        </div>
        {byType.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">No events this month.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="card-table w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Event type</th>
                  <th className="px-4 py-3 text-right">Events</th>
                  <th className="px-4 py-3 text-right">Quantity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {byType.map((row) => (
                  <tr key={row._id ?? 'unknown'} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="m-title px-4 py-2.5 text-zinc-300">{labelType(row._id)}</td>
                    <td data-label="Events" className="px-4 py-2.5 text-right text-zinc-400 font-mono">{numFmt.format(row.events)}</td>
                    <td data-label="Quantity" className="px-4 py-2.5 text-right text-zinc-200 font-mono font-semibold">{numFmt.format(row.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── By member — MTD ────────────────────────────────────── */}
      <div className="mb-8 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">By member (MTD)</h2>
          <span className="text-xs text-zinc-500">{byUserRaw.length} principal(s)</span>
        </div>
        {byUserRaw.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">No events this month.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="card-table w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Member</th>
                  <th className="px-4 py-3 text-right">Events</th>
                  <th className="px-4 py-3 text-right">Quantity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {byUserRaw.map((row) => (
                  <tr key={row._id ?? 'system'} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="m-title px-4 py-2.5 text-zinc-300">
                      {row._id ? (nameByUser.get(row._id) ?? row._id) : <span className="text-zinc-500 italic">system / unattributed</span>}
                    </td>
                    <td data-label="Events" className="px-4 py-2.5 text-right text-zinc-400 font-mono">{numFmt.format(row.events)}</td>
                    <td data-label="Quantity" className="px-4 py-2.5 text-right text-zinc-200 font-mono font-semibold">{numFmt.format(row.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Daily units (30 days) ──────────────────────────────── */}
      <div className="mb-8 bg-zinc-900 border border-zinc-800 rounded-lg p-5">
        <h2 className="text-lg font-semibold mb-4">Daily units (30 days)</h2>
        <div className="space-y-1">
          {daySeries.map((d) => {
            const widthPct = (d.quantity / maxDayQty) * 100;
            const isToday = d._id === dates[dates.length - 1];
            return (
              <div key={d._id} className="flex items-center gap-3 text-xs font-mono">
                <span className={`w-20 text-right ${isToday ? 'text-teal-400' : 'text-zinc-500'}`}>{d._id.slice(5)}</span>
                <div className="flex-1 h-4 bg-zinc-950 rounded overflow-hidden relative">
                  <div
                    className={`absolute left-0 top-0 h-full rounded ${isToday ? 'bg-teal-500/60' : 'bg-zinc-600'}`}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
                <span className={`w-16 text-right ${d.quantity > 0 ? 'text-zinc-300' : 'text-zinc-700'}`}>
                  {d.quantity > 0 ? numFmt.format(d.quantity) : '—'}
                </span>
                <span className="w-10 text-right text-zinc-600">{d.events > 0 ? `${d.events}` : ''}</span>
              </div>
            );
          })}
        </div>
        {daySeries.every(d => d.quantity === 0) && (
          <div className="mt-3 text-xs text-zinc-600 text-center">No events recorded in the last 30 days.</div>
        )}
      </div>

      {/* ── By repo — MTD ──────────────────────────────────────── */}
      {byRepo.some(r => r._id) && (
        <div className="mb-8 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">By repo (MTD)</h2>
            <span className="text-xs text-zinc-500">{byRepo.filter(r => r._id).length} repo(s)</span>
          </div>
          <div className="overflow-x-auto">
            <table className="card-table w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Repo</th>
                  <th className="px-4 py-3 text-right">Events</th>
                  <th className="px-4 py-3 text-right">Quantity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {byRepo.filter(r => r._id).map((row) => (
                  <tr key={row._id as string} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="m-title px-4 py-2.5 font-mono text-zinc-300">{row._id}</td>
                    <td data-label="Events" className="px-4 py-2.5 text-right text-zinc-400 font-mono">{numFmt.format(row.events)}</td>
                    <td data-label="Quantity" className="px-4 py-2.5 text-right text-zinc-200 font-mono font-semibold">{numFmt.format(row.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
