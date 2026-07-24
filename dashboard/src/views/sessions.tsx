import { StatCard } from '@/components/ui/card';
import { SourceBadge } from '@/components/ui/badge';
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
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800">
              <h2 className="text-lg font-semibold">Vectors by source</h2>
            </div>
            <table className="card-table w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
                  <th className="px-4 py-2">Source</th>
                  <th className="px-4 py-2 text-right">Count</th>
                  <th className="px-4 py-2 text-right">% of total</th>
                  <th className="px-4 py-2 text-right">Latest</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {bySource.map((s) => (
                  <tr key={s._id ?? '(none)'} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="px-4 py-2">
                      <SourceBadge source={s._id || '(none)'} />
                    </td>
                    <td className="px-4 py-2 text-right text-zinc-300 font-mono">
                      {numFmt.format(s.count)}
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-zinc-500 font-mono">
                      {totalVectors > 0 ? ((s.count / totalVectors) * 100).toFixed(1) : 0}%
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-zinc-500">
                      {s.latestAt ? new Date(s.latestAt).toLocaleDateString() : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* By repo */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800">
              <h2 className="text-lg font-semibold">Vectors by repo</h2>
            </div>
            {byRepo.length === 0 ? (
              <div className="p-8 text-center text-sm text-zinc-500">No repo data.</div>
            ) : (
              <table className="card-table w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
                    <th className="px-4 py-2">Repo</th>
                    <th className="px-4 py-2 text-right">Vectors</th>
                    <th className="px-4 py-2 text-right">% of total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50">
                  {byRepo.map((r) => (
                    <tr key={r._id ?? '(unknown)'} className="hover:bg-zinc-800/30 transition-colors">
                      <td className="px-4 py-2 text-zinc-300 font-mono text-xs">
                        {r._id || '(unknown)'}
                      </td>
                      <td className="px-4 py-2 text-right text-zinc-300 font-mono">
                        {numFmt.format(r.count)}
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-zinc-500 font-mono">
                        {totalVectors > 0 ? ((r.count / totalVectors) * 100).toFixed(1) : 0}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
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
      <div className="mb-3 border-t border-zinc-800 pt-6">
        <h2 className="text-lg font-semibold">Gateway sessions</h2>
        <p className="text-sm text-zinc-500 mt-1">
          {serialized.length} sessions ({active.length} active, {closed.length} closed)
        </p>
      </div>

      {serialized.length === 0 ? (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
          <p className="text-zinc-400">No sessions yet</p>
          <p className="text-xs text-zinc-600 mt-1">
            Create one via WebSocket (:3201) or POST /api/sessions
          </p>
        </div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <table className="card-table w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
                <th className="px-4 py-3">Session ID</th>
                <th className="px-4 py-3">Agent</th>
                <th className="px-4 py-3 text-center">Messages</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Last Activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {serialized.map((s) => (
                <tr key={s._id} className="hover:bg-zinc-800/30 transition-colors">
                  <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">
                    {s.sessionId.slice(0, 8)}...
                  </td>
                  <td className="px-4 py-2.5 text-zinc-300">{s.agentName}</td>
                  <td className="px-4 py-2.5 text-center text-zinc-400">{s.messageCount}</td>
                  <td className="px-4 py-2.5 text-center">
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                        s.status === 'active'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : s.status === 'closed'
                            ? 'bg-zinc-700/50 text-zinc-500'
                            : 'bg-yellow-500/10 text-yellow-400'
                      }`}
                    >
                      {s.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-zinc-500">
                    {s.createdAt ? new Date(s.createdAt).toLocaleString() : '-'}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-zinc-500">
                    {s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
