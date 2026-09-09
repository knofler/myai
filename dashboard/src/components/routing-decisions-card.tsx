// Live routing-decisions card (plan/MULTI_PROVIDER_ORCHESTRATION.md L5) —
// renders the gateway tier-router's last N real-traffic decisions
// (provider/model/reason from runtime/src/llm/router.ts via the routing-log
// ring buffer) under the pool-capacity gauges on /work → Scheduled Runs.
// `decisions` is null when the gateway is unreachable → render nothing, same
// posture as PoolCapacityPanel when its artifact is absent.

import { Card, EmptyState } from '@/components/ui/card';
import { ModelBadge } from '@/components/ui/badge';
import { timeAgo } from '@/lib/format';
import type { RoutingDecisionEvent } from '@/lib/routing-decisions';

export function RoutingDecisionsCard({ decisions }: { decisions: RoutingDecisionEvent[] | null }) {
  if (decisions === null) return null;
  return (
    <Card
      title="Live routing decisions"
      meta={`gateway tier router · last ${decisions.length || 'N'} real LLM calls, newest first`}
    >
      {decisions.length === 0 ? (
        <EmptyState>
          No routing decisions recorded since gateway boot — the feed fills as chat/agents/skills traffic
          flows through the tier router.
        </EmptyState>
      ) : (
        <table className="card-table w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-[rgb(var(--text-muted))] border-b border-[rgb(var(--border-subtle))] uppercase tracking-wider">
              <th className="px-4 py-2.5 font-medium">When</th>
              <th className="px-4 py-2.5 font-medium">Provider</th>
              <th className="px-4 py-2.5 font-medium">Model</th>
              <th className="px-4 py-2.5 font-medium">Path</th>
              <th className="px-4 py-2.5 font-medium">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[rgb(var(--border-subtle))]/50">
            {decisions.map((d, i) => (
              <tr key={`${d.atIso}-${i}`} className="hover:bg-[rgb(var(--bg-hover))]/30">
                <td data-label="When" className="px-4 py-2.5 text-zinc-600 text-xs whitespace-nowrap">{timeAgo(d.atIso)}</td>
                <td data-label="Provider" className="px-4 py-2.5 text-[rgb(var(--text-primary))] font-mono text-xs">{d.provider}</td>
                <td data-label="Model" className="px-4 py-2.5"><ModelBadge model={d.model} /></td>
                <td data-label="Path" className="m-hide px-4 py-2.5 text-[rgb(var(--text-muted))] text-xs">{d.source}</td>
                <td data-label="Reason" className="px-4 py-2.5 text-[rgb(var(--text-secondary))] text-xs max-w-lg truncate" title={d.reason}>{d.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
