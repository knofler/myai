'use client';

// Client search UI for the runner job-history archive (tasks/job-history-store.ts).
// Filters: repo, task id, outcome status, error/RESULT substring. One fetch per
// Apply (no live tail — this is an archive, not a stream); a row expands to
// show the full RESULT line + error excerpt.
import { Fragment, useCallback, useEffect, useState } from 'react';

interface RunEntry {
  jobId: string;
  repo: string;
  taskId: string;
  status: 'done' | 'blocked' | 'failed' | 'no-result';
  resultLine: string;
  errorExcerpt: string;
  exitCode?: number;
  machine?: string;
  model?: string;
  logFile?: string;
  startedAt: string;
  durationSeconds?: number;
}

const STATUSES = ['', 'done', 'blocked', 'failed', 'no-result'];
const LIMIT = 100;

const STATUS_COLOR: Record<string, string> = {
  done: 'text-emerald-400',
  blocked: 'text-amber-400',
  failed: 'text-red-400',
  'no-result': 'text-[rgb(var(--text-muted))]',
};

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left font-medium text-[rgb(var(--text-primary))] px-3 py-2 border-b border-[rgb(var(--border-subtle))] whitespace-nowrap">{children}</th>;
}
function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 border-b border-[rgb(var(--border-subtle))] align-top ${className}`}>{children}</td>;
}

function fmtDuration(seconds?: number): string {
  if (typeof seconds !== 'number') return '—';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default function RunsSearch() {
  const [entries, setEntries] = useState<RunEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [repo, setRepo] = useState('');
  const [taskId, setTaskId] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (repo) qs.set('repo', repo.trim());
      if (taskId) qs.set('taskId', taskId.trim());
      if (status) qs.set('status', status);
      if (q) qs.set('q', q);
      qs.set('limit', String(LIMIT));
      const res = await fetch(`/api/runs?${qs.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setEntries(Array.isArray(json.entries) ? json.entries : []);
      setTotal(typeof json.total === 'number' ? json.total : 0);
    } catch (err) {
      setError(err instanceof Error ? `Failed to search runs — ${err.message}` : 'Failed to search runs.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [repo, taskId, status, q]);

  // Initial load — most recent runs, no filters.
  useEffect(() => { void search(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(e) => { e.preventDefault(); void search(); }}
      >
        <input
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="repo"
          className="bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded px-2 py-1 text-sm text-[rgb(var(--text-primary))] w-44"
          aria-label="Filter by repo"
        />
        <input
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
          placeholder="task id"
          className="bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded px-2 py-1 text-sm text-[rgb(var(--text-primary))] w-56"
          aria-label="Filter by task id"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded px-2 py-1 text-sm text-[rgb(var(--text-primary))]"
          aria-label="Filter by outcome"
        >
          {STATUSES.map((s) => <option key={s || 'all'} value={s}>{s || 'All outcomes'}</option>)}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="error / RESULT substring…"
          className="bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded px-2 py-1 text-sm text-[rgb(var(--text-primary))] w-64"
          aria-label="Search error or RESULT text"
        />
        <button
          type="submit"
          className="text-sm text-teal-300 hover:underline border border-[rgb(var(--border-subtle))] rounded px-3 py-1"
        >
          Search
        </button>
        {!loading && !error && (
          <span className="text-sm text-[rgb(var(--text-muted))] ml-auto">
            {total > entries.length ? `${entries.length} of ${total} matches` : `${total} match${total === 1 ? '' : 'es'}`}
          </span>
        )}
      </form>

      {error ? (
        <p className="text-sm text-amber-400 border border-amber-900/50 bg-amber-950/20 rounded px-3 py-2">{error}</p>
      ) : loading ? (
        <p className="text-sm text-[rgb(var(--text-muted))]">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-[rgb(var(--text-muted))]">No archived runs match these filters yet. Runs are ingested at each fire&apos;s close-off (and backfilled via scripts/ingest_runner_history.sh).</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[rgb(var(--border-subtle))]">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <Th>Started (UTC)</Th>
                <Th>Repo</Th>
                <Th>Task</Th>
                <Th>Outcome</Th>
                <Th>Duration</Th>
                <Th>Result</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <Fragment key={e.jobId}>
                  <tr
                    className="cursor-pointer hover:bg-[rgb(var(--bg-surface))]"
                    onClick={() => setExpanded(expanded === e.jobId ? null : e.jobId)}
                  >
                    <Td className="text-[rgb(var(--text-muted))] whitespace-nowrap">{new Date(e.startedAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')}</Td>
                    <Td className="text-[rgb(var(--text-secondary))]">{e.repo}</Td>
                    <Td>
                      <span className="font-mono text-xs text-teal-300">{e.taskId}</span>
                    </Td>
                    <Td><span className={STATUS_COLOR[e.status] ?? 'text-[rgb(var(--text-primary))]'}>{e.status}</span></Td>
                    <Td className="text-[rgb(var(--text-muted))] whitespace-nowrap">{fmtDuration(e.durationSeconds)}</Td>
                    <Td className="text-[rgb(var(--text-primary))]">
                      <span className="line-clamp-2">{e.resultLine || <span className="text-[rgb(var(--text-muted))]">(no RESULT line)</span>}</span>
                    </Td>
                  </tr>
                  {expanded === e.jobId && (
                    <tr>
                      <td colSpan={6} className="px-3 py-2 border-b border-[rgb(var(--border-subtle))] align-top bg-[rgb(var(--bg-surface))]">
                        <div className="space-y-2 py-1">
                          <p className="text-xs text-[rgb(var(--text-muted))]">
                            {e.machine ? `machine ${e.machine} · ` : ''}
                            {e.model ? `model ${e.model} · ` : ''}
                            {typeof e.exitCode === 'number' ? `exit ${e.exitCode} · ` : ''}
                            {e.logFile ? `log ${e.logFile}` : 'no source log file recorded'}
                          </p>
                          {e.resultLine && (
                            <pre className="whitespace-pre-wrap font-mono text-xs text-[rgb(var(--text-primary))]">{e.resultLine}</pre>
                          )}
                          {e.errorExcerpt && (
                            <pre className="whitespace-pre-wrap font-mono text-xs text-red-300 border border-red-900/40 bg-red-950/20 rounded p-2">{e.errorExcerpt}</pre>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
