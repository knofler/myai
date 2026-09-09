// Component test for BudgetSuggestionsPanel (task-1a11ea47 re-check) — the
// panel (and its "Apply suggestion" write path, task-5815e866) already ships,
// but had no component-level test proving all four `CapRecommendation`
// labels (increase/decrease/keep/insufficient_data) actually render their
// badge + rationale text, only the pure `recommendCapAdjustment`/
// `summarizeSuggestion` logic in budget-suggestions.test.ts.
//
// No jsdom/Testing-Library dependency — same pattern as
// pool-capacity-panel.test.tsx: renders to a static HTML string via
// react-dom/server and asserts on markup. next/navigation's useRouter is
// mocked since the panel calls it unconditionally (ApplyCell) even for rows
// that render as a plain "—" (keep/insufficient_data).
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

const { BudgetSuggestionsPanel } = await import('./budget-suggestions-panel');
import type { BudgetCapSuggestions, CapSuggestion } from '@/lib/budget-suggestions';

function suggestion(overrides: Partial<CapSuggestion>): CapSuggestion {
  return {
    currentCapUsd: 100,
    observedDays: 30,
    avgDailyUsd: 3,
    p95DailyUsd: 4,
    suggestedCapUsd: 100,
    recommendation: 'keep',
    rationale: 'Current cap is within a reasonable margin of observed spend patterns.',
    ...overrides,
  };
}

const BASE_SUGGESTIONS: BudgetCapSuggestions = {
  enabled: true,
  lookbackDays: 30,
  generatedAt: '2026-09-03T00:00:00Z',
  monthlyHardCap: suggestion({
    currentCapUsd: 100,
    suggestedCapUsd: 130,
    recommendation: 'increase',
    rationale: "Observed spend pattern runs 30% above the current cap's headroom — raise it to avoid throttling legitimate usage.",
  }),
  dailyCap: suggestion({
    currentCapUsd: 10,
    suggestedCapUsd: 6,
    recommendation: 'decrease',
    rationale: 'Observed spend uses only ~60% of the current cap — it could be tightened without risking legitimate throttling.',
  }),
  perChannel: [
    {
      channelId: 'telegram',
      ...suggestion({
        currentCapUsd: 50,
        suggestedCapUsd: 50,
        recommendation: 'keep',
        rationale: 'Current cap is within a reasonable margin of observed spend patterns.',
      }),
    },
    {
      channelId: 'discord',
      ...suggestion({
        currentCapUsd: 20,
        suggestedCapUsd: 20,
        observedDays: 2,
        recommendation: 'insufficient_data',
        rationale: 'Only 2 day(s) of spend history (need 7+) — keeping the current cap until more data accrues.',
      }),
    },
  ],
};

describe('BudgetSuggestionsPanel', () => {
  it('renders all four recommendation labels with their badge + rationale text', () => {
    const html = renderToStaticMarkup(<BudgetSuggestionsPanel suggestions={BASE_SUGGESTIONS} />);

    expect(html).toContain('Monthly hard cap');
    expect(html).toContain('increase');
    expect(html).toContain("raise it to avoid throttling legitimate usage");

    expect(html).toContain('Daily cap');
    expect(html).toContain('decrease');
    expect(html).toContain('could be tightened without risking legitimate throttling');

    expect(html).toContain('Channel: telegram');
    expect(html).toContain('keep');
    expect(html).toContain('Current cap is within a reasonable margin');

    expect(html).toContain('Channel: discord');
    expect(html).toContain('insufficient data');
    expect(html).toContain('keeping the current cap until more data accrues');
  });

  it('renders current + suggested cap values for every row', () => {
    const html = renderToStaticMarkup(<BudgetSuggestionsPanel suggestions={BASE_SUGGESTIONS} />);
    expect(html).toContain('$100.00');
    expect(html).toContain('$130.00');
    expect(html).toContain('$10.00');
    expect(html).toContain('$6.00');
  });

  it('shows the lookback window', () => {
    const html = renderToStaticMarkup(<BudgetSuggestionsPanel suggestions={BASE_SUGGESTIONS} />);
    expect(html).toContain('30-day lookback');
  });
});
