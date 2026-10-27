// Home savings hero (DASHBOARD_REDESIGN B4) — the product's headline metric,
// promoted out of /savings onto Mission Control: tokens saved this week (every
// boot myAI serves context instead of re-teaching it by hand), sessions
// boosted, cost avoided, and a 7-day trend sparkline. Presentational only —
// the page supplies the already-aggregated trend so this stays a server render
// with zero data access. Tokens-only colours (savings reads --ok/emerald,
// interactive accents --accent/teal); no new literal palette.

import Link from 'next/link';
import { fmtTokens, fmtUsd } from '@/lib/format';
import type { SavingsTrend } from '@/lib/savings';

function Sparkline({ daily }: { daily: SavingsTrend['daily'] }) {
  const max = Math.max(1, ...daily.map((d) => d.tokens));
  return (
    <div className="flex items-end gap-1 h-14" aria-hidden>
      {daily.map((d, i) => {
        const isToday = i === daily.length - 1;
        return (
          <div
            key={d.date}
            className={`flex-1 rounded-sm transition-colors ${
              d.tokens > 0
                ? isToday
                  ? 'bg-[rgb(var(--accent))]'
                  : 'bg-[rgb(var(--ok))]/60'
                : 'bg-[rgb(var(--bg-hover))]'
            }`}
            style={{ height: `${Math.max(6, (d.tokens / max) * 100)}%` }}
            title={`${d.date}: ${fmtTokens(d.tokens)} tokens · ${d.boots} boots`}
          />
        );
      })}
    </div>
  );
}

function TrendPill({ deltaPct }: { deltaPct: number | null }) {
  if (deltaPct === null) {
    return <span className="text-xs text-[rgb(var(--text-muted))]">no prior week</span>;
  }
  const pct = Math.round(deltaPct * 100);
  const up = pct >= 0;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium ${up ? 'text-[rgb(var(--ok))]' : 'text-[rgb(var(--err))]'}`}
      title="tokens saved this week vs the prior 7 days"
    >
      {up ? '▲' : '▼'} {up ? '+' : ''}{pct}% wow
    </span>
  );
}

export function SavingsHero({ trend }: { trend: SavingsTrend }) {
  const { week } = trend;
  return (
    <section className="gel-surface bg-[rgb(var(--bg-surface))]/70 border border-emerald-500/30 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[rgb(var(--border-subtle))]/80 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-emerald-300">Tokens saved this week</h2>
        <Link href="/savings" className="text-xs text-[rgb(var(--text-muted))] hover:text-emerald-400">
          savings & share card →
        </Link>
      </div>
      <div className="p-4 grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
        {/* Headline: tokens saved this week */}
        <div className="md:col-span-1">
          <p className="text-label text-[rgb(var(--text-muted))] uppercase tracking-wider">Tokens saved (7d)</p>
          <p className="text-3xl font-bold mt-1 text-[rgb(var(--ok))] font-mono tabular-nums">{fmtTokens(week.tokens)}</p>
          <div className="mt-1"><TrendPill deltaPct={trend.deltaPct} /></div>
        </div>
        {/* Sessions boosted */}
        <div className="md:col-span-1">
          <p className="text-label text-[rgb(var(--text-muted))] uppercase tracking-wider">Sessions boosted</p>
          <p className="text-2xl font-bold mt-1 text-[rgb(var(--text-primary))] font-mono tabular-nums">{week.boots.toLocaleString()}</p>
          <p className="text-xs text-[rgb(var(--text-muted))] mt-1">context served, not re-taught</p>
        </div>
        {/* Cost avoided */}
        <div className="md:col-span-1">
          <p className="text-label text-[rgb(var(--text-muted))] uppercase tracking-wider">Cost avoided</p>
          <p className="text-2xl font-bold mt-1 text-[rgb(var(--ok))] font-mono tabular-nums">{fmtUsd(week.usd)}</p>
          <p className="text-xs text-[rgb(var(--text-muted))] mt-1">@ ${trend.usdPerMTokens}/M input tokens</p>
        </div>
        {/* Trend sparkline */}
        <div className="md:col-span-1">
          <p className="text-label text-[rgb(var(--text-muted))] uppercase tracking-wider mb-2">Last 7 days</p>
          <Sparkline daily={trend.daily} />
        </div>
      </div>
    </section>
  );
}
