'use client';

// Client viewer for the RBAC v2 audit trail + permission matrix (ADR-013 §5).
// Two panels:
//   1. Audit log — filterable table of privileged actions/denials, newest first,
//      with JSON/CSV export links (streamed through the export proxy).
//   2. Permissions — the role × resource × action grid the gateway derives from
//      the static role→capability lattice (a green/‑ matrix, read-only).
import { useCallback, useEffect, useState } from 'react';

// ── shared types (mirror the gateway shapes) ──────────────────────────────────
interface AuditActor { userId?: string; role: string; via: string }
interface AuditEvent {
  eventId: string;
  action: string;
  actor: AuditActor;
  target?: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}
interface PermRow {
  resource: string;
  action: string;
  capability: string;
  roles: Record<string, boolean>;
}

const ACTIONS = [
  '', 'role.change', 'member.remove', 'invite.create', 'invite.revoke',
  'apikey.create', 'apikey.rotate', 'apikey.revoke', 'rbac.denied',
  'billing.update', 'connector.change', 'schedule.change',
];
const ROLE_COLS = ['viewer', 'member', 'admin', 'owner', 'system', 'operator'];

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left font-medium text-zinc-300 px-3 py-2 border-b border-zinc-800 whitespace-nowrap">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 border-b border-zinc-900 text-zinc-400 align-top">{children}</td>;
}

export default function AuditViewer() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [grid, setGrid] = useState<PermRow[]>([]);
  const [action, setAction] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAudit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (action) qs.set('action', action);
      qs.set('limit', '200');
      const res = await fetch(`/api/auth/audit?${qs.toString()}`, { cache: 'no-store' });
      if (res.status === 403) {
        setError('You need owner or admin access to view the audit trail.');
        setEvents([]);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setEvents(Array.isArray(json.events) ? json.events : []);
    } catch (err) {
      setError('Failed to load the audit trail.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [action]);

  useEffect(() => { void loadAudit(); }, [loadAudit]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/auth/permissions', { cache: 'no-store' });
        if (!res.ok) return;
        const json = await res.json();
        setGrid(Array.isArray(json.grid) ? json.grid : []);
      } catch { /* matrix is best-effort — the audit table is the primary panel */ }
    })();
  }, []);

  const exportHref = (format: 'json' | 'csv') => {
    const qs = new URLSearchParams({ format });
    if (action) qs.set('action', action);
    return `/api/auth/audit/export?${qs.toString()}`;
  };

  return (
    <div className="space-y-10">
      {/* ── Audit log ─────────────────────────────────────────────── */}
      <section>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <h2 className="text-lg font-semibold text-zinc-200 mr-auto">Audit log</h2>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-300"
            aria-label="Filter by action"
          >
            {ACTIONS.map((a) => (
              <option key={a || 'all'} value={a}>{a || 'All actions'}</option>
            ))}
          </select>
          <a href={exportHref('json')} className="text-sm text-teal-300 hover:underline border border-zinc-800 rounded px-3 py-1">Export JSON</a>
          <a href={exportHref('csv')} className="text-sm text-teal-300 hover:underline border border-zinc-800 rounded px-3 py-1">Export CSV</a>
        </div>

        {error ? (
          <p className="text-sm text-amber-400 border border-amber-900/50 bg-amber-950/20 rounded px-3 py-2">{error}</p>
        ) : loading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-zinc-500">No audit events yet. Privileged actions and access denials will appear here.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr>
                  <Th>When (UTC)</Th>
                  <Th>Action</Th>
                  <Th>Actor</Th>
                  <Th>Role</Th>
                  <Th>Target</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.eventId}>
                    <Td>{e.createdAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}</Td>
                    <Td><span className="text-zinc-300">{e.action}</span></Td>
                    <Td>{e.actor?.userId ?? '—'}</Td>
                    <Td>{e.actor?.role ?? '—'}</Td>
                    <Td>{e.target ?? '—'}</Td>
                    <Td>{e.detail ? <code className="text-xs text-zinc-500">{JSON.stringify(e.detail)}</code> : '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Permission matrix ─────────────────────────────────────── */}
      {grid.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-zinc-200 mb-1">Permissions</h2>
          <p className="text-sm text-zinc-500 mb-4">
            Which roles may perform each action on each resource. Derived from the role capability
            lattice — the server-side matrix is the real boundary.
          </p>
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr>
                  <Th>Resource</Th>
                  <Th>Action</Th>
                  <Th>Capability</Th>
                  {ROLE_COLS.map((r) => <Th key={r}>{r}</Th>)}
                </tr>
              </thead>
              <tbody>
                {grid.map((row) => (
                  <tr key={`${row.resource}.${row.action}`}>
                    <Td>{row.resource}</Td>
                    <Td>{row.action}</Td>
                    <Td><code className="text-xs text-teal-300">{row.capability}</code></Td>
                    {ROLE_COLS.map((r) => (
                      <td key={r} className="px-3 py-2 border-b border-zinc-900 text-center">
                        {row.roles[r]
                          ? <span className="text-emerald-400" aria-label="allowed">✓</span>
                          : <span className="text-zinc-700" aria-label="denied">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
