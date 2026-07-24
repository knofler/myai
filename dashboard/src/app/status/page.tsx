// Public /status page — the customer-facing health page for the hosted myAI
// product. Reachable without a login (added to PUBLIC_PREFIXES in middleware).
// Server component: renders the shared status snapshot directly, no self-fetch.

import { getPublicStatus, type CompStatus, type Component, type UptimeWindow } from '@/lib/status';
import type { Incident } from '@/lib/incidents';

export const dynamic = 'force-dynamic';

const LABEL: Record<CompStatus, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
};

const DOT: Record<CompStatus, string> = {
  operational: 'bg-green-500',
  degraded: 'bg-amber-500',
  down: 'bg-red-500',
};

const BANNER: Record<CompStatus, { text: string; cls: string }> = {
  operational: { text: 'All systems operational', cls: 'bg-green-500/10 text-green-400 border-green-500/30' },
  degraded: { text: 'Some systems degraded', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  down: { text: 'Major outage', cls: 'bg-red-500/10 text-red-400 border-red-500/30' },
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
    <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums">{w.samples > 0 ? pct(w.uptime) : '—'}</div>
      <div className="text-xs text-white/50 mt-1">{label}</div>
    </div>
  );
}

function ComponentRow({ id, c }: { id: string; c: Component }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 last:border-b-0">
      <div className="flex items-center gap-3">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[c.status]}`} aria-hidden />
        <span className="text-sm text-white/90">{COMPONENT_LABELS[id] ?? id}</span>
      </div>
      <div className="flex items-center gap-3 text-xs">
        {c.detail && <span className="text-white/40">{c.detail}</span>}
        {typeof c.latencyMs === 'number' && <span className="text-white/40 tabular-nums">{c.latencyMs}ms</span>}
        <span className="text-white/70">{LABEL[c.status]}</span>
      </div>
    </div>
  );
}

function IncidentCard({ i }: { i: Incident }) {
  const active = i.status !== 'resolved';
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-white/90">{i.title}</h3>
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${
            active ? 'bg-amber-500/15 text-amber-400' : 'bg-white/10 text-white/50'
          }`}
        >
          {i.status}
        </span>
      </div>
      <div className="text-xs text-white/40 mt-1">
        {new Date(i.startedAt).toLocaleString()}
        {i.resolvedAt && ` → ${new Date(i.resolvedAt).toLocaleString()}`}
        {i.components.length > 0 && ` · ${i.components.join(', ')}`}
      </div>
      {i.updates?.length > 0 && (
        <ul className="mt-3 space-y-2">
          {i.updates.map((u, idx) => (
            <li key={idx} className="text-xs text-white/60">
              <span className="text-white/40">{new Date(u.at).toLocaleString()}</span> —{' '}
              <span className="uppercase text-white/50">{u.status}</span>: {u.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default async function StatusPage() {
  const s = await getPublicStatus();
  const banner = BANNER[s.status];

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="max-w-3xl mx-auto px-4 py-12">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold">myAI Status</h1>
          <p className="text-sm text-white/40 mt-1">
            Live health of the myAI platform. Updated {new Date(s.timestamp).toLocaleString()}.
          </p>
        </header>

        <div className={`rounded-xl border px-5 py-4 mb-8 font-medium ${banner.cls}`}>{banner.text}</div>

        <section className="mb-10">
          <h2 className="text-xs uppercase tracking-wide text-white/40 mb-3">Components</h2>
          <div className="rounded-xl border border-white/10 bg-white/[0.02]">
            {Object.entries(s.components).map(([id, c]) => (
              <ComponentRow key={id} id={id} c={c} />
            ))}
          </div>
        </section>

        {s.uptime && (
          <section className="mb-10">
            <h2 className="text-xs uppercase tracking-wide text-white/40 mb-3">Gateway uptime</h2>
            <div className="grid grid-cols-3 gap-3">
              <Uptime label="Last hour" w={s.uptime.windows.hour} />
              <Uptime label="Last 24 hours" w={s.uptime.windows.day} />
              <Uptime label="Last 7 days" w={s.uptime.windows.week} />
            </div>
          </section>
        )}

        <section>
          <h2 className="text-xs uppercase tracking-wide text-white/40 mb-3">Incident history</h2>
          {s.incidents.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] px-5 py-6 text-sm text-white/40">
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

        <footer className="mt-12 text-xs text-white/30">
          Machine-readable feed:{' '}
          <a className="underline hover:text-white/50" href="/api/status">
            /api/status
          </a>
        </footer>
      </div>
    </div>
  );
}
