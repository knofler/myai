'use client';

// Client viewer for the RBAC v2 audit trail + permission matrix (ADR-013 §5).
// Three panels:
//   1. Audit log — filterable table of privileged actions/denials, newest first,
//      with JSON/CSV export links (streamed through the export proxy).
//   2. Permissions — the role × resource × action grid the gateway derives from
//      the static role→capability lattice (a green/‑ matrix, read-only).
//   3. Shadow denials — ADR-013 §6 soak visibility: what would 403 per
//      tool/route if RBAC_ENFORCE were flipped on today, from the ring buffer
//      `assertCapability` writes to in shadow mode (never the audit trail).
import { useCallback, useEffect, useState } from 'react';
import { DataTable, type DataColumn, type DataRow } from '@/components/ui/data-table';

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
interface ShadowDenialSummaryRow {
  action: string;
  capability: string;
  roles: Record<string, number>;
  count: number;
  lastAt: number;
}
interface AuditChainIssue {
  file: string;
  line: number;
  eventId?: string;
  reason: 'hash-mismatch' | 'prevhash-mismatch' | 'unchained';
}
interface AuditChainVerifyResult {
  ok: boolean;
  filesChecked: number;
  eventsChecked: number;
  corruptLines: number;
  issues: AuditChainIssue[];
}

const ACTIONS = [
  '', 'role.change', 'member.remove', 'invite.create', 'invite.revoke',
  'apikey.create', 'apikey.rotate', 'apikey.revoke', 'rbac.denied',
  'billing.update', 'connector.change', 'schedule.change',
];
const ROLE_COLS = ['viewer', 'member', 'admin', 'owner', 'system', 'operator'];

