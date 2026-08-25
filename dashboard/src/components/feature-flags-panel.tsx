'use client';

// Admin-only panel: platform feature flags (core/feature-flags.ts) —
// create/edit flags, dial percentage rollout, set per-tenant overrides, and
// pull the kill-switch. Reads/writes go through /api/flags(/[key]), which
// proxy to the gateway's admin-gated REST routes — never Mongo directly.

import { useCallback, useEffect, useState } from 'react';

const inputCls =
  'px-3 py-2 rounded-lg bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] text-sm text-[rgb(var(--text-primary))] placeholder-zinc-600 focus:border-teal-600 outline-none transition-colors';

type FlagState = 'on' | 'off' | 'killed';

interface TenantOverride {
  tenantId: string;
  enabled: boolean;
}

interface FeatureFlagView {
  key: string;
  description?: string;
  state: FlagState;
  rolloutPercent: number;
  overrides: TenantOverride[];
  updatedBy?: string;
  updatedAt?: string;
}

function stateBadgeCls(state: FlagState): string {
  switch (state) {
    case 'on': return 'bg-emerald-500/10 text-emerald-400';
    case 'off': return 'bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-muted))]';
    case 'killed': return 'bg-red-500/10 text-red-400';
    default: return 'bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-muted))]';
  }
}

