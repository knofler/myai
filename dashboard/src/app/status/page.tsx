// Public /status page — the customer-facing health page for the hosted myAI
// product. Reachable without a login (added to PUBLIC_PREFIXES in middleware).
// Server component: renders the shared status snapshot directly, no self-fetch.
//
// D5 / DESIGN_LANGUAGE §5a (pass 2, 2026-09-18): the page used to open on a
// bare <h1> sitting straight on a component table — the console look. It now
// leads with PageHeader: the big "status" glyph plus a plain-English ANSWER
// ("Everything is running normally." / "The CLI task runner is degraded.")
// derived from the same snapshot the rows below render. No new fetch, same
// layout, same max-w-3xl column.
//
// DASH-B2 (2026-09-24): this page predated the token system entirely — it was
// still hardcoded to bg-neutral-950/text-white/bg-green-500. Migrated onto
// --bg-canvas/--text-*/--ok/--warn/--err tokens and the shared
// ComponentStatusBadge/LevelDot so a status colour lives in one place.

import { getPublicStatus, type CompStatus, type Component, type PublicStatus, type UptimeWindow } from '@/lib/status';
import type { Incident } from '@/lib/incidents';
import { PageHeader } from '@/components/page-header';
import { plural, verb, joinClauses, cap } from '@/lib/summary';
import { ComponentStatusBadge, LevelDot, componentLevel } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

const BANNER: Record<CompStatus, { text: string; cls: string }> = {
  operational: { text: 'All systems operational', cls: 'bg-[rgb(var(--ok))]/10 text-[rgb(var(--ok))] border-[rgb(var(--ok))]/30' },
  degraded: { text: 'Some systems degraded', cls: 'bg-[rgb(var(--warn))]/10 text-[rgb(var(--warn))] border-[rgb(var(--warn))]/30' },
  down: { text: 'Major outage', cls: 'bg-[rgb(var(--err))]/10 text-[rgb(var(--err))] border-[rgb(var(--err))]/30' },
};

const COMPONENT_LABELS: Record<string, string> = {
  gateway: 'API Gateway',
  dashboard: 'Dashboard',
  mongo: 'Database (MongoDB)',
  runner: 'CLI Task Runner',
};

function pct(n: number): string {
  return `${(n * 100).toFixed(n >= 0.9995 ? 2 : 1)}%`;
}

function Uptime({ label, w }: { label: string; w: UptimeWindow }) {
  return (
    <div className="rounded-lg border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))] px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums text-[rgb(var(--text-primary))]">{w.samples > 0 ? pct(w.uptime) : '—'}</div>
      <div className="text-xs text-[rgb(var(--text-muted))] mt-1">{label}</div>
    </div>
  );
}

function ComponentRow({ id, c }: { id: string; c: Component }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-[rgb(var(--border-subtle))]/60 last:border-b-0">
      <div className="flex items-center gap-3">
        <LevelDot level={componentLevel(c.status)} />
        <span className="text-sm text-[rgb(var(--text-primary))]">{COMPONENT_LABELS[id] ?? id}</span>
      </div>
      <div className="flex items-center gap-3 text-xs">
        {c.detail && <span className="text-[rgb(var(--text-muted))]">{c.detail}</span>}
        {typeof c.latencyMs === 'number' && <span className="text-[rgb(var(--text-muted))] tabular-nums">{c.latencyMs}ms</span>}
        <ComponentStatusBadge status={c.status} />
      </div>
    </div>
  );
}