export default function AuditViewer() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [grid, setGrid] = useState<PermRow[]>([]);
  const [shadowSummary, setShadowSummary] = useState<ShadowDenialSummaryRow[]>([]);
  const [shadowError, setShadowError] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<AuditChainVerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

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

  const runVerify = useCallback(async () => {
    setVerifying(true);
    setVerifyError(null);
    try {
      const res = await fetch('/api/auth/audit/verify', { cache: 'no-store' });
      if (res.status === 403) {
        setVerifyError('You need owner or admin access to verify the audit chain.');
        setVerifyResult(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setVerifyResult(json as AuditChainVerifyResult);
    } catch (err) {
      setVerifyError('Failed to verify the audit chain.');
      console.error(err);
    } finally {
      setVerifying(false);
    }
  }, []);

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

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/auth/rbac/shadow-denials', { cache: 'no-store' });
        if (res.status === 403) {
          setShadowError('You need owner or admin access to view shadow denials.');
          return;
        }
        if (!res.ok) return;
        const json = await res.json();
        setShadowSummary(Array.isArray(json.summary) ? json.summary : []);
      } catch { /* best-effort — the audit table is the primary panel */ }
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
          <h2 className="text-lg font-semibold text-[rgb(var(--text-primary))] mr-auto">Audit log</h2>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded px-2 py-1 text-sm text-[rgb(var(--text-primary))]"
            aria-label="Filter by action"
          >
            {ACTIONS.map((a) => (
              <option key={a || 'all'} value={a}>{a || 'All actions'}</option>
            ))}
          </select>
          <a href={exportHref('json')} className="text-sm text-teal-300 hover:underline border border-[rgb(var(--border-subtle))] rounded px-3 py-1">Export JSON</a>
          <a href={exportHref('csv')} className="text-sm text-teal-300 hover:underline border border-[rgb(var(--border-subtle))] rounded px-3 py-1">Export CSV</a>
          <button
            type="button"
            onClick={() => void runVerify()}
            disabled={verifying}
            className="text-sm text-teal-300 hover:underline border border-[rgb(var(--border-subtle))] rounded px-3 py-1 disabled:opacity-50"
          >
            {verifying ? 'Verifying…' : 'Verify chain'}
          </button>
        </div>

        {verifyError ? (
          <p role="alert" className="text-sm text-amber-400 border border-amber-900/50 bg-amber-950/20 rounded px-3 py-2 mb-4">{verifyError}</p>
        ) : verifyResult ? (
          <div
            className={`text-sm rounded px-3 py-2 mb-4 border ${
              verifyResult.ok
                ? 'text-emerald-400 border-emerald-900/50 bg-emerald-950/20'
                : 'text-red-400 border-red-900/50 bg-red-950/20'
            }`}
          >
            {verifyResult.ok ? (
              <p>
                Chain intact — {verifyResult.eventsChecked} event(s) across {verifyResult.filesChecked} file(s) verified, no gaps or mutations detected.
              </p>
            ) : (
              <div>
                <p className="font-medium mb-1">
                  Tamper detected — {verifyResult.issues.length} issue(s) found across {verifyResult.eventsChecked} event(s) checked.
                </p>
                <ul className="list-disc list-inside space-y-0.5">
                  {verifyResult.issues.map((issue, i) => (
                    <li key={`${issue.file}:${issue.line}:${i}`}>
                      <code className="text-xs">{issue.file}:{issue.line}</code> — {issue.reason}
                      {issue.eventId ? ` (${issue.eventId})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-amber-400 border border-amber-900/50 bg-amber-950/20 rounded px-3 py-2">{error}</p>
        ) : loading ? (
          <p className="text-sm text-[rgb(var(--text-muted))]">Loading…</p>
        ) : (
          <DataTable
            title="Events"
            searchPlaceholder="Search audit log…"
            defaultSort="when"
            defaultDesc
            emptyText="No audit events yet. Privileged actions and access denials will appear here."
            columns={[
              { label: 'When (UTC)', sortKey: 'when', mobile: 'meta' },
              { label: 'Action', mobile: 'title' },
              { label: 'Actor', mobile: 'detail' },
              { label: 'Role', mobile: 'detail' },
              { label: 'Target', mobile: 'detail' },
              { label: 'Detail', mobile: 'detail' },
            ]}
            rows={events.map((e): DataRow => ({
              id: e.eventId,
              search: `${e.action} ${e.actor?.userId ?? ''} ${e.actor?.role ?? ''} ${e.target ?? ''}`.toLowerCase(),
              sort: { when: new Date(e.createdAt).getTime() },
              cells: [
                e.createdAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z'),
                <span className="text-[rgb(var(--text-primary))]">{e.action}</span>,
                e.actor?.userId ?? '—',
                e.actor?.role ?? '—',
                e.target ?? '—',
                e.detail ? <code className="text-xs text-[rgb(var(--text-muted))]">{JSON.stringify(e.detail)}</code> : '—',
              ],
            }))}
          />
        )}
      </section>

      {/* ── Permission matrix ─────────────────────────────────────── */}
      {grid.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-[rgb(var(--text-primary))] mb-1">Permissions</h2>
          <p className="text-sm text-[rgb(var(--text-muted))] mb-4">
            Which roles may perform each action on each resource. Derived from the role capability
            lattice — the server-side matrix is the real boundary.
          </p>
          <DataTable
            title="Permission matrix"
            searchPlaceholder="Search resource/action…"
            columns={[
              { label: 'Resource', mobile: 'title' },
              { label: 'Action', mobile: 'meta' },
              { label: 'Capability', mobile: 'detail' },
              ...ROLE_COLS.map((r): DataColumn => ({ label: r, align: 'center', mobile: 'detail' })),
            ]}
            rows={grid.map((row): DataRow => ({
              id: `${row.resource}.${row.action}`,
              search: `${row.resource} ${row.action} ${row.capability}`.toLowerCase(),
              cells: [
                row.resource,
                row.action,
                <code className="text-xs text-teal-300">{row.capability}</code>,
                ...ROLE_COLS.map((r) =>
                  row.roles[r]
                    ? <span key={r} className="text-emerald-400" aria-label="allowed">✓</span>
                    : <span key={r} className="text-zinc-700" aria-label="denied">—</span>
                ),
              ],
            }))}
          />
        </section>
      )}

      {/* ── Shadow denials ────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-[rgb(var(--text-primary))] mb-1">Shadow denials (would-block if enforced)</h2>
        <p className="text-sm text-[rgb(var(--text-muted))] mb-4">
          RBAC_ENFORCE is currently off, so nothing below is actually blocking a caller — this is a soak view of
          what would 403 the moment enforcement is switched on, grouped by tool/route.
        </p>
        {shadowError ? (
          <p className="text-sm text-amber-400 border border-amber-900/50 bg-amber-950/20 rounded px-3 py-2">{shadowError}</p>
        ) : (
          <DataTable
            title="Shadow denials"
            searchPlaceholder="Search tool/route…"
            defaultSort="count"
            defaultDesc
            emptyText="No shadow denials recorded yet."
            columns={[
              { label: 'Tool / route', sortKey: 'action', mobile: 'title' },
              { label: 'Capability', mobile: 'detail' },
              { label: 'Count', align: 'right', sortKey: 'count', mobile: 'meta' },
              { label: 'By role', mobile: 'detail' },
              { label: 'Last seen (UTC)', sortKey: 'lastAt', mobile: 'detail' },
            ]}
            rows={shadowSummary.map((row): DataRow => ({
              id: row.action,
              search: `${row.action} ${row.capability}`.toLowerCase(),
              sort: { action: row.action, count: row.count, lastAt: row.lastAt },
              cells: [
                <span className="text-[rgb(var(--text-primary))]">{row.action}</span>,
                <code className="text-xs text-teal-300">{row.capability}</code>,
                row.count,
                Object.entries(row.roles).map(([role, count]) => `${role}: ${count}`).join(', '),
                new Date(row.lastAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z'),
              ],
            }))}
          />
        )}
      </section>
    </div>
  );
}
