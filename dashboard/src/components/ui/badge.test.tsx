// Component test for RoutedBadge (task-d9300dac) — the router audit-trail
// stamp {routedProfile, routedModel, routedComplexity} the runner writes onto
// a task at claim time, rendered as a column/tooltip in /work and the Runner
// Health view. No jsdom/Testing-Library dependency: renders to a static HTML
// string via react-dom/server (already a project dependency) and asserts on
// the markup — enough to prove the new fields actually render.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoutedBadge, WorkTypeBadge } from './badge';

describe('RoutedBadge', () => {
  it('renders the routed model, complexity, and a profile tooltip', () => {
    const html = renderToStaticMarkup(
      <RoutedBadge routedProfile="claude-fable" routedModel="claude-fable-5" routedComplexity="standard" />,
    );
    expect(html).toContain('claude-fable-5');
    expect(html).toContain('standard');
    expect(html).toContain('routed profile: claude-fable');
    expect(html).toContain('complexity: standard');
  });

  it('renders a placeholder for a task never claimed by the router', () => {
    const html = renderToStaticMarkup(<RoutedBadge />);
    expect(html).toContain('—');
    expect(html).not.toContain('claude-');
  });

  it('renders the model even when complexity is missing', () => {
    const html = renderToStaticMarkup(<RoutedBadge routedModel="claude-opus-4-8" />);
    expect(html).toContain('claude-opus-4-8');
  });
});

describe('WorkTypeBadge', () => {
  // task-de8b40ff: the WORK_TYPE_TIER_MAP decision (db9e937,
  // plan/MULTI_PROVIDER_ORCHESTRATION.md §3) stamped onto a task at claim
  // time — previously only inspectable via a direct routing_info MCP call.
  it('renders the work-type, tier, and failover hop with a tooltip', () => {
    const html = renderToStaticMarkup(
      <WorkTypeBadge workType="frontend" workTypeTier="standard" workTypeFailoverHop="kimi" />,
    );
    expect(html).toContain('frontend');
    expect(html).toContain('standard');
    expect(html).toContain('kimi');
    expect(html).toContain('work-type: frontend');
    expect(html).toContain('tier: standard');
    expect(html).toContain('failover: kimi');
  });

  it('renders a placeholder for a task never routed via a workType hint', () => {
    const html = renderToStaticMarkup(<WorkTypeBadge />);
    expect(html).toContain('—');
    expect(html).not.toContain('work-type:');
  });

  it('renders the work-type and tier even when there is no cross-class failover hop', () => {
    // Rows like security/data-embeddings have failover === tier (no extra hop).
    const html = renderToStaticMarkup(<WorkTypeBadge workType="security" workTypeTier="premium" />);
    expect(html).toContain('security');
    expect(html).toContain('premium');
    expect(html).not.toContain('failover:');
  });
});