function IncidentCard({ i }: { i: Incident }) {
  const active = i.status !== 'resolved';
  return (
    <div className="rounded-lg border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))] p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-[rgb(var(--text-primary))]">{i.title}</h3>
        <span
          className={`text-xs px-2 py-0.5 rounded-full border ${
            active
              ? 'bg-[rgb(var(--warn))]/15 text-[rgb(var(--warn))] border-[rgb(var(--warn))]/30'
              : 'bg-zinc-700/40 text-[rgb(var(--text-muted))] border-zinc-600/50'
          }`}
        >
          {i.status}
        </span>
      </div>
      <div className="text-xs text-[rgb(var(--text-muted))] mt-1">
        {new Date(i.startedAt).toLocaleString()}
        {i.resolvedAt && ` → ${new Date(i.resolvedAt).toLocaleString()}`}
        {i.components.length > 0 && ` · ${i.components.join(', ')}`}
      </div>
      {i.updates?.length > 0 && (
        <ul className="mt-3 space-y-2">
          {i.updates.map((u, idx) => (
            <li key={idx} className="text-xs text-[rgb(var(--text-secondary))]">
              <span className="text-[rgb(var(--text-muted))]">{new Date(u.at).toLocaleString()}</span> —{' '}
              <span className="uppercase text-[rgb(var(--text-muted))]">{u.status}</span>: {u.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── The one-line answer (DESIGN_LANGUAGE §5.1) ─────────────── */

/**
 * Says plainly whether everything is healthy, or exactly what is not.
 * Built only from the snapshot this page already renders — component statuses
 * and the incident list. Never states a number that isn't in that snapshot.
 */
function statusSummary(s: PublicStatus): string {
  const entries: [string, Component][] = Object.entries(s.components);
  const name = (id: string) => COMPONENT_LABELS[id] ?? id;
  const down = entries.filter(([, c]) => c.status === 'down').map(([id]) => name(id));
  const degraded = entries.filter(([, c]) => c.status === 'degraded').map(([id]) => name(id));
  const openIncidents = s.incidents.filter((i) => i.status !== 'resolved').length;
  const incidentLine =
    openIncidents > 0
      ? ` ${plural(openIncidents, 'incident')} ${verb(openIncidents, 'is', 'are')} still open.`
      : '';

  if (down.length === 0 && degraded.length === 0) {
    return `Everything is running normally.${incidentLine || ' No incidents are open.'}`;
  }

  const fault = joinClauses([
    down.length > 0 && `${joinClauses(down)} ${verb(down.length, 'is', 'are')} down`,
    degraded.length > 0 && `${joinClauses(degraded)} ${verb(degraded.length, 'is', 'are')} degraded`,
  ]);
  const healthy = entries.length - down.length - degraded.length;
  const rest = healthy > 0 ? ' Everything else is running normally.' : '';
  return `${cap(fault)}.${rest}${incidentLine}`;
}

export default async function StatusPage() {
  const s = await getPublicStatus();
  const banner = BANNER[s.status];

  return (
    <div className="min-h-screen bg-[rgb(var(--bg-canvas))] text-[rgb(var(--text-primary))]">
      <div className="max-w-3xl mx-auto px-4 py-12">
        <PageHeader
          icon="status"
          title="myAI Status"
          summary={statusSummary(s)}
          subtitle={`Live health of the myAI platform. Updated ${new Date(s.timestamp).toLocaleString()}.`}
        />

        <div className={`rounded-xl border px-5 py-4 mb-8 font-medium ${banner.cls}`}>{banner.text}</div>

        <section className="mb-10">
          <h2 className="text-xs uppercase tracking-wide text-[rgb(var(--text-muted))] mb-3">Components</h2>
          <div className="rounded-xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))]/40">
            {Object.entries(s.components).map(([id, c]) => (
              <ComponentRow key={id} id={id} c={c} />
            ))}
          </div>
        </section>

        {s.uptime && (
          <section className="mb-10">
            <h2 className="text-xs uppercase tracking-wide text-[rgb(var(--text-muted))] mb-3">Gateway uptime</h2>
            <div className="grid grid-cols-3 gap-3">
              <Uptime label="Last hour" w={s.uptime.windows.hour} />
              <Uptime label="Last 24 hours" w={s.uptime.windows.day} />
              <Uptime label="Last 7 days" w={s.uptime.windows.week} />
            </div>
          </section>
        )}

        <section>
          <h2 className="text-xs uppercase tracking-wide text-[rgb(var(--text-muted))] mb-3">Incident history</h2>
          {s.incidents.length === 0 ? (
            <div className="rounded-xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))]/40 px-5 py-6 text-sm text-[rgb(var(--text-muted))]">
              No incidents reported.
            </div>
          ) : (
            <div className="space-y-3">
              {s.incidents.map((i) => (
                <IncidentCard key={i.id} i={i} />
              ))}
            </div>
          )}
        </section>

        <footer className="mt-12 text-xs text-[rgb(var(--text-muted))]">
          Machine-readable feed:{' '}
          <a className="underline hover:text-[rgb(var(--text-secondary))]" href="/api/status">
            /api/status
          </a>
        </footer>
      </div>
    </div>
  );
}
