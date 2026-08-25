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

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left font-medium text-[rgb(var(--text-primary))] px-3 py-2 border-b border-[rgb(var(--border-subtle))] whitespace-nowrap">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 border-b border-[rgb(var(--border-subtle))] text-[rgb(var(--text-secondary))] align-top">{children}</td>;
}

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
          <p className="text-sm text-amber-400 border border-amber-900/50 bg-amber-950/20 rounded px-3 py-2 mb-4">{verifyError}</p>
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
          <p className="text-sm text-amber-400 border border-amber-900/50 bg-amber-950/20 rounded px-3 py-2">{error}</p>
        ) : loading ? (
          <p className="text-sm text-[rgb(var(--text-muted))]">Loading…</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-[rgb(var(--text-muted))]">No audit events yet. Privileged actions and access denials will appear here.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[rgb(var(--border-subtle))]">
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
                    <Td><span className="text-[rgb(var(--text-primary))]">{e.action}</span></Td>
                    <Td>{e.actor?.userId ?? '—'}</Td>
                    <Td>{e.actor?.role ?? '—'}</Td>
                    <Td>{e.target ?? '—'}</Td>
                    <Td>{e.detail ? <code className="text-xs text-[rgb(var(--text-muted))]">{JSON.stringify(e.detail)}</code> : '—'}</Td>
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
          <h2 className="text-lg font-semibold text-[rgb(var(--text-primary))] mb-1">Permissions</h2>
          <p className="text-sm text-[rgb(var(--text-muted))] mb-4">
            Which roles may perform each action on each resource. Derived from the role capability
            lattice — the server-side matrix is the real boundary.
          </p>
          <div className="overflow-x-auto rounded-lg border border-[rgb(var(--border-subtle))]">
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
                      <td key={r} className="px-3 py-2 border-b border-[rgb(var(--border-subtle))] text-center">
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

      {/* ── Shadow denials ────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-[rgb(var(--text-primary))] mb-1">Shadow denials (would-block if enforced)</h2>
        <p className="text-sm text-[rgb(var(--text-muted))] mb-4">
          RBAC_ENFORCE is currently off, so nothing below is actually blocking a caller — this is a soak view of
          what would 403 the moment enforcement is switched on, grouped by tool/route.
        </p>
        {shadowError ? (
          <p className="text-sm text-amber-400 border border-amber-900/50 bg-amber-950/20 rounded px-3 py-2">{shadowError}</p>
        ) : shadowSummary.length === 0 ? (
          <p className="text-sm text-[rgb(var(--text-muted))]">No shadow denials recorded yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[rgb(var(--border-subtle))]">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr>
                  <Th>Tool / route</Th>
                  <Th>Capability</Th>
                  <Th>Count</Th>
                  <Th>By role</Th>
                  <Th>Last seen (UTC)</Th>
                </tr>
              </thead>
              <tbody>
                {shadowSummary.map((row) => (
                  <tr key={row.action}>
                    <Td><span className="text-[rgb(var(--text-primary))]">{row.action}</span></Td>
                    <Td><code className="text-xs text-teal-300">{row.capability}</code></Td>
                    <Td>{row.count}</Td>
                    <Td>
                      {Object.entries(row.roles)
                        .map(([role, count]) => `${role}: ${count}`)
                        .join(', ')}
                    </Td>
                    <Td>{new Date(row.lastAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
