'use client';

// Client viewer for the tenant-scoped structured log-store (monitoring/log-store.ts).
// Filters: service, level, correlation id, free-text search. "Live tail" polls
// /api/logs every 3s using a `since` cursor (the newest timestamp already
// rendered) so each poll only fetches what's new — the same incremental
// pattern a real tail -f gives you, without websockets.
import { useCallback, useEffect, useRef, useState } from 'react';
import { DataTable, type DataRow } from '@/components/ui/data-table';
import { LogLevelBadge } from '@/components/ui/badge';

interface LogEntry {
  id: string;
  ts: number;
  correlationId: string;
  service: 'gateway' | 'runner' | 'agent';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  attributes: Record<string, unknown>;
}

const SERVICES = ['', 'gateway', 'runner', 'agent'];
const LEVELS = ['', 'debug', 'info', 'warn', 'error'];
const MAX_RENDERED = 500;
const POLL_MS = 3000;

export default function LogsViewer() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [service, setService] = useState('');
  const [level, setLevel] = useState('');
  const [correlationId, setCorrelationId] = useState('');
  const [q, setQ] = useState('');
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Cloud deployment: logs live only in the office-Mac gateway's memory.
  const [cloudNote, setCloudNote] = useState<string | null>(null);
  const sinceRef = useRef<number>(0);

  const buildQs = useCallback((since?: number) => {
    const qs = new URLSearchParams();
    if (service) qs.set('service', service);
    if (level) qs.set('level', level);
    if (correlationId) qs.set('correlationId', correlationId);
    if (q) qs.set('q', q);
    if (since) qs.set('since', String(since));
    else qs.set('limit', String(MAX_RENDERED));
    return qs.toString();
  }, [service, level, correlationId, q]);

  // Full reload whenever a filter changes.
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/logs?${buildQs()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setCloudNote(json.cloudUnavailable ? String(json.reason ?? 'Live logs are only available on the local dashboard.') : null);
      const fresh: LogEntry[] = Array.isArray(json.entries) ? json.entries : [];
      setEntries(fresh);
      sinceRef.current = fresh.length ? Math.max(...fresh.map((e) => e.ts)) : Date.now();
    } catch (err) {
      // Surface the actual failure inline (e.g. "HTTP 503") rather than a
      // generic message — a blank table with no reason reads as "no logs".
      setError(err instanceof Error ? `Failed to load logs — ${err.message}` : 'Failed to load logs.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [buildQs]);

  useEffect(() => { void reload(); }, [reload]);

  // Live-tail poll — only while `live` is on, incremental via the since cursor.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/logs?${buildQs(sinceRef.current)}`, { cache: 'no-store' });
        if (!res.ok) return;
        const json = await res.json();
        const fresh: LogEntry[] = Array.isArray(json.entries) ? json.entries : [];
        if (!fresh.length) return;
        sinceRef.current = Math.max(sinceRef.current, ...fresh.map((e) => e.ts));
        setEntries((prev) => [...fresh, ...prev].slice(0, MAX_RENDERED));
      } catch (err) {
        console.error(err);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [live, buildQs]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={service}
          onChange={(e) => setService(e.target.value)}
          className="bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded px-2 py-1 text-sm text-[rgb(var(--text-primary))]"
          aria-label="Filter by service"
        >
          {SERVICES.map((s) => <option key={s || 'all'} value={s}>{s || 'All services'}</option>)}
        </select>
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded px-2 py-1 text-sm text-[rgb(var(--text-primary))]"
          aria-label="Filter by level"
        >
          {LEVELS.map((l) => <option key={l || 'all'} value={l}>{l || 'All levels'}</option>)}
        </select>
        <input
          value={correlationId}
          onChange={(e) => setCorrelationId(e.target.value)}
          placeholder="correlation id / task id"
          className="bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded px-2 py-1 text-sm text-[rgb(var(--text-primary))] w-56"
          aria-label="Filter by correlation id"
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search message…"
          className="bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded px-2 py-1 text-sm text-[rgb(var(--text-primary))] w-56"
          aria-label="Search message text"
        />
        <button
          onClick={() => void reload()}
          className="text-sm text-teal-300 hover:underline border border-[rgb(var(--border-subtle))] rounded px-3 py-1"
        >
          Apply
        </button>
        <label className="flex items-center gap-2 text-sm text-[rgb(var(--text-secondary))] ml-auto">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          Live tail
        </label>
      </div>

      {cloudNote ? (
        <p role="status" className="text-sm text-sky-300 border border-sky-900/50 bg-sky-950/20 rounded px-3 py-2">{cloudNote}</p>
      ) : error ? (
        <p role="alert" className="text-sm text-amber-400 border border-amber-900/50 bg-amber-950/20 rounded px-3 py-2">{error}</p>
      ) : loading ? (
        <p className="text-sm text-[rgb(var(--text-muted))]">Loading…</p>
      ) : (
        <DataTable
          title="Log entries"
          searchable={false}
          columns={[
            { label: 'Level', mobile: 'badge' },
            { label: 'Message', mobile: 'title' },
            { label: 'When (UTC)', mobile: 'meta' },
            { label: 'Service', mobile: 'meta' },
            { label: 'Correlation id', mobile: 'detail' },
          ]}
          rows={entries.map((e): DataRow => ({
            id: e.id,
            search: `${e.level} ${e.service} ${e.correlationId} ${e.message}`.toLowerCase(),
            sort: { when: e.ts },
            cells: [
              <LogLevelBadge key="level" level={e.level} />,
              <span key="msg" className="text-[rgb(var(--text-primary))]">{e.message}</span>,
              <span key="when" className="text-[rgb(var(--text-muted))] whitespace-nowrap">{new Date(e.ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')}</span>,
              <span key="service" className="text-[rgb(var(--text-secondary))]">{e.service}</span>,
              <button
                key="corr"
                type="button"
                onClick={() => setCorrelationId(e.correlationId)}
                className="font-mono text-xs text-teal-300 hover:underline"
                title="Filter to this correlation id"
              >
                {e.correlationId}
              </button>,
            ],
          }))}
          defaultSort="when"
          defaultDesc
          emptyText="No log entries match these filters yet."
        />
      )}
    </div>
  );
}
