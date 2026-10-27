'use client';

// Client manager for active session / device management. Lists UserSession
// rows (device/UA/IP/last-seen), lets the caller revoke one device or every
// other device at once. A password reset revokes everything server-side —
// this page just gives visibility + a manual kill switch.
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { DataTable, type DataRow } from '@/components/ui/data-table';

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
        window.location.href = '/operator-login';
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

  const rows: DataRow[] = sessions.map((s) => ({
    id: s.sessionId,
    search: `${deviceLabel(s.userAgent)} ${s.ip ?? ''}`.toLowerCase(),
    sort: { lastSeen: s.lastSeenAt ? new Date(s.lastSeenAt).getTime() : 0 },
    cells: [
      <span key="d" className="text-[rgb(var(--text-primary))]">
        {deviceLabel(s.userAgent)}
        {s.current && (
          <Badge className="ml-2 bg-emerald-500/15 text-emerald-400 border-emerald-500/30 uppercase text-label">this device</Badge>
        )}
      </span>,
      <code key="ip" className="font-mono text-xs text-[rgb(var(--text-primary))]">{s.ip || '—'}</code>,
      <span key="ls" className="text-[rgb(var(--text-secondary))]">{fmt(s.lastSeenAt)}</span>,
      <span key="si" className="text-[rgb(var(--text-secondary))]">{fmt(s.createdAt)}</span>,
      <button
        key="rv"
        onClick={() => void revoke(s)}
        disabled={busy}
        className="rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-50"
      >Revoke</button>,
    ],
  }));

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-[rgb(var(--text-muted))]">{sessions.length} active session{sessions.length === 1 ? '' : 's'}</p>
        <button
          onClick={() => void revokeAll()}
          disabled={busy || otherCount === 0}
          className="rounded border border-red-800 px-3 py-2 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-50"
        >Sign out all other devices</button>
      </div>

      <DataTable
        title="Active sessions"
        searchable={false}
        defaultSort="lastSeen"
        defaultDesc
        columns={[
          { label: 'Device', mobile: 'title' },
          { label: 'IP', mobile: 'meta' },
          { label: 'Last seen', sortKey: 'lastSeen', mobile: 'meta' },
          { label: 'Signed in', mobile: 'detail' },
          { label: 'Actions', mobile: 'badge' },
        ]}
        rows={loading ? [] : rows}
        emptyText={loading ? 'Loading…' : 'No active sessions.'}
      />
    </div>
  );
}
