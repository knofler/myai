'use client';

// Client manager for scoped per-tenant API keys (ADR-010 §3.6). owner/admin
// only — the gateway members-capability gate returns 403, rendered here as an
// access notice. The raw key is returned ONCE by create/rotate and shown in a
// dismissable "copy it now" banner; the list only ever holds non-secret views.
import { useCallback, useEffect, useState } from 'react';

interface ApiKeyView {
  keyId: string;
  name: string;
  scopes: string[];
  prefix: string;
  env: 'live' | 'test';
  status: 'active' | 'revoked';
  lastUsedAt?: string;
  expiresAt?: string;
  createdAt?: string;
  rotatedFromKeyId?: string;
}

function fmt(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

// A rotated-out key keeps status 'active' but carries a future expiresAt — it is
// authenticating only through its grace window, so surface it distinctly.
function keyState(k: ApiKeyView): { label: string; cls: string } {
  if (k.status === 'revoked') return { label: 'revoked', cls: 'text-red-400 bg-red-950/40' };
  if (k.expiresAt && new Date(k.expiresAt).getTime() > Date.now()) {
    return { label: 'expiring', cls: 'text-amber-400 bg-amber-950/40' };
  }
  return { label: 'active', cls: 'text-emerald-400 bg-emerald-950/40' };
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left font-medium text-zinc-300 px-3 py-2 border-b border-zinc-800 whitespace-nowrap">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 border-b border-zinc-900 text-zinc-400 align-top">{children}</td>;
}

export default function ApiKeysManager() {
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [scopeVocab, setScopeVocab] = useState<string[]>(['*']);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // create form
  const [name, setName] = useState('');
  const [env, setEnv] = useState<'live' | 'test'>('live');
  const [scopes, setScopes] = useState<string[]>(['*']);

  // show-once raw key
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [rawKeyNote, setRawKeyNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/api-keys', { cache: 'no-store' });
      if (res.status === 403) {
        setError('You need owner or admin access to manage API keys.');
        setKeys([]);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setKeys(Array.isArray(json.keys) ? json.keys : []);
      if (Array.isArray(json.scopes)) setScopeVocab(json.scopes);
    } catch (err) {
      setError('Failed to load API keys.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggleScope = (s: string) => {
    setScopes((prev) => {
      if (s === '*') return ['*'];
      const next = prev.filter((x) => x !== '*');
      return next.includes(s) ? next.filter((x) => x !== s) : [...next, s];
    });
  };

  const create = async () => {
    if (!name.trim()) { setError('Give the key a name.'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), scopes, env }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setRawKey(json.rawKey);
      setRawKeyNote(`New key “${json.key?.name}” created — copy it now, it won't be shown again.`);
      setName('');
      setScopes(['*']);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create key.');
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (k: ApiKeyView) => {
    if (!confirm(`Rotate “${k.name}”? A new key is issued now; this one keeps working for a 60-minute grace window, then stops.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/api-keys/rotate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keyId: k.keyId, graceMinutes: 60 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setRawKey(json.rawKey);
      setRawKeyNote(`“${k.name}” rotated — swap in this new key within the grace window. Copy it now.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rotate key.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (k: ApiKeyView) => {
    if (!confirm(`Revoke “${k.name}” immediately? Any caller using it will start getting 401s at once.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/api-keys/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keyId: k.keyId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke key.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {rawKey && (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/30 px-4 py-3">
          <p className="text-sm text-emerald-300">{rawKeyNote}</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 select-all break-all rounded bg-black/50 px-3 py-2 font-mono text-xs text-emerald-200">{rawKey}</code>
            <button
              onClick={() => { void navigator.clipboard?.writeText(rawKey); }}
              className="rounded border border-emerald-700 px-3 py-2 text-xs text-emerald-300 hover:bg-emerald-900/40"
            >Copy</button>
            <button
              onClick={() => setRawKey(null)}
              className="rounded border border-zinc-700 px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800"
            >Done</button>
          </div>
        </div>
      )}

      {/* Create */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4">
        <h2 className="text-sm font-medium text-zinc-200">Create a key</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Key name (e.g. CI runner, Zapier)"
            maxLength={80}
            className="rounded border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600"
          />
          <select
            value={env}
            onChange={(e) => setEnv(e.target.value as 'live' | 'test')}
            className="rounded border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-zinc-200"
          >
            <option value="live">live</option>
            <option value="test">test (sandbox)</option>
          </select>
        </div>
        <div className="mt-3">
          <p className="text-xs text-zinc-500">Scopes — <code>*</code> grants full access; pick granular scopes for least privilege.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {scopeVocab.map((s) => (
              <label key={s} className={`cursor-pointer rounded border px-2 py-1 text-xs ${scopes.includes(s) ? 'border-sky-600 bg-sky-950/40 text-sky-300' : 'border-zinc-700 text-zinc-400'}`}>
                <input type="checkbox" className="mr-1 align-middle" checked={scopes.includes(s)} onChange={() => toggleScope(s)} />
                {s}
              </label>
            ))}
          </div>
        </div>
        <button
          onClick={() => void create()}
          disabled={busy}
          className="mt-4 rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >{busy ? 'Working…' : 'Create key'}</button>
      </div>

      {/* List */}
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <Th>Name</Th><Th>Prefix</Th><Th>Scopes</Th><Th>Status</Th><Th>Last used</Th><Th>Created</Th><Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><Td>Loading…</Td><Td>{''}</Td><Td>{''}</Td><Td>{''}</Td><Td>{''}</Td><Td>{''}</Td><Td>{''}</Td></tr>
            ) : keys.length === 0 && !error ? (
              <tr><Td>No API keys yet — create one above.</Td><Td>{''}</Td><Td>{''}</Td><Td>{''}</Td><Td>{''}</Td><Td>{''}</Td><Td>{''}</Td></tr>
            ) : (
              keys.map((k) => {
                const st = keyState(k);
                return (
                  <tr key={k.keyId}>
                    <Td>
                      <span className="text-zinc-200">{k.name}</span>
                      <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400">{k.env}</span>
                    </Td>
                    <Td><code className="font-mono text-xs text-zinc-300">{k.prefix}…</code></Td>
                    <Td><span className="font-mono text-xs">{k.scopes.join(', ')}</span></Td>
                    <Td>
                      <span className={`rounded px-2 py-0.5 text-xs ${st.cls}`}>{st.label}</span>
                      {st.label === 'expiring' && k.expiresAt && (
                        <div className="mt-1 text-[11px] text-amber-500/80">until {fmt(k.expiresAt)}</div>
                      )}
                    </Td>
                    <Td>{fmt(k.lastUsedAt)}</Td>
                    <Td>{fmt(k.createdAt)}</Td>
                    <Td>
                      {k.status === 'active' ? (
                        <div className="flex gap-2">
                          <button onClick={() => void rotate(k)} disabled={busy} className="rounded border border-amber-700 px-2 py-1 text-xs text-amber-300 hover:bg-amber-950/40 disabled:opacity-50">Rotate</button>
                          <button onClick={() => void revoke(k)} disabled={busy} className="rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-50">Revoke</button>
                        </div>
                      ) : (
                        <span className="text-xs text-zinc-600">—</span>
                      )}
                    </Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
