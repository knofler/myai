'use client';

// Client manager for active session / device management. Lists UserSession
// rows (device/UA/IP/last-seen), lets the caller revoke one device or every
// other device at once. A password reset revokes everything server-side —
// this page just gives visibility + a manual kill switch.
import { useCallback, useEffect, useState } from 'react';

interface SessionView {
  sessionId: string;
  userAgent?: string;
  ip?: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

function fmt(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

// A short, readable device label from the raw UA string — good enough to
// tell devices apart without pulling in a full UA-parsing dependency.
function deviceLabel(ua?: string): string {
  if (!ua) return 'Unknown device';
  if (/iphone/i.test(ua)) return 'iPhone';
  if (/ipad/i.test(ua)) return 'iPad';
  if (/android/i.test(ua)) return 'Android';
  if (/macintosh|mac os/i.test(ua)) return 'Mac';
  if (/windows/i.test(ua)) return 'Windows PC';
  if (/linux/i.test(ua)) return 'Linux';
  return ua.length > 60 ? `${ua.slice(0, 60)}…` : ua;
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left font-medium text-zinc-300 px-3 py-2 border-b border-zinc-800 whitespace-nowrap">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 border-b border-zinc-900 text-zinc-400 align-top">{children}</td>;
}

export default function SessionsManager() {
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/sessions', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setSessions(Array.isArray(json.sessions) ? json.sessions : []);
    } catch (err) {
      setError('Failed to load sessions.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (s: SessionView) => {
    const msg = s.current
      ? 'Revoke this session? You are currently signed in on it — you will be signed out immediately.'
      : `Revoke the session on "${deviceLabel(s.userAgent)}"? It will be signed out immediately.`;
    if (!confirm(msg)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/sessions/${encodeURIComponent(s.sessionId)}/revoke`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (json.currentRevoked) {
        window.location.href = '/login';
        return;
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke session.');
    } finally {
      setBusy(false);
    }
  };

  const revokeAll = async () => {
    if (!confirm('Sign out every other device? This session stays signed in.')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/sessions/revoke-all', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ includeCurrent: false }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke sessions.');
    } finally {
      setBusy(false);
    }
  };

  const otherCount = sessions.filter((s) => !s.current).length;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">{sessions.length} active session{sessions.length === 1 ? '' : 's'}</p>
        <button
          onClick={() => void revokeAll()}
          disabled={busy || otherCount === 0}
          className="rounded border border-red-800 px-3 py-2 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-50"
        >Sign out all other devices</button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <Th>Device</Th><Th>IP</Th><Th>Last seen</Th><Th>Signed in</Th><Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><Td>Loading…</Td><Td>{''}</Td><Td>{''}</Td><Td>{''}</Td><Td>{''}</Td></tr>
            ) : sessions.length === 0 && !error ? (
              <tr><Td>No active sessions.</Td><Td>{''}</Td><Td>{''}</Td><Td>{''}</Td><Td>{''}</Td></tr>
            ) : (
              sessions.map((s) => (
                <tr key={s.sessionId}>
                  <Td>
                    <span className="text-zinc-200">{deviceLabel(s.userAgent)}</span>
                    {s.current && (
                      <span className="ml-2 rounded bg-emerald-950/40 px-1.5 py-0.5 text-[10px] uppercase text-emerald-400">this device</span>
                    )}
                  </Td>
                  <Td><code className="font-mono text-xs text-zinc-300">{s.ip || '—'}</code></Td>
                  <Td>{fmt(s.lastSeenAt)}</Td>
                  <Td>{fmt(s.createdAt)}</Td>
                  <Td>
                    <button
                      onClick={() => void revoke(s)}
                      disabled={busy}
                      className="rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-50"
                    >Revoke</button>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
