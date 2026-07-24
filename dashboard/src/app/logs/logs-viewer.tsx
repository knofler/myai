'use client';

// Client viewer for the tenant-scoped structured log-store (monitoring/log-store.ts).
// Filters: service, level, correlation id, free-text search. "Live tail" polls
// /api/logs every 3s using a `since` cursor (the newest timestamp already
// rendered) so each poll only fetches what's new — the same incremental
// pattern a real tail -f gives you, without websockets.
import { useCallback, useEffect, useRef, useState } from 'react';

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

const LEVEL_COLOR: Record<string, string> = {
  debug: 'text-zinc-500',
  info: 'text-zinc-300',
  warn: 'text-amber-400',
  error: 'text-red-400',
};

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left font-medium text-zinc-300 px-3 py-2 border-b border-zinc-800 whitespace-nowrap">{children}</th>;
}
function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 border-b border-zinc-900 align-top ${className}`}>{children}</td>;
}

export default function LogsViewer() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [service, setService] = useState('');
  const [level, setLevel] = useState('');
  const [correlationId, setCorrelationId] = useState('');
  const [q, setQ] = useState('');
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
      const fresh: LogEntry[] = Array.isArray(json.entries) ? json.entries : [];
      setEntries(fresh);
      sinceRef.current = fresh.length ? Math.max(...fresh.map((e) => e.ts)) : Date.now();
    } catch (err) {
      setError('Failed to load logs.');
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
          className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-300"
          aria-label="Filter by service"
        >
          {SERVICES.map((s) => <option key={s || 'all'} value={s}>{s || 'All services'}</option>)}
        </select>
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-300"
          aria-label="Filter by level"
        >
          {LEVELS.map((l) => <option key={l || 'all'} value={l}>{l || 'All levels'}</option>)}
        </select>
        <input
          value={correlationId}
          onChange={(e) => setCorrelationId(e.target.value)}
          placeholder="correlation id / task id"
          className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-300 w-56"
          aria-label="Filter by correlation id"
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search message…"
          className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-300 w-56"
          aria-label="Search message text"
        />
        <button
          onClick={() => void reload()}
          className="text-sm text-teal-300 hover:underline border border-zinc-800 rounded px-3 py-1"
        >
          Apply
        </button>
        <label className="flex items-center gap-2 text-sm text-zinc-400 ml-auto">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          Live tail
        </label>
      </div>

      {error ? (
        <p className="text-sm text-amber-400 border border-amber-900/50 bg-amber-950/20 rounded px-3 py-2">{error}</p>
      ) : loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-zinc-500">No log entries match these filters yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <Th>When (UTC)</Th>
                <Th>Service</Th>
                <Th>Level</Th>
                <Th>Correlation id</Th>
                <Th>Message</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <Td className="text-zinc-500 whitespace-nowrap">{new Date(e.ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')}</Td>
                  <Td className="text-zinc-400">{e.service}</Td>
                  <Td><span className={LEVEL_COLOR[e.level] ?? 'text-zinc-300'}>{e.level}</span></Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => setCorrelationId(e.correlationId)}
                      className="font-mono text-xs text-teal-300 hover:underline"
                      title="Filter to this correlation id"
                    >
                      {e.correlationId}
                    </button>
                  </Td>
                  <Td className="text-zinc-300">{e.message}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
