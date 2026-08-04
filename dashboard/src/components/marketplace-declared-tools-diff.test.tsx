// Component test for DeclaredToolsDiffView (ADR-028 §4 review-queue widget):
// proves the reviewer actually sees "this version adds webfetch" as a flagged
// UI element — not buried changelog prose — using fixture in_review/approved
// ListingVersion pairs, same renderToStaticMarkup pattern as
// pool-capacity-panel.test.tsx (no jsdom/Testing-Library dependency).
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeclaredToolsDiffView } from './marketplace-declared-tools-diff';
import { diffDeclaredTools, type ListingVersion } from '@/lib/marketplace';

const APPROVED_VERSION: ListingVersion = {
  creatorTenantId: 'tenant-nimbus',
  listingId: 'lst_pg_migrator',
  version: '0.9.1',
  status: 'approved',
  manifestHash: 'sha256:fixture-approved',
  changelog: 'Initial release.',
  artifactUri: 'fixture://pg-migrator/0.9.1',
  declaredTools: ['read', 'grep'],
  createdAt: '2028-03-20T10:00:00.000Z',
};

const IN_REVIEW_RESUBMISSION: ListingVersion = {
  creatorTenantId: 'tenant-nimbus',
  listingId: 'lst_pg_migrator',
  version: '1.0.0',
  status: 'in_review',
  manifestHash: 'sha256:fixture-in-review',
  changelog: 'Adds an auto-apply mode that shells out to run the generated migration.',
  artifactUri: 'fixture://pg-migrator/1.0.0',
  declaredTools: ['read', 'grep', 'webfetch'],
  createdAt: '2028-05-01T11:00:00.000Z',
};

describe('DeclaredToolsDiffView', () => {
  it('flags an added tool with the "(new)" widening badge and a review warning naming it', () => {
    const diff = diffDeclaredTools(IN_REVIEW_RESUBMISSION.declaredTools, APPROVED_VERSION.declaredTools);
    const html = renderToStaticMarkup(
      <DeclaredToolsDiffView declaredTools={IN_REVIEW_RESUBMISSION.declaredTools} diff={diff} isResubmission={true} />,
    );
    // Unchanged tools still render, unflagged.
    expect(html).toContain('read');
    expect(html).toContain('grep');
    // The added tool is flagged distinctly — the ADR's own example.
    expect(html).toContain('+ webfetch (new)');
    expect(html).toContain('data-testid="declared-tool-added"');
    expect(html).toContain('data-testid="widening-warning"');
    expect(html).toContain('it adds webfetch');
    expect(html).not.toContain('data-testid="declared-tool-removed"');
  });

  it('flags a removed tool as a safe narrowing, without a widening warning', () => {
    const diff = diffDeclaredTools(['read'], ['read', 'webfetch']);
    const html = renderToStaticMarkup(<DeclaredToolsDiffView declaredTools={['read']} diff={diff} isResubmission={true} />);
    expect(html).toContain('− webfetch');
    expect(html).toContain('data-testid="declared-tool-removed"');
    expect(html).not.toContain('data-testid="widening-warning"');
    expect(html).not.toContain('data-testid="declared-tool-added"');
  });

  it('renders no diff chrome for a listing\'s first-ever submission', () => {
    const diff = diffDeclaredTools(APPROVED_VERSION.declaredTools, undefined);
    const html = renderToStaticMarkup(
      <DeclaredToolsDiffView declaredTools={APPROVED_VERSION.declaredTools} diff={diff} isResubmission={false} />,
    );
    expect(html).toContain('first submission');
    expect(html).toContain('read');
    expect(html).toContain('grep');
    expect(html).not.toContain('data-testid="declared-tool-added"');
    expect(html).not.toContain('data-testid="widening-warning"');
  });

  it('renders no widening warning when declaredTools are unchanged across versions', () => {
    const diff = diffDeclaredTools(APPROVED_VERSION.declaredTools, APPROVED_VERSION.declaredTools);
    const html = renderToStaticMarkup(
      <DeclaredToolsDiffView declaredTools={APPROVED_VERSION.declaredTools} diff={diff} isResubmission={true} />,
    );
    expect(html).not.toContain('data-testid="widening-warning"');
    expect(html).not.toContain('data-testid="declared-tool-added"');
    expect(html).not.toContain('data-testid="declared-tool-removed"');
  });
});
