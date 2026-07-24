'use client';

// Per-tenant MCP connector manager. Lists the curated bundle + custom
// connectors, toggles them on/off, adds custom ones, and re-seeds the bundle —
// all against /api/connectors (tenant-scoped). This is what makes a fresh
// betaC install's connectors visible + editable day one.

import { useCallback, useEffect, useState } from 'react';

interface Connector {
  key: string;
  label: string;
  category: string;
  transport: 'http' | 'stdio';
  description?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  requiresEnv?: string[];
  enabled: boolean;
  source: 'bundled' | 'custom';
}

const CATEGORY_LABEL: Record<string, string> = {
  framework: 'Framework',
  docs: 'Documentation',
  design: 'Design',
  browser: 'Browser',
  vcs: 'Source control',
  deploy: 'Deploy',
  storage: 'Storage',
  custom: 'Custom',
};

const inputCls =
  'w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-100 placeholder-zinc-600 focus:border-teal-600 outline-none transition-colors';

export default function ConnectorManager() {
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/connectors', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'could not load connectors');
      setConnectors(json.connectors as Connector[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not load connectors');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function post(payload: Record<string, unknown>, key?: string) {
    if (key) setBusyKey(key);
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'operation failed');
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'operation failed');
      return false;
    } finally {
      setBusyKey(null);
    }
  }

  if (error && !connectors) {
    return <div className="px-3 py-2 rounded-lg bg-rose-950/50 border border-rose-800/50 text-sm text-rose-300">{error}</div>;
  }
  if (!connectors) {
    return <div className="text-sm text-zinc-500">Loading connectors…</div>;
  }

  const enabled = connectors.filter((c) => c.enabled).length;
  const needsKey = connectors.filter((c) => (c.requiresEnv?.length ?? 0) > 0 && c.enabled === false);

  // Group by category, framework first.
  const order = ['framework', 'docs', 'design', 'browser', 'vcs', 'deploy', 'storage', 'custom'];
  const groups: Record<string, Connector[]> = {};
  for (const c of connectors) (groups[c.category] ??= []).push(c);
  const sortedCats = Object.keys(groups).sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  return (
    <div className="space-y-6">
      {error && (
        <div className="px-3 py-2 rounded-lg bg-rose-950/50 border border-rose-800/50 text-xs text-rose-300">{error}</div>
      )}

      {/* Summary + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-4 text-sm">
          <span className="text-zinc-400">{connectors.length} connectors</span>
          <span className="text-emerald-400">{enabled} enabled</span>
          {needsKey.length > 0 && <span className="text-amber-400">{needsKey.length} need a key</span>}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => post({ action: 'seed' })}
            className="gel-surface px-3 py-2 rounded-lg border border-zinc-800 text-sm text-zinc-200 hover:border-zinc-700 transition"
          >
            Re-seed bundle
          </button>
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="gel-brand px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 transition"
          >
            {showAdd ? 'Close' : '+ Custom connector'}
          </button>
        </div>
      </div>

      {showAdd && <AddForm onAdd={async (payload) => { const ok = await post({ action: 'set', ...payload }); if (ok) setShowAdd(false); }} />}

      {/* Grouped connectors */}
      {sortedCats.map((cat) => (
        <div key={cat}>
          <h2 className="text-xs font-semibold text-zinc-500 mb-2 uppercase tracking-wider">{CATEGORY_LABEL[cat] || cat}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {groups[cat].map((c) => (
              <div key={c.key} className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4 flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-sm text-zinc-100 truncate">{c.label}</p>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">{c.transport}</span>
                      {c.source === 'custom' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">custom</span>}
                    </div>
                    <p className="text-[11px] text-zinc-600 font-mono mt-0.5">{c.key}</p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={c.enabled}
                    disabled={busyKey === c.key}
                    onClick={() => post({ action: 'toggle', key: c.key, enabled: !c.enabled }, c.key)}
                    className={`shrink-0 w-10 h-6 rounded-full relative transition-colors disabled:opacity-50 ${c.enabled ? 'bg-emerald-500/80' : 'bg-zinc-700'}`}
                    title={c.enabled ? 'Disable' : 'Enable'}
                  >
                    <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${c.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                  </button>
                </div>

                <p className="text-xs text-zinc-400 line-clamp-2">{c.description}</p>

                <p className="text-[11px] text-zinc-600 font-mono truncate">
                  {c.transport === 'http' ? c.url : `${c.command ?? ''} ${(c.args ?? []).join(' ')}`}
                </p>

                {(c.requiresEnv?.length ?? 0) > 0 && (
                  <p className="text-[11px] text-amber-400/90">
                    Needs env: {c.requiresEnv!.join(', ')}
                  </p>
                )}

                {c.source === 'custom' && (
                  <button
                    onClick={() => post({ action: 'remove', key: c.key }, c.key)}
                    disabled={busyKey === c.key}
                    className="self-start text-[11px] text-rose-400/80 hover:text-rose-300 disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AddForm({ onAdd }: { onAdd: (payload: Record<string, unknown>) => void | Promise<void> }) {
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [transport, setTransport] = useState<'http' | 'stdio'>('http');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [description, setDescription] = useState('');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onAdd({ key: key.trim(), label: label.trim() || undefined, transport, url, command, args, description });
      }}
      className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4 space-y-3"
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs text-zinc-500 mb-1">Key (slug)</span>
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="my-server" className={`${inputCls} font-mono`} required />
        </label>
        <label className="block">
          <span className="block text-xs text-zinc-500 mb-1">Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My Server" className={inputCls} />
        </label>
      </div>
      <label className="block">
        <span className="block text-xs text-zinc-500 mb-1">Transport</span>
        <select value={transport} onChange={(e) => setTransport(e.target.value as 'http' | 'stdio')} className={inputCls}>
          <option value="http">http (url)</option>
          <option value="stdio">stdio (command)</option>
        </select>
      </label>
      {transport === 'http' ? (
        <label className="block">
          <span className="block text-xs text-zinc-500 mb-1">URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" className={`${inputCls} font-mono`} />
        </label>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs text-zinc-500 mb-1">Command</span>
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className={`${inputCls} font-mono`} />
          </label>
          <label className="block">
            <span className="block text-xs text-zinc-500 mb-1">Args (space-separated)</span>
            <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @scope/mcp-server" className={`${inputCls} font-mono`} />
          </label>
        </div>
      )}
      <label className="block">
        <span className="block text-xs text-zinc-500 mb-1">Description</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this connector does" className={inputCls} />
      </label>
      <button type="submit" disabled={!key.trim()} className="gel-brand px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 disabled:opacity-40 transition">
        Add connector
      </button>
    </form>
  );
}
