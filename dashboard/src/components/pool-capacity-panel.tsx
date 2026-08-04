// Capacity strip for the Scheduled Runs tab — the runner's fuel gauges, from
// state/pool-capacity.json (pool_capacity_snapshot.sh bridge): the claude-tech
// weekly token pool, the metered API-credit RESERVE (task-874364a3, remaining
// of the hard-capped personal-credit pot), and the non-Claude agentic-fallback
// lane's own daily USD ledger (task-eac0704e — scripts/lib/agentic_fallback.sh;
// previously only visible by reading the raw ledger file on the machine that
// ran it). Renders nothing when the artifact is absent (fresh clone / producer
// not wired yet).
//
// task-80ba3a74: the $ side of the agentic-fallback lane has lived here since
// task-eac0704e, but the QUALITY side (agentic_quality_pass_rate, commit
// 28a7231 — "does DeepSeek's review-rate justify the spend") was only ever a
// log-text line in logs/claude_log.md. AgenticQualityRow below renders the
// same per-provider pass-rate + a tiny recent-outcome sparkline right under
// the spend StatCard, off the qualityByProvider array pool_capacity_snapshot.sh
// now embeds in the agentic-fallback pool entry.

import { StatCard } from '@/components/ui/card';
import { fmtUsd } from '@/lib/format';
import type { PoolCapacity, PoolCapacityQuality } from '@/lib/pool-capacity';

/** Unicode block sparkline: 1 = pass, 0 = fail, oldest → newest, left to right. */
function sparkline(recent: number[]): string {
  return recent.map((v) => (v ? '█' : '▁')).join('');
}

function AgenticQualityRow({ providers }: { providers: PoolCapacityQuality[] }) {
  if (providers.length === 0) return null;
  return (
    <div className="col-span-2 md:col-span-4 flex flex-wrap gap-x-6 gap-y-1.5 -mt-1 px-1">
      {providers.map((p) => (
        <div key={p.provider} className="flex items-center gap-2 text-xs" title={`${p.provider} pass-rate over last ${p.window} outcomes`}>
          <span className="text-zinc-500 uppercase tracking-wider">{p.provider}</span>
          <span className={p.passRate === null ? 'text-zinc-600' : p.passRate >= 0.7 ? 'text-emerald-400' : p.passRate >= 0.4 ? 'text-yellow-400' : 'text-red-400'}>
            {p.passRate === null ? 'n/a' : `${Math.round(p.passRate * 100)}%`}
          </span>
          <span className="text-zinc-600">(n={p.n})</span>
          {p.recent.length > 0 && (
            <span className="font-mono text-zinc-500 tracking-tighter" aria-hidden="true">{sparkline(p.recent)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function PoolCapacityPanel({ capacity }: { capacity: PoolCapacity }) {
  if (!capacity.available) return null;
  const tokenPool = capacity.pools.find((p) => p.kind !== 'usd-reserve' && (p.weeklyBudgetTokens ?? 0) > 0);
  const reserve = capacity.pools.find((p) => p.kind === 'usd-reserve');
  const agentic = capacity.pools.find((p) => p.pool === 'agentic-fallback');
  if (!tokenPool && !reserve && !agentic) return null;
  const fmtTok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
  const qualityByProvider = agentic?.qualityByProvider ?? [];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {tokenPool && (
        <StatCard
          label={`${tokenPool.pool} — week ${capacity.week ?? ''}`}
          value={`${fmtTok(tokenPool.weeklyRemainingTokens ?? 0)} tok left`}
          sub={`${tokenPool.pctUsedWeekly ?? 0}% of weekly budget used`}
          accent={(tokenPool.pctUsedWeekly ?? 0) >= 80 ? 'yellow' : 'green'}
        />
      )}
      {reserve && (
        <StatCard
          label="API-credit reserve"
          value={reserve.enabled ? `${fmtUsd(reserve.remainingUsd ?? 0)} left` : 'off'}
          sub={reserve.enabled
            ? `${fmtUsd(reserve.spentUsd ?? 0)} drawn of ${fmtUsd(reserve.hardCapUsd ?? 0)} hard cap`
            : 'MYAI_API_CREDIT_USD unset — last-resort metered pool'}
          accent={reserve.enabled ? ((reserve.pctUsedUsd ?? 0) >= 80 ? 'yellow' : 'blue') : 'gray'}
        />
      )}
      {agentic && (
        <StatCard
          label="Agentic fallback (DeepSeek/Kimi)"
          value={agentic.enabled ? `${fmtUsd(agentic.remainingUsd ?? 0)} left today` : 'off'}
          sub={agentic.enabled
            ? `${fmtUsd(agentic.spentUsd ?? 0)} drawn of ${fmtUsd(agentic.capUsd ?? 0)} daily cap`
            : 'AGENTIC_FALLBACK=off — non-Claude fallback lane'}
          accent={agentic.enabled ? ((agentic.pctUsedUsd ?? 0) >= 80 ? 'yellow' : 'blue') : 'gray'}
        />
      )}
      {agentic?.enabled && <AgenticQualityRow providers={qualityByProvider} />}
    </div>
  );
}
