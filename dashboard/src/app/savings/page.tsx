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
            <div className="rounded-xl overflow-hidden border border-zinc-800 bg-black">
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
                className="text-sm text-zinc-400 hover:text-zinc-200 underline underline-offset-4"
              >
                Open card image ↗
              </a>
            </div>
            <p className="text-xs text-zinc-500">
              The card shows this month&apos;s savings and refreshes as agents boot. It&apos;s tenant-scoped — only your own consumption.
            </p>
          </div>
        </Card>
      </div>

      {/* Per-member breakdown */}
      <div className="mb-8">
        <Card title="Per-member savings (this month)" meta={`${byUser.length} contributor${byUser.length === 1 ? '' : 's'}`}>
          <div className="p-5">
            {byUser.length === 0 ? (
              <EmptyState>No per-member data yet — boots record a member once the gateway carries a <code className="text-zinc-400">userId</code> (Team tier).</EmptyState>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
                    <th className="pb-2">Member</th>
                    <th className="pb-2 text-right">Tokens saved</th>
                    <th className="pb-2 text-right">$ saved</th>
                    <th className="pb-2 text-right">Boots</th>
                    <th className="pb-2 text-right">Card</th>
                  </tr>
                </thead>
                <tbody>
                  {byUser.map((u) => (
                    <tr key={u.userId || 'system'} className="border-b border-zinc-900 last:border-0">
                      <td className="py-2 font-mono text-zinc-300">{u.userId || <span className="text-zinc-600">system / agent</span>}</td>
                      <td className="py-2 text-right text-emerald-400 font-semibold">{fmtTokens(u.tokens)}</td>
                      <td className="py-2 text-right text-emerald-400">{fmtUsd(u.usd)}</td>
                      <td className="py-2 text-right text-zinc-400">{u.boots.toLocaleString()}</td>
                      <td className="py-2 text-right">
                        {u.userId ? (
                          <a href={`/savings/card?userId=${encodeURIComponent(u.userId)}`} target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-emerald-300 underline underline-offset-2">card ↗</a>
                        ) : <span className="text-zinc-700">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>

      <p className="text-xs text-zinc-600">
        Cold-start tokens are priced at the input-token tier the model would otherwise re-ingest (${summary.usdPerMTokens}/M). See the fleet-wide meter on <a href="/analytics" className="underline underline-offset-2 hover:text-zinc-400">Analytics</a>.
      </p>
    </div>
  );
}
