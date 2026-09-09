// /context — "Your Context" (CONTEXT-PORT 3). The visible home of the promise:
// your context is yours, portable, importable. It reads every layer the
// dashboard can reach — RAG vectors + gateway sessions (Mongo mirror) and the
// git-versioned brain (gateway `brain_explore`) — summarises size / tokens /
// coverage, and offers one-click DOWNLOAD (a portable JSON bundle) and UPLOAD
// (import into the corpus). Read-only for the layers; the export/import happen
// through the /api/context/* routes.

import { StatCard, Card } from '@/components/ui/card';
import { SourceBadge } from '@/components/ui/badge';
import { DataTable } from '@/components/ui/data-table';
import { connectDB, Vector, Session } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { fetchBrainExplore } from '@/lib/brain';
import { buildContextSummary, formatBytes, formatCompact, type ContextLayerInput } from '@/lib/context';
import { DownloadContextButton, UploadContextForm } from '@/components/context-port';

export const dynamic = 'force-dynamic';

interface SourceAgg {
  _id: string;
  count: number;
}

export default async function ContextView() {
  await connectDB();
  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);

  const [totalVectors, bySource, byRepo, charAgg, sessionCount, brain] = await Promise.all([
    Vector.countDocuments({ ...tf }),
    Vector.aggregate<SourceAgg>([
      { $match: { ...tf } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    Vector.distinct('repo', { ...tf }) as Promise<string[]>,
    // Total content bytes — the one text-volume figure we can measure cheaply.
    Vector.aggregate<{ _id: null; chars: number }>([
      { $match: { ...tf } },
      { $group: { _id: null, chars: { $sum: { $strLenCP: { $ifNull: ['$content', ''] } } } } },
    ]),
    Session.countDocuments({ ...tf }),
    fetchBrainExplore(),
  ]);

  const contentChars = charAgg[0]?.chars ?? 0;

  const layers: ContextLayerInput = {
    vectors: {
      total: totalVectors,
      contentChars,
      bySource: bySource.map((s) => ({ source: s._id || '(none)', count: s.count })),
      repoCount: byRepo.filter(Boolean).length,
    },
    sessions: { total: sessionCount },
    brain:
      brain && brain.initialized
        ? {
            namespaces: brain.totals.namespaces,
            sessions: brain.totals.sessions,
            handoffs: brain.totals.handoffs,
            memoryAtoms: brain.totals.memory,
            initialized: true,
          }
        : null,
  };

  const summary = buildContextSummary(layers);
  const numFmt = new Intl.NumberFormat('en-US');

  return (
    <div className="space-y-8">
      {/* The promise, stated. */}
      <Card accent="emerald">
        <div className="p-5 flex flex-col lg:flex-row lg:items-center gap-4 justify-between">
          <div className="max-w-xl">
            <h2 className="text-base font-semibold text-emerald-300">Your context is yours — portable, importable.</h2>
            <p className="text-sm text-[rgb(var(--text-secondary))] mt-1">
              Everything myAI has learned for you — RAG memory, session history, and the git-versioned brain — is
              yours to take. Download it as one bundle, or import context from ChatGPT, Claude, Obsidian, or another
              myAI. No lock-in.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <DownloadContextButton />
          </div>
        </div>
      </Card>

      {/* Size / tokens / coverage summary. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total items"
          value={formatCompact(summary.totalItems)}
          sub="vectors + sessions + brain atoms"
          accent={summary.hasContext ? 'green' : 'gray'}
        />
        <StatCard
          label="Estimated tokens"
          value={formatCompact(summary.estimatedTokens)}
          sub="≈ context volume you own"
          accent={summary.estimatedTokens > 0 ? 'blue' : 'gray'}
        />
        <StatCard
          label="Text size"
          value={formatBytes(summary.estimatedChars)}
          sub="measured corpus content"
          accent={summary.estimatedChars > 0 ? 'blue' : 'gray'}
        />
        <StatCard
          label="RAG vectors"
          value={numFmt.format(totalVectors)}
          sub={`${layers.vectors.bySource.length} source type${layers.vectors.bySource.length !== 1 ? 's' : ''}`}
          accent={totalVectors > 0 ? 'green' : 'gray'}
        />
      </div>

      {/* Coverage — one row per layer. */}
      <DataTable
        title="Coverage"
        meta={summary.brainUnavailable ? 'brain layer unreachable' : undefined}
        searchable={false}
        columns={[
          { label: 'Layer', mobile: 'title' },
          { label: 'Items', align: 'right', sortKey: 'count', mobile: 'meta' },
          { label: 'Detail', mobile: 'meta' },
        ]}
        rows={
          summary.hasContext
            ? summary.coverage.map((row) => ({
                id: row.layer,
                search: `${row.layer} ${row.detail}`.toLowerCase(),
                sort: { count: row.count },
                cells: [
                  <span key="l" className="text-[rgb(var(--text-primary))]">{row.layer}</span>,
                  <span key="c" className="font-mono text-[rgb(var(--text-primary))]">{numFmt.format(row.count)}</span>,
                  <span key="d" className="text-xs text-[rgb(var(--text-muted))]">{row.detail}</span>,
                ],
              }))
            : []
        }
        emptyText={
          <>
            No context yet. Run <code className="text-[rgb(var(--text-secondary))]">agent mode</code> and{' '}
            <code className="text-[rgb(var(--text-secondary))]">wrap up</code> a few sessions, or import a bundle below.
          </>
        }
      />

      {/* Vectors by source — the corpus makeup. */}
      {totalVectors > 0 && (
        <DataTable
          title="Vectors by source"
          searchable={false}
          defaultSort="count"
          defaultDesc
          columns={[
            { label: 'Source', mobile: 'badge' },
            { label: 'Count', align: 'right', sortKey: 'count', mobile: 'meta' },
            { label: '% of corpus', align: 'right', mobile: 'meta' },
          ]}
          rows={layers.vectors.bySource.map((s) => ({
            id: s.source,
            search: s.source.toLowerCase(),
            sort: { count: s.count },
            cells: [
              <SourceBadge key="s" source={s.source} />,
              <span key="c" className="font-mono text-[rgb(var(--text-primary))]">{numFmt.format(s.count)}</span>,
              <span key="p" className="text-xs text-[rgb(var(--text-muted))] font-mono">{((s.count / totalVectors) * 100).toFixed(1)}%</span>,
            ],
          }))}
        />
      )}

      {/* Port controls — download (bundle) + upload (import). */}
      <Card title="Port your context" accent="purple">
        <div className="p-5 space-y-6">
          <div>
            <h3 className="text-sm font-medium text-[rgb(var(--text-primary))]">Download</h3>
            <p className="text-xs text-[rgb(var(--text-muted))] mt-1 mb-3">
              A portable JSON bundle of your vectors + sessions. For the full lossless archive (memory markdown +
              vectors with embeddings + the git brain + config), run{' '}
              <code className="text-[rgb(var(--text-secondary))]">myai context export</code> from the CLI.
            </p>
            <DownloadContextButton />
          </div>
          <div className="border-t border-[rgb(var(--border-subtle))] pt-5">
            <h3 className="text-sm font-medium text-[rgb(var(--text-primary))]">Upload / import</h3>
            <p className="text-xs text-[rgb(var(--text-muted))] mt-1 mb-3">
              Import a bundle exported here, produced by <code className="text-[rgb(var(--text-secondary))]">myai context export</code>, or
              converted from ChatGPT / Claude / Obsidian via{' '}
              <code className="text-[rgb(var(--text-secondary))]">myai context import-external</code>. Vectors are re-embedded and deduped
              into your corpus.
            </p>
            <UploadContextForm />
          </div>
        </div>
      </Card>
    </div>
  );
}
