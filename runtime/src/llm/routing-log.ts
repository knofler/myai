// Live routing-decision log (plan/MULTI_PROVIDER_ORCHESTRATION.md L5).
//
// Ring buffer of the most recent tier-router decisions taken by REAL LLM
// traffic — the two route() call sites in provider.ts (complete /
// completeStream), NOT the routing_info debug tool, which is a "what would
// happen" query and would pollute the live feed. Same in-memory pattern as
// failover-backoff.ts's recentDroppedHops: gateway-lifetime only, surfaced on
// the all-providers `provider_health` MCP response for the dashboard's
// capacity view, so an operator can see WHERE work is actually being routed
// (provider/model/reason) next to each pool's remaining budget.

import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'llm-routing-log' });

/** Which real-traffic path recorded the decision. */
export type RoutingDecisionSource = 'complete' | 'stream';

export interface RoutingDecisionEvent {
  atIso: string;
  provider: string;
  model: string;
  /** Human-readable explanation from RoutingDecision.reason (router.ts). */
  reason: string;
  source: RoutingDecisionSource;
}

/** Ring buffer of the most recent routing decisions, newest first. */
const MAX_RECENT_DECISIONS = 50;
let recentDecisions: RoutingDecisionEvent[] = [];

/** Record a tier-router decision made for an actual LLM call. */
export function recordRoutingDecision(event: Omit<RoutingDecisionEvent, 'atIso'>): void {
  recentDecisions = [{ ...event, atIso: new Date().toISOString() }, ...recentDecisions].slice(0, MAX_RECENT_DECISIONS);
  log.debug({ event }, 'Routing decision recorded');
}

/** Most recent routing decisions, newest first (optionally capped to `limit`). */
export function getRecentRoutingDecisions(limit?: number): RoutingDecisionEvent[] {
  if (limit === undefined || !Number.isFinite(limit)) return recentDecisions;
  return recentDecisions.slice(0, Math.max(0, Math.floor(limit)));
}

/** Test-only: reset the decision log. */
export function resetRoutingLog(): void {
  recentDecisions = [];
}
