import { StatCard } from '@/components/ui/card';
import { SourceBadge, SessionStatusBadge } from '@/components/ui/badge';
import { DataTable } from '@/components/ui/data-table';
import { connectDB, Session, Vector } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import SessionSearch from './session-search';

export const dynamic = 'force-dynamic';

// Phase B6 — RAG corpus inspection + gateway sessions.

interface SourceBreakdown {
  _id: string;  // source type
  count: number;
  latestAt: Date | null;
}

interface RepoBreakdown {
  _id: string;  // repo name
  count: number;
}


export default async function SessionsPage() {
  await connectDB();

  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);

  // ── RAG Corpus Stats ────────────────────────────────────────
  const [
    totalVectors,
    bySource,
    byRepo,
    latestVector,
  ] = await Promise.all([
    Vector.countDocuments({ ...tf }),
    Vector.aggregate<SourceBreakdown>([
      { $match: { ...tf } },
      {
        $group: {
          _id: '$source',
          count: { $sum: 1 },
          latestAt: { $max: '$createdAt' },
        },
      },
      { $sort: { count: -1 } },
    ]),
    Vector.aggregate<RepoBreakdown>([
      { $match: { ...tf } },
      {
        $group: {
          _id: '$repo',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    Vector.findOne({ ...tf })
      .select('createdAt')
      .sort({ createdAt: -1 })
      .lean() as Promise<{ createdAt?: Date } | null>,
  ]);

  const sourceNames = bySource.map((s) => s._id).filter(Boolean);
  const latestIndexed = latestVector?.createdAt
    ? new Date(latestVector.createdAt).toISOString()
    : null;
  const sourceCount = bySource.length;
  const repoCount = byRepo.length;

  const numFmt = new Intl.NumberFormat('en-US');

  // ── Gateway Sessions (existing) ────────────────────────────
  const sessions = await Session.find({ ...tf })
    .select('-messages.__v')
    .sort({ updatedAt: -1 })
    .limit(50)
    .lean();

  const serialized = sessions.map((s) => ({
    _id: String(s._id),
    sessionId: s.sessionId as string,
    agentName: s.agentName as string,
    status: s.status as string,
    messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
    createdAt: s.createdAt ? new Date(s.createdAt as Date).toISOString() : '',
    updatedAt: s.updatedAt ? new Date(s.updatedAt as Date).toISOString() : '',
    closedAt: s.closedAt ? new Date(s.closedAt as Date).toISOString() : null,
  }));

  const active = serialized.filter((s) => s.status === 'active');
  const closed = serialized.filter((s) => s.status === 'closed');

  return (
    <div>
      {/* ── RAG Corpus Section ──────────────────────────────── */}

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Total vectors"
          value={numFmt.format(totalVectors)}
          sub={`${sourceCount} source type${sourceCount !== 1 ? 's' : ''} across ${repoCount} repo${repoCount !== 1 ? 's' : ''}`}
          accent={totalVectors > 0 ? 'green' : 'gray'}
        />
        <StatCard
          label="Source types"
          value={String(sourceCount)}
          sub={sourceNames.slice(0, 4).join(', ') + (sourceNames.length > 4 ? ` +${sourceNames.length - 4} more` : '') || 'none indexed'}
          accent={sourceCount > 0 ? 'blue' : 'gray'}
        />
        <StatCard
          label="Repos indexed"
          value={String(repoCount)}
          sub={byRepo.map((r) => r._id || '(unknown)').slice(0, 3).join(', ') || 'none'}
          accent={repoCount > 0 ? 'green' : 'gray'}
        />
        <StatCard
          label="Latest indexed"
          value={latestIndexed ? new Date(latestIndexed).toLocaleDateString() : 'n/a'}
          sub={latestIndexed ? new Date(latestIndexed).toLocaleTimeString() : 'no vectors yet'}
          accent={latestIndexed ? 'green' : 'gray'}
        />
      </div>

      {/* Source breakdown table + repo breakdown */}
      {totalVectors > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
          {/* By source */}
          <DataTable
            title="Vectors by source"
            searchable={false}
            defaultSort="count"
            defaultDesc
            columns={[
              { label: 'Source', mobile: 'badge' },
              { label: 'Count', align: 'right', sortKey: 'count', mobile: 'meta' },
              { label: '% of total', align: 'right', mobile: 'detail' },
              { label: 'Latest', align: 'right', sortKey: 'latest', mobile: 'meta' },
            ]}
            rows={bySource.map((s) => ({
              id: s._id ?? '(none)',
              search: (s._id || '(none)').toLowerCase(),
              sort: { count: s.count, latest: s.latestAt ? new Date(s.latestAt).getTime() : 0 },
              cells: [
                <SourceBadge key="s" source={s._id || '(none)'} />,
                <span key="c" className="text-[rgb(var(--text-primary))] font-mono">{numFmt.format(s.count)}</span>,
                <span key="p" className="text-xs text-[rgb(var(--text-muted))] font-mono">{((s.count / totalVectors) * 100).toFixed(1)}%</span>,
                <span key="l" className="text-xs text-[rgb(var(--text-muted))]">{s.latestAt ? new Date(s.latestAt).toLocaleDateString() : '-'}</span>,
              ],
            }))}
          />

          {/* By repo */}
          <DataTable
            title="Vectors by repo"
            searchable={false}
            defaultSort="count"
            defaultDesc
            columns={[
              { label: 'Repo', mobile: 'title' },
              { label: 'Vectors', align: 'right', sortKey: 'count', mobile: 'meta' },
              { label: '% of total', align: 'right', mobile: 'meta' },
            ]}
            emptyText="No repo data."
            rows={byRepo.map((r) => ({
              id: r._id ?? '(unknown)',
              search: (r._id || '(unknown)').toLowerCase(),
              sort: { count: r.count },
              cells: [
                <span key="r" className="text-[rgb(var(--text-primary))] font-mono text-xs">{r._id || '(unknown)'}</span>,
                <span key="v" className="text-[rgb(var(--text-primary))] font-mono">{numFmt.format(r.count)}</span>,
                <span key="p" className="text-xs text-[rgb(var(--text-muted))] font-mono">{((r.count / totalVectors) * 100).toFixed(1)}%</span>,
              ],
            }))}
          />
        </div>
      )}

      {/* Vector search */}
      <div className="mb-8">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold">Corpus search</h2>
          <span className="text-xs text-zinc-600">
            Text regex on content field. Semantic search via gateway&apos;s recall_session MCP tool.
          </span>
        </div>
        <SessionSearch sources={sourceNames} />
      </div>

      {/* ── Gateway Sessions Section (existing) ────────────── */}
      <div className="border-t border-[rgb(var(--border-subtle))] pt-6">
        <DataTable
          title="Gateway sessions"
          meta={`${serialized.length} sessions · ${active.length} active · ${closed.length} closed`}
          defaultSort="updated"
          defaultDesc
          columns={[
            { label: 'Session ID', mobile: 'title' },
            { label: 'Agent', mobile: 'meta' },
            { label: 'Messages', align: 'center', sortKey: 'messages', mobile: 'detail' },
            { label: 'Status', align: 'center', mobile: 'badge' },
            { label: 'Created', sortKey: 'created', mobile: 'detail' },
            { label: 'Last Activity', sortKey: 'updated', mobile: 'meta' },
          ]}
          searchPlaceholder="Search session, agent…"
          emptyText={
            <>
              No sessions yet — create one via WebSocket (:3201) or POST /api/sessions.
            </>
          }
          rows={serialized.map((s) => ({
            id: s._id,
            search: `${s.sessionId} ${s.agentName} ${s.status}`.toLowerCase(),
            sort: {
              messages: s.messageCount,
              created: s.createdAt ? new Date(s.createdAt).getTime() : 0,
              updated: s.updatedAt ? new Date(s.updatedAt).getTime() : 0,
            },
            cells: [
              <span key="id" className="font-mono text-xs text-[rgb(var(--text-secondary))]">{s.sessionId.slice(0, 8)}...</span>,
              <span key="a" className="text-[rgb(var(--text-primary))]">{s.agentName}</span>,
              <span key="m" className="text-[rgb(var(--text-secondary))]">{s.messageCount}</span>,
              <SessionStatusBadge key="s" status={s.status} />,
              <span key="c" className="text-xs text-[rgb(var(--text-muted))]">{s.createdAt ? new Date(s.createdAt).toLocaleString() : '-'}</span>,
              <span key="u" className="text-xs text-[rgb(var(--text-muted))]">{s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '-'}</span>,
            ],
          }))}
        />
      </div>
    </div>
  );
}
