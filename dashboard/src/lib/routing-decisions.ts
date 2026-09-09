// Live gateway routing-decision feed (plan/MULTI_PROVIDER_ORCHESTRATION.md L5).
//
// The gateway's tier router (runtime/src/llm/router.ts) records each REAL LLM
// call's decision into an in-memory ring buffer (runtime/src/llm/routing-log.ts)
// and surfaces it on the all-providers `provider_health` MCP response as
// `recentRoutingDecisions`. This reader pulls it for the /work capacity view so
// an operator can see WHERE work is actually routing (provider/model/reason)
// next to each pool's remaining budget — closing the "we can't read /usage" gap.

import { callGateway } from './gateway';

export interface RoutingDecisionEvent {
  atIso: string;
  provider: string;
  model: string;
  reason: string;
  source: 'complete' | 'stream';
}

/**
 * Last N routing decisions, newest first. `null` when the gateway is
 * unreachable (card hides), `[]` when reachable but no decisions recorded yet
 * since gateway boot (card renders its empty state).
 */
export async function fetchRecentRoutingDecisions(limit = 15): Promise<RoutingDecisionEvent[] | null> {
  const res = await callGateway<{ recentRoutingDecisions?: RoutingDecisionEvent[] }>('provider_health');
  if (!res) return null;
  const decisions = Array.isArray(res.recentRoutingDecisions) ? res.recentRoutingDecisions : [];
  return decisions.filter((d) => d && typeof d.provider === 'string' && typeof d.model === 'string').slice(0, limit);
}
