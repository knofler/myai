// /savings — per-user cumulative cold-start savings + the viral share card.
//
// Deepens the /analytics cold-start meter (ADR-014 / B7) into a personal,
// shareable view: how many tokens (and $) myAI saved this member/team by serving
// context on every boot instead of re-teaching it by hand. The share card
// (/savings/card SVG) is the loop — copy it into Slack / X / a README.

import { connectDB } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { getUserSavings } from '@/lib/savings';
import { fmtTokens, fmtUsd } from '@/lib/format';
import { StatCard, Card, EmptyState } from '@/components/ui/card';
import { DataTable, type DataRow } from '@/components/ui/data-table';
import { PageHeader } from '@/components/page-header';
import AutoRefresh from '@/components/auto-refresh';
import ShareButton from './share-button';

export const dynamic = 'force-dynamic';

export default async function SavingsPage() {
  let dbError = false;
  try { await connectDB(); } catch { dbError = true; }

  const tenantId = dbError ? '' : await getActiveTenant();
  const summary = dbError
    ? { month: { tokens: 0, boots: 0, usd: 0 }, total: { tokens: 0, boots: 0, usd: 0 }, byUser: [], usdPerMTokens: 3, monthStart: '' }
    : await getUserSavings(tenantFilter(tenantId));

  const { month, total, byUser } = summary;
  const shareText = `myAI saved my team ${fmtTokens(month.tokens)} tokens (${fmtUsd(month.usd)}) of context re-teaching this month.`;

  const memberRows: DataRow[] = byUser.map((u) => ({
    id: u.userId || 'system',
    search: (u.userId || 'system agent').toLowerCase(),
    sort: { member: u.userId || '~', tokens: u.tokens, usd: u.usd, boots: u.boots },
    cells: [
      u.userId
        ? <span className="font-mono text-[rgb(var(--text-primary))]">{u.userId}</span>
        : <span className="text-zinc-600">system / agent</span>,
      <span className="text-emerald-400 font-semibold font-mono">{fmtTokens(u.tokens)}</span>,
      <span className="text-emerald-400 font-mono">{fmtUsd(u.usd)}</span>,
      <span className="text-[rgb(var(--text-secondary))] font-mono">{u.boots.toLocaleString()}</span>,
      u.userId ? (
        <a href={`/savings/card?userId=${encodeURIComponent(u.userId)}`} target="_blank" rel="noopener noreferrer" className="text-[rgb(var(--text-muted))] hover:text-emerald-300 underline underline-offset-2">card ↗</a>
      ) : <span className="text-zinc-700">—</span>,
    ],
  }));

  return (
    <div className="max-w-5xl mx-auto">
      <AutoRefresh seconds={60} />
      <PageHeader
        title="Tokens saved"
        subtitle="Every boot, myAI serves your context instead of you re-teaching it by hand. This is what that saved — cumulative, and shareable."
      />

      {dbError && (
        <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          Database unreachable — showing zeros. The meter fills as agents boot via the gateway.
        </div>
      )}

      {/* Headline savings */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Tokens saved (month)" value={fmtTokens(month.tokens)} sub={`${month.boots.toLocaleString()} boots`} accent="green" />
        <StatCard label="$ saved (month)" value={fmtUsd(month.usd)} sub={`@ $${summary.usdPerMTokens}/M tokens`} accent="green" />
        <StatCard label="Tokens saved (all-time)" value={fmtTokens(total.tokens)} sub={`${total.boots.toLocaleString()} boots`} accent="blue" />
        <StatCard label="$ saved (all-time)" value={fmtUsd(total.usd)} accent="blue" />
      </div>

      {/* Share card + CTA */}
      <div className="mb-8">
        <Card title="Your share card" meta="Copy it into Slack, X, or your README" accent="emerald">
          <div className="p-5 space-y-4">
            <div className="rounded-xl overflow-hidden border border-[rgb(var(--border-subtle))] bg-black">
              {/* The exact image the /savings/card endpoint serves. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/savings/card" alt={shareText} className="w-full h-auto" />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <ShareButton cardUrl="/savings/card" text={shareText} />
              <a
                href="/savings/card"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-[rgb(var(--text-secondary))] hover:text-[rgb(var(--text-primary))] underline underline-offset-4"
              >
                Open card image ↗
              </a>
            </div>
            <p className="text-xs text-[rgb(var(--text-muted))]">
              The card shows this month&apos;s savings and refreshes as agents boot. It&apos;s tenant-scoped — only your own consumption.
            </p>
          </div>
        </Card>
      </div>

      {/* Per-member breakdown */}
      <div className="mb-8">
        {byUser.length === 0 ? (
          <Card title="Per-member savings (this month)" meta="0 contributors">
            <EmptyState>No per-member data yet — boots record a member once the gateway carries a <code className="text-[rgb(var(--text-secondary))]">userId</code> (Team tier).</EmptyState>
          </Card>
        ) : (
          <DataTable
            title="Per-member savings (this month)"
            meta={`${byUser.length} contributor${byUser.length === 1 ? '' : 's'}`}
            searchPlaceholder="Search members…"
            defaultSort="tokens"
            defaultDesc
            columns={[
              { label: 'Member', sortKey: 'member', mobile: 'title' },
              { label: 'Tokens saved', align: 'right', sortKey: 'tokens', mobile: 'meta' },
              { label: '$ saved', align: 'right', sortKey: 'usd', mobile: 'meta' },
              { label: 'Boots', align: 'right', sortKey: 'boots', mobile: 'detail' },
              { label: 'Card', align: 'right', mobile: 'detail' },
            ]}
            rows={memberRows}
          />
        )}
      </div>

      <p className="text-xs text-zinc-600">
        Cold-start tokens are priced at the input-token tier the model would otherwise re-ingest (${summary.usdPerMTokens}/M). See the fleet-wide meter on <a href="/analytics" className="underline underline-offset-2 hover:text-[rgb(var(--text-secondary))]">Analytics</a>.
      </p>
    </div>
  );
}
