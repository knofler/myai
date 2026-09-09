// Component test for RouterTrainReadinessCard (task-7fdc970b) — the /brain
// Overview card surfacing router-training readiness (BRAIN B-7.1): labeled
// traces banked vs the 500-trace LoRA training floor, ingestion rate, and ETA,
// sourced from the gateway's read-only `brain_router_train_readiness` report.
// No jsdom/Testing-Library dependency: renders to a static HTML string via
// react-dom/server, same pattern as brain-retrieval-strategy.test.tsx.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RouterTrainReadinessCard } from './brain';
import type { RouterTrainReadiness } from '@/lib/brain';

const BANKING: RouterTrainReadiness = {
  available: true,
  ready: false,
  traceCount: 142,
  minTracesRequired: 500,
  tracesRemaining: 358,
  sources: { liveRouteEvalLabeled: 42, harvestedSpikeLabeled: 100 },
  ingestion: { windowDays: 14, recentLabeled: 28, perDay: 2.0 },
  etaDays: 179.0,
  estimatedReadyAt: '2027-02-26',
  trainingStatus: 'GATED — not enough labeled traces yet; no training run should be attempted (BRAIN_BUILD_PLAN.md B-7.1)',
};

describe('RouterTrainReadinessCard', () => {
  it('renders traces banked vs the floor with sources and ingestion rate', () => {
    const html = renderToStaticMarkup(<RouterTrainReadinessCard readiness={BANKING} />);
    expect(html).toContain('Router training readiness');
    expect(html).toContain('142');
    expect(html).toContain('/ 500');
    expect(html).toContain('358 traces to go');
    expect(html).toContain('42'); // live source
    expect(html).toContain('100'); // harvested source
    expect(html).toContain('28 (~2.0/day)');
    expect(html).toContain('GATED');
  });

  it('renders the ETA at the current ingestion rate', () => {
    const html = renderToStaticMarkup(<RouterTrainReadinessCard readiness={BANKING} />);
    expect(html).toContain('~179 days');
  });

  it('renders an unknown ETA when nothing labeled landed in the window', () => {
    const html = renderToStaticMarkup(
      <RouterTrainReadinessCard
        readiness={{ ...BANKING, ingestion: { windowDays: 14, recentLabeled: 0, perDay: 0 }, etaDays: null, estimatedReadyAt: null }}
      />,
    );
    expect(html).toContain('unknown — no recent ingestion');
  });

  it('renders the ready state once the floor is met', () => {
    const html = renderToStaticMarkup(
      <RouterTrainReadinessCard
        readiness={{
          ...BANKING,
          ready: true,
          traceCount: 512,
          tracesRemaining: 0,
          etaDays: 0,
          estimatedReadyAt: null,
          trainingStatus: 'trace-volume gate met — training remains OFF/manual by default',
        }}
      />,
    );
    expect(html).toContain('floor met');
    expect(html).toContain('trace floor met — training stays manual');
    expect(html).toContain('512');
  });

  it('caps the progress bar at 100% when banked traces exceed the floor', () => {
    const html = renderToStaticMarkup(
      <RouterTrainReadinessCard
        readiness={{ ...BANKING, ready: true, traceCount: 750, tracesRemaining: 0, etaDays: 0, estimatedReadyAt: null }}
      />,
    );
    expect(html).toContain('aria-valuenow="100"');
    expect(html).not.toContain('150%');
  });

  it('renders an empty state when no trace store exists yet', () => {
    const html = renderToStaticMarkup(
      <RouterTrainReadinessCard
        readiness={{
          available: false,
          ready: false,
          traceCount: 0,
          minTracesRequired: 500,
          tracesRemaining: 500,
          sources: { liveRouteEvalLabeled: 0, harvestedSpikeLabeled: 0 },
          ingestion: { windowDays: 0, recentLabeled: 0, perDay: 0 },
          etaDays: null,
          estimatedReadyAt: null,
          trainingStatus: '',
        }}
      />,
    );
    expect(html).toContain('No trace store yet');
    expect(html).not.toContain('Labeled traces banked');
  });
});