export default function FeatureFlagsPanel() {
  const [flags, setFlags] = useState<FeatureFlagView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Create/edit form
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [state, setState] = useState<FlagState>('off');
  const [rolloutPercent, setRolloutPercent] = useState('0');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Per-row action state
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [overrideTenant, setOverrideTenant] = useState('');
  const [overrideEnabled, setOverrideEnabled] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/flags', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
      setFlags(body.flags ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(null);
    try {
      const res = await fetch('/api/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: key.trim(),
          description: description || undefined,
          state,
          rolloutPercent: Number(rolloutPercent),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `save failed (${res.status})`);
      setSaved(body.key);
      setKey('');
      setDescription('');
      setState('off');
      setRolloutPercent('0');
      await load();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }

  async function flagAction(flagKey: string, doIt: () => Promise<Response>) {
    setBusyKey(flagKey);
    try {
      const res = await doIt();
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'action failed');
    } finally {
      setBusyKey(null);
    }
  }

  const kill = (flagKey: string) =>
    flagAction(flagKey, () =>
      fetch(`/api/flags/${encodeURIComponent(flagKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'kill' }),
      }));

  const setFlagState = (flagKey: string, next: FlagState, rollout?: number) =>
    flagAction(flagKey, () =>
      fetch('/api/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: flagKey, state: next, ...(rollout !== undefined ? { rolloutPercent: rollout } : {}) }),
      }));

  const remove = (flagKey: string) =>
    flagAction(flagKey, () =>
      fetch(`/api/flags/${encodeURIComponent(flagKey)}`, { method: 'DELETE' }));

  const setOverride = (flagKey: string, tenantId: string, enabled: boolean | null) =>
    flagAction(flagKey, () =>
      fetch(`/api/flags/${encodeURIComponent(flagKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'override', tenantId, enabled }),
      }));

  async function submitOverride(e: React.FormEvent, flagKey: string) {
    e.preventDefault();
    if (!overrideTenant.trim()) return;
    await setOverride(flagKey, overrideTenant.trim(), overrideEnabled);
    setOverrideFor(null);
    setOverrideTenant('');
    setOverrideEnabled(true);
  }

  return (
    <div className="max-w-5xl space-y-6">
      <form onSubmit={save} className="bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded-lg p-5">
        <h3 className="text-sm font-semibold text-[rgb(var(--text-primary))] mb-4">Create / update a flag</h3>

        {saveError && (
          <div className="mb-4 bg-red-950/30 border border-red-800/50 rounded-lg p-3 text-xs text-red-300">
            {saveError}
            {saveError.toLowerCase().includes('admin_disabled') ? (
              <> — set <code className="bg-[rgb(var(--bg-hover))] px-1 rounded">ADMIN_API_TOKEN</code> on the dashboard and gateway to enable this panel.</>
            ) : null}
          </div>
        )}

        {saved && (
          <div className="mb-4 bg-emerald-950/30 border border-emerald-800/50 rounded-lg p-3 text-xs text-emerald-300">
            Saved <span className="font-mono">{saved}</span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-xs text-[rgb(var(--text-muted))] uppercase tracking-wider mb-2">Key</label>
            <input
              className={`${inputCls} w-full font-mono`}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="brain-v2-distiller"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-[rgb(var(--text-muted))] uppercase tracking-wider mb-2">State</label>
            <select className={`${inputCls} w-full`} value={state} onChange={(e) => setState(e.target.value as FlagState)}>
              <option value="off">Off (dark)</option>
              <option value="on">On (rollout applies)</option>
              <option value="killed">Killed</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-[rgb(var(--text-muted))] uppercase tracking-wider mb-2">Rollout %</label>
            <input
              type="number"
              min={0}
              max={100}
              className={`${inputCls} w-full`}
              value={rolloutPercent}
              onChange={(e) => setRolloutPercent(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-[rgb(var(--text-muted))] uppercase tracking-wider mb-2">Description (optional)</label>
            <input
              className={`${inputCls} w-full`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this flag gates"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-sm font-medium text-white transition-colors"
        >
          {saving ? 'Saving…' : 'Save flag'}
        </button>
      </form>

      <div className="bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-[rgb(var(--border-subtle))]">
          <h3 className="text-sm font-semibold text-[rgb(var(--text-primary))]">Feature flags</h3>
        </div>

        {loadError && (
          <div className="p-3 text-xs text-red-300 bg-red-950/30 border-b border-red-800/50">{loadError}</div>
        )}

        {loading ? (
          <div className="p-6 text-center text-xs text-[rgb(var(--text-muted))]">Loading…</div>
        ) : flags.length === 0 ? (
          <div className="p-6 text-center text-xs text-[rgb(var(--text-muted))]">No flags yet — create one above. New flags ship dark.</div>
        ) : (
          <table className="card-table w-full text-sm">
            <thead>
              <tr className="border-b border-[rgb(var(--border-subtle))] text-left text-xs text-[rgb(var(--text-muted))] uppercase tracking-wider">
                <th className="px-4 py-3">Key</th>
                <th className="px-4 py-3">State</th>
                <th className="px-4 py-3 text-right">Rollout</th>
                <th className="px-4 py-3">Overrides</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[rgb(var(--border-subtle))]/50">
              {flags.map((f) => (
                <tr key={f.key} className="hover:bg-[rgb(var(--bg-hover))]/30 transition-colors align-top">
                  <td data-label="Key" className="px-4 py-2 font-mono text-[rgb(var(--text-primary))]">{f.key}</td>
                  <td data-label="State" className="px-4 py-2">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${stateBadgeCls(f.state)}`}>{f.state}</span>
                  </td>
                  <td data-label="Rollout" className="px-4 py-2 text-right text-xs text-[rgb(var(--text-secondary))] font-mono">
                    {f.state === 'on' ? `${f.rolloutPercent}%` : '—'}
                  </td>
                  <td data-label="Overrides" className="px-4 py-2 text-xs text-[rgb(var(--text-secondary))]">
                    {f.overrides.length === 0 ? (
                      <span className="text-[rgb(var(--text-muted))]">none</span>
                    ) : (
                      <div className="space-y-1">
                        {f.overrides.map((o) => (
                          <div key={o.tenantId} className="flex items-center gap-2">
                            <span className="font-mono truncate max-w-[140px]">{o.tenantId}</span>
                            <span className={`px-1.5 py-0.5 rounded ${o.enabled ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                              {o.enabled ? 'on' : 'off'}
                            </span>
                            <button
                              onClick={() => setOverride(f.key, o.tenantId, null)}
                              disabled={busyKey === f.key}
                              className="text-[rgb(var(--text-muted))] hover:text-red-400 disabled:opacity-50"
                              title="Clear override"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {overrideFor === f.key ? (
                      <form onSubmit={(e) => submitOverride(e, f.key)} className="mt-2 flex items-center gap-1.5">
                        <input
                          className={`${inputCls} text-xs py-1 font-mono w-32`}
                          placeholder="tenantId"
                          value={overrideTenant}
                          onChange={(e) => setOverrideTenant(e.target.value)}
                          required
                        />
                        <select
                          className={`${inputCls} text-xs py-1`}
                          value={overrideEnabled ? 'on' : 'off'}
                          onChange={(e) => setOverrideEnabled(e.target.value === 'on')}
                        >
                          <option value="on">on</option>
                          <option value="off">off</option>
                        </select>
                        <button type="submit" disabled={busyKey === f.key} className="px-2 py-1 rounded text-xs bg-teal-600 text-white disabled:opacity-50">Set</button>
                        <button type="button" onClick={() => setOverrideFor(null)} className="px-2 py-1 rounded text-xs bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-secondary))]">Cancel</button>
                      </form>
                    ) : (
                      <button
                        onClick={() => { setOverrideFor(f.key); setOverrideTenant(''); }}
                        className="mt-1 text-xs text-teal-400 hover:text-teal-300"
                      >
                        + override
                      </button>
                    )}
                  </td>
                  <td data-label="Description" className="px-4 py-2 text-xs text-[rgb(var(--text-muted))] max-w-[200px]">{f.description ?? '-'}</td>
                  <td data-label="" className="px-4 py-2 text-right whitespace-nowrap space-x-1.5">
                    {f.state === 'killed' ? (
                      <button
                        onClick={() => setFlagState(f.key, 'off')}
                        disabled={busyKey === f.key}
                        className="px-2.5 py-1 rounded text-xs bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-secondary))] hover:bg-zinc-700 disabled:opacity-50 transition-colors"
                      >
                        Revive (off)
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => setFlagState(f.key, f.state === 'on' ? 'off' : 'on')}
                          disabled={busyKey === f.key}
                          className="px-2.5 py-1 rounded text-xs bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-secondary))] hover:bg-zinc-700 disabled:opacity-50 transition-colors"
                        >
                          {f.state === 'on' ? 'Turn off' : 'Turn on'}
                        </button>
                        <button
                          onClick={() => kill(f.key)}
                          disabled={busyKey === f.key}
                          className="px-2.5 py-1 rounded text-xs bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-50 transition-colors"
                          title="Force off for everyone, overrides included"
                        >
                          Kill
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => remove(f.key)}
                      disabled={busyKey === f.key}
                      className="px-2.5 py-1 rounded text-xs bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-muted))] hover:text-red-400 disabled:opacity-50 transition-colors"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
