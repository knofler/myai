// Component test for RoutingDecisionsCard (plan/MULTI_PROVIDER_ORCHESTRATION.md
// L5 capacity view) — the gateway records real-traffic tier-router decisions in
// runtime/src/llm/routing-log.ts and surfaces them via provider_health; this
// proves the /work capacity view actually renders that feed (provider, model,
// reason, complete/stream path) and hides cleanly when the gateway is down.
//
// No jsdom/Testing-Library dependency — same pattern as
// pool-capacity-panel.test.tsx: react-dom/server static markup assertions.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoutingDecisionsCard } from './routing-decisions-card';
import type { RoutingDecisionEvent } from '@/lib/routing-decisions';

describe('RoutingDecisionsCard', () => {
  it('renders nothing when the gateway is unreachable (decisions === null)', () => {
    const html = renderToStaticMarkup(<RoutingDecisionsCard decisions={null} />);
    expect(html).toBe('');
  });

  it('renders the empty state when the gateway is reachable but nothing has routed yet', () => {
    const html = renderToStaticMarkup(<RoutingDecisionsCard decisions={[]} />);
    expect(html).toContain('Live routing decisions');
    expect(html).toContain('No routing decisions recorded since gateway boot');
  });

  it('renders provider, model, path, and reason for each decision', () => {
    const decisions: RoutingDecisionEvent[] = [
      {
        atIso: new Date().toISOString(),
        provider: 'deepseek',
        model: 'deepseek-chat',
        reason: "tool 'summarize' mapped to budget",
        source: 'complete',
      },
      {
        atIso: new Date(Date.now() - 5 * 60_000).toISOString(),
        provider: 'api',
        model: 'claude-sonnet-4-6',
        reason: "agent 'security-specialist' mapped to premium",
        source: 'stream',
      },
    ];
    const html = renderToStaticMarkup(<RoutingDecisionsCard decisions={decisions} />);
    expect(html).toContain('deepseek');
    expect(html).toContain('deepseek-chat');
    expect(html).toContain('complete');
    expect(html).toContain('mapped to budget');
    expect(html).toContain('claude-sonnet-4-6');
    expect(html).toContain('stream');
    expect(html).toContain('mapped to premium');
  });
});
