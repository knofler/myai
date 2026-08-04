// Component test for RetrievalStrategyCard (task-49fda69b) — the /brain
// Overview card surfacing which retrieval_bandit arm (BRAIN B-7) is currently
// favored per query context, sourced from the gateway's read-only
// `brain_bandit_stats` snapshot. No jsdom/Testing-Library dependency: renders
// to a static HTML string via react-dom/server, same pattern as
// components/ui/badge.test.tsx.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RetrievalStrategyCard } from './brain';
import type { BanditStats } from '@/lib/brain';

const POPULATED: BanditStats = {
  available: true,
  totalPulls: 23,
  contexts: [
    {
      context: 's:code',
      favoredArm: { k: 5, rerank_on: true },
      pullsTotal: 20,
      arms: [
        { arm: '{"k": 3, "rerank_on": false}', k: 3, rerankOn: false, pulls: 3, rewardSum: 0.6, meanReward: 0.2 },
        { arm: '{"k": 5, "rerank_on": true}', k: 5, rerankOn: true, pulls: 17, rewardSum: 13.6, meanReward: 0.8 },
      ],
    },
    {
      context: 'l:memory',
      favoredArm: null,
      pullsTotal: 0,
      arms: [],
    },
  ],
};

describe('RetrievalStrategyCard', () => {
  it('renders the favored config and mean reward per context', () => {
    const html = renderToStaticMarkup(<RetrievalStrategyCard stats={POPULATED} />);
    expect(html).toContain('Retrieval strategy');
    expect(html).toContain('s:code');
    expect(html).toContain('k=5, rerank on');
    expect(html).toContain('0.800');
    expect(html).toContain('20'); // pulls total for s:code
    expect(html).toContain('23 recorded pulls');
  });

  it('renders a placeholder for a context with no recorded pulls', () => {
    const html = renderToStaticMarkup(<RetrievalStrategyCard stats={POPULATED} />);
    expect(html).toContain('l:memory');
    expect(html).toContain('no data yet');
  });

  it('renders an empty state when the bandit has no data at all', () => {
    const html = renderToStaticMarkup(
      <RetrievalStrategyCard stats={{ available: false, totalPulls: 0, contexts: [] }} />,
    );
    expect(html).toContain('No bandit data yet');
    expect(html).not.toContain('Favored config');
  });

  it('renders an empty state when available but no contexts recorded', () => {
    const html = renderToStaticMarkup(
      <RetrievalStrategyCard stats={{ available: true, totalPulls: 0, contexts: [] }} />,
    );
    expect(html).toContain('No bandit data yet');
  });
});
