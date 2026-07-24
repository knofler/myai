// /recap — the tenant-facing "year in review" usage recap + shareable card.
//
// Sibling to /savings (the "tokens saved" viral card): where /savings answers
// "how much context re-teaching did myAI save you", this answers the bigger,
// shareable question a customer can put in front of their own boss or
// prospects — tasks shipped, engineer-hours saved, apps generated, off-hours
// minutes worked, over the trailing year. Distinct from the operator MRR/ARR/
// NRR dashboards (/revenue) and the internal KPI-digest email — this is a
// marketing-grade value recap meant to drive retention + word-of-mouth, not a
// revenue view.

import { connectDB, Tenant } from '@/lib/db';
import { getActiveTenant, tenantFilter, DEFAULT_TENANT_ID } from '@/lib/tenant';
import { getUsageRecap } from '@/lib/usage-recap';
import { PageHeader } from '@/components/page-header';
import { StatCard, Card } from '@/components/ui/card';
import AutoRefresh from '@/components/auto-refresh';
import ShareButton from './share-button';

export const dynamic = 'force-dynamic';

const numFmt = new Intl.NumberFormat('en-US');
function fmtHours(n: number): string {
  return n < 10 ? n.toFixed(1) : numFmt.format(Math.round(n));
}

export default async function RecapPage() {
  let dbError = false;
  try { await connectDB(); } catch { dbError = true; }

  const tenantId = dbError ? DEFAULT_TENANT_ID : await getActiveTenant();
  const [recap, tenantDoc] = dbError
    ? [
        { periodStart: '', periodEnd: '', tasksShipped: 0, appsGenerated: 0, offhoursMinutes: 0, offhoursHours: 0, engineerHoursSaved: 0, hoursPerTask: 0 },
        null,
      ]
    : await Promise.all([
        getUsageRecap(tenantFilter(tenantId)),
        Tenant.findOne({ tenantId }).select('name').lean() as Promise<{ name?: string } | null>,
      ]);

  const teamName = tenantDoc?.name || 'my team';
  const shareText = `${teamName} shipped ${numFmt.format(recap.tasksShipped)} tasks and saved ${fmtHours(recap.engineerHoursSaved)} engineer-hours with myAI this past year.`;

  return (
    <div className="max-w-5xl mx-auto">
      <AutoRefresh seconds={300} />
      <PageHeader
        title="Year in review"
        subtitle="Everything myAI shipped for your team over the past year — shareable, so you can show it off."
      />

      {dbError && (
        <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          Database unreachable — showing zeros.
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Tasks shipped" value={numFmt.format(recap.tasksShipped)} accent="blue" />
        <StatCard label="Engineer-hours saved" value={fmtHours(recap.engineerHoursSaved)} sub={`@ ${recap.hoursPerTask}h/task + off-hours`} accent="green" />
        <StatCard label="Apps generated" value={numFmt.format(recap.appsGenerated)} accent="purple" />
        <StatCard label="Off-hours minutes" value={numFmt.format(recap.offhoursMinutes)} sub={`${fmtHours(recap.offhoursHours)}h unattended`} accent="yellow" />
      </div>

      <div className="mb-8">
        <Card title="Your recap card" meta="Copy it into Slack, X, or a deck" accent="purple">
          <div className="p-5 space-y-4">
            <div className="rounded-xl overflow-hidden border border-zinc-800 bg-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/recap/card" alt={shareText} className="w-full h-auto" />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <ShareButton cardUrl="/recap/card" text={shareText} />
              <a
                href="/recap/card"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-zinc-400 hover:text-zinc-200 underline underline-offset-4"
              >
                Open card image ↗
              </a>
            </div>
            <p className="text-xs text-zinc-500">
              Covers {recap.periodStart || '—'} through {recap.periodEnd || '—'}. Tenant-scoped — only your own team&apos;s usage.
            </p>
          </div>
        </Card>
      </div>

      <p className="text-xs text-zinc-600">
        Engineer-hours saved assumes {recap.hoursPerTask || 0.75}h of manual work per shipped task, plus off-hours runner
        time worked unattended. See fleet-wide product usage on <a href="/system" className="underline underline-offset-2 hover:text-zinc-400">System → Usage</a>, and
        cold-start token savings on <a href="/savings" className="underline underline-offset-2 hover:text-zinc-400">Savings</a>.
      </p>
    </div>
  );
}
