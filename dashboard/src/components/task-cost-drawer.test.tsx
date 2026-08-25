// Component test for the per-task cost + duration drawer (task-6c138c11) —
// proves the drawer body actually renders the four ROI facts (token spend,
// wall-clock, model, retries) from a /api/tasks/[taskId]/cost payload, plus
// the honest attribution note and the empty-spend fallback.
//
// No jsdom/Testing-Library dependency — same pattern as task-defer-panel.test.tsx:
// renders the pure presentational body via react-dom/server and asserts on markup.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskCostDetails, fmtDurationSec, type TaskCostData } from './task-cost-drawer';

function fixture(overrides: Partial<TaskCostData> = {}): TaskCostData {
  return {
    task: {
      taskId: 'task-abc',
      repo: 'connect',
      title: 'Ship the thing',
      status: 'done',
      executionLane: 'claude',
      routedModel: 'claude-fable-5',
      routedProfile: 'claude-tech',
      retryCount: 1,
      maxRetries: 3,
    },
    run: {
      startedAt: '2026-08-25T01:00:00.000Z',
      completedAt: '2026-08-25T01:20:00.000Z',
      durationSec: 1234,
      durationSource: 'meter',
      offhoursMinutes: 21,
      premium: true,
      finalStatus: 'done',
      meterEvents: 2,
    },
    spend: {
      attribution: 'repo-window',
      calls: 5,
      inputTokens: 10000,
      outputTokens: 4500,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 200,
      costUsd: 0.55,
      byModel: [
        { model: 'claude-fable-5', calls: 3, inputTokens: 9000, outputTokens: 4000, costUsd: 0.5 },
        { model: 'claude-haiku-4-5', calls: 2, inputTokens: 1000, outputTokens: 500, costUsd: 0.05 },
      ],
    },
    ...overrides,
  };
}

describe('fmtDurationSec', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(fmtDurationSec(45)).toBe('45s');
    expect(fmtDurationSec(1234)).toBe('20m 34s');
    expect(fmtDurationSec(7500)).toBe('2h 5m');
  });

  it('renders a dash for missing or invalid values', () => {
    expect(fmtDurationSec(undefined)).toBe('—');
    expect(fmtDurationSec(-5)).toBe('—');
    expect(fmtDurationSec(Number.NaN)).toBe('—');
  });
});

describe('TaskCostDetails', () => {
  it('renders the four ROI facts: token spend, wall-clock, model, retries', () => {
    const html = renderToStaticMarkup(<TaskCostDetails data={fixture()} />);
    // Token spend (fmtTokens formatting) + metered cost.
    expect(html).toContain('4.5k out');
    expect(html).toContain('10.0k in');
    expect(html).toContain('$0.55');
    expect(html).toContain('5 metered calls');
    // Wall-clock from the meter's durationSec.
    expect(html).toContain('20m 34s');
    expect(html).toContain('from meter');
    // Model actually routed.
    expect(html).toContain('claude-fable-5');
    expect(html).toContain('via claude-tech');
    // Retry ledger.
    expect(html).toContain('1 / 3');
  });

  it('renders metering facts: premium unit, off-hours minutes, event count', () => {
    const html = renderToStaticMarkup(<TaskCostDetails data={fixture()} />);
    expect(html).toContain('premium (runner-claimed session)');
    expect(html).toContain('21 min');
    expect(html).toContain('Usage events');
  });

  it('shows the per-model breakdown when more than one model ran', () => {
    const html = renderToStaticMarkup(<TaskCostDetails data={fixture()} />);
    expect(html).toContain('claude-haiku-4-5');
    expect(html).toContain('2 calls');
  });

  it('states the repo-window attribution honestly', () => {
    const html = renderToStaticMarkup(<TaskCostDetails data={fixture()} />);
    expect(html).toContain('attributed by repo + run window');
    expect(html).toContain('connect');
  });

  it('explains an empty spend instead of rendering a blank model section', () => {
    const data = fixture();
    data.task.routedModel = undefined;
    data.spend = { ...data.spend, calls: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0, byModel: [] };
    const html = renderToStaticMarkup(<TaskCostDetails data={data} />);
    expect(html).toContain('No model stamped on the task and no metered LLM calls');
    expect(html).toContain('claude lane bills outside the gateway meter');
    expect(html).toContain('$0.00');
  });

  it('renders the never-started fallback for attribution "none"', () => {
    const data = fixture();
    data.spend = { ...data.spend, attribution: 'none', calls: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0, byModel: [] };
    data.run = { ...data.run, durationSec: undefined, durationSource: 'unknown' };
    const html = renderToStaticMarkup(<TaskCostDetails data={data} />);
    expect(html).toContain('No run window recorded');
    expect(html).toContain('—');
  });
});
