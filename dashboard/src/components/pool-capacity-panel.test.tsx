// Component test for PoolCapacityPanel (task-80ba3a74) — commit 28a7231 added
// per-provider (deepseek/kimi) pass-rate tracking to
// scripts/lib/agentic_fallback.sh, but the only consumer was a log-text line
// in logs/claude_log.md. pool_capacity_snapshot.sh now embeds a
// qualityByProvider array in the agentic-fallback pool entry; this test proves
// the dashboard actually renders it (pass-rate % + n + sparkline) next to the
// existing $ spend StatCard, not just that the JSON field exists.
//
// No jsdom/Testing-Library dependency — same pattern as badge.test.tsx:
// renders to a static HTML string via react-dom/server and asserts on markup.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PoolCapacityPanel } from './pool-capacity-panel';
import type { PoolCapacity } from '@/lib/pool-capacity';

const BASE_CAPACITY: PoolCapacity = {
  available: true,
  generatedAt: '2026-08-02T00:00:00Z',
  week: '2026-W31',
  pools: [],
};

describe('PoolCapacityPanel', () => {
  it('renders nothing when the capacity artifact is unavailable', () => {
    const html = renderToStaticMarkup(<PoolCapacityPanel capacity={{ ...BASE_CAPACITY, available: false }} />);
    expect(html).toBe('');
  });

  it('renders per-provider pass-rate + sparkline when the agentic-fallback lane is enabled with quality data', () => {
    const capacity: PoolCapacity = {
      ...BASE_CAPACITY,
      pools: [
        {
          pool: 'agentic-fallback',
          kind: 'usd-daily',
          period: 'daily',
          enabled: true,
          capUsd: 2.0,
          spentUsd: 0.42,
          remainingUsd: 1.58,
          pctUsedUsd: 21.0,
          qualityByProvider: [
            { provider: 'deepseek', passRate: 0.67, n: 3, window: 20, recent: [1, 1, 0] },
            { provider: 'kimi', passRate: 0.5, n: 2, window: 20, recent: [0, 1] },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(<PoolCapacityPanel capacity={capacity} />);
    // $ spend StatCard still renders (existing behavior, not regressed).
    expect(html).toContain('Agentic fallback (DeepSeek/Kimi)');
    expect(html).toContain('$1.58 left today');
    // New: per-provider pass-rate rollup.
    expect(html).toContain('deepseek');
    expect(html).toContain('67%');
    expect(html).toContain('n=3');
    expect(html).toContain('kimi');
    expect(html).toContain('50%');
    expect(html).toContain('n=2');
    // Sparkline: 1=pass rendered as a filled block, 0=fail as a light block.
    expect(html).toContain('██▁'); // deepseek recent [1,1,0]
    expect(html).toContain('▁█'); // kimi recent [0,1]
  });

  it('omits the quality row entirely when qualityByProvider is empty (no outcomes recorded yet)', () => {
    const capacity: PoolCapacity = {
      ...BASE_CAPACITY,
      pools: [
        {
          pool: 'agentic-fallback',
          kind: 'usd-daily',
          period: 'daily',
          enabled: true,
          capUsd: 2.0,
          spentUsd: 0,
          remainingUsd: 2.0,
          pctUsedUsd: 0,
          qualityByProvider: [],
        },
      ],
    };
    const html = renderToStaticMarkup(<PoolCapacityPanel capacity={capacity} />);
    expect(html).toContain('Agentic fallback (DeepSeek/Kimi)');
    expect(html).not.toContain('n=');
  });

  it('omits the quality row when the lane is disabled, even if qualityByProvider carries stale data', () => {
    const capacity: PoolCapacity = {
      ...BASE_CAPACITY,
      pools: [
        {
          pool: 'agentic-fallback',
          kind: 'usd-daily',
          period: 'daily',
          enabled: false,
          capUsd: 2.0,
          spentUsd: 0,
          remainingUsd: 2.0,
          pctUsedUsd: 0,
          qualityByProvider: [{ provider: 'deepseek', passRate: 0.67, n: 3, window: 20, recent: [1, 1, 0] }],
        },
      ],
    };
    const html = renderToStaticMarkup(<PoolCapacityPanel capacity={capacity} />);
    expect(html).toContain('off');
    expect(html).not.toContain('n=3');
  });

  it('renders "n/a" for a provider with no pass-rate yet (never happens today, but the type allows it)', () => {
    const capacity: PoolCapacity = {
      ...BASE_CAPACITY,
      pools: [
        {
          pool: 'agentic-fallback',
          kind: 'usd-daily',
          period: 'daily',
          enabled: true,
          capUsd: 2.0,
          spentUsd: 0,
          remainingUsd: 2.0,
          pctUsedUsd: 0,
          qualityByProvider: [{ provider: 'deepseek', passRate: null, n: 0, window: 20, recent: [] }],
        },
      ],
    };
    const html = renderToStaticMarkup(<PoolCapacityPanel capacity={capacity} />);
    expect(html).toContain('n/a');
  });
});
