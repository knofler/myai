'use client';

// SwarmWorkersPanel — the /swarm "Workers" tab (task-496862ee). Per execution
// lane (the worker Claude profile, Claude Fable, the director-only master profile,
// Codex, Antigravity, Copilot, local Ollama, DeepSeek/Kimi API):
// connected | down | not-configured, which host last checked in and when, and
// how many executions it closed out in the last 24h/30d. Polls /api/swarm/workers
// the same stale-while-revalidate way the Live tab polls /api/swarm.
//
// Card-per-lane layout (not a table) so it reflows cleanly at 375px without a
// horizontal-scroll table — same "below md" discipline as the rest of /swarm.

import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TONE, type Tone } from '@/components/ui/tone';
import { cn } from '@/lib/utils';
import { useIdbCachedFetch } from '@/lib/use-idb-cached-fetch';

const POLL_MS = 15_000;

interface WorkerLaneRow {
  id: string;
  label: string;
  directorOnly: boolean;
  status: 'connected' | 'down' | 'not-configured';
  host: string | null;
  lastCheckAt: string | null;
  executions24h: number;
  executions30d: number;
}

interface WorkerLaneResponse {
  generatedAt: string;
  thresholdMinutes: number;
  lanes: WorkerLaneRow[];
  gatewayOk: boolean;
  envMissing?: boolean;
  error?: string;
}

const STATUS_TONE: Record<WorkerLaneRow['status'], Tone> = {
  connected: 'ok',
  down: 'err',
  'not-configured': 'muted',
};

const STATUS_LABEL: Record<WorkerLaneRow['status'], string> = {
  connected: 'Connected',
  down: 'Down',
  'not-configured': 'Not configured',
};

function StatusChip({ status }: { status: WorkerLaneRow['status'] }) {
  const tone = STATUS_TONE[status];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONE[tone].box, TONE[tone].glyph)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', tone === 'ok' ? 'bg-[rgb(var(--ok))]' : tone === 'err' ? 'bg-[rgb(var(--err))]' : 'bg-[rgb(var(--text-muted))]')} />
      {STATUS_LABEL[status]}
    </span>
  );
}

function age(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function LaneCard({ lane }: { lane: WorkerLaneRow }) {
  return (
    <div className="rounded-lg border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))]/60 p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[rgb(var(--text-primary))] truncate">{lane.label}</p>
          {lane.directorOnly && <p className="text-xs text-[rgb(var(--text-muted))]">Director-only — interactive sessions, not runner-queue work</p>}
        </div>
        <StatusChip status={lane.status} />
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-[rgb(var(--text-muted))]">Host</dt>
        <dd className="text-[rgb(var(--text-secondary))] text-right truncate">{lane.host ?? '—'}</dd>
        <dt className="text-[rgb(var(--text-muted))]">Last check</dt>
        <dd className="text-[rgb(var(--text-secondary))] text-right">{age(lane.lastCheckAt)}</dd>
        <dt className="text-[rgb(var(--text-muted))]">Executions (24h)</dt>
        <dd className="text-[rgb(var(--text-secondary))] text-right font-mono">{lane.executions24h}</dd>
        <dt className="text-[rgb(var(--text-muted))]">Executions (30d)</dt>
        <dd className="text-[rgb(var(--text-secondary))] text-right font-mono">{lane.executions30d}</dd>
      </dl>
    </div>
  );
}

function GatewayUnavailable({ envMissing, error }: { envMissing?: boolean; error?: string }) {
  return (
    <Card title="Workers unavailable" accent="red">
      <div className="p-6 text-sm text-[rgb(var(--text-secondary))] space-y-3">
        <p>Gateway: {error ?? 'fetch failed'}</p>
        {envMissing ? (
          <p className="text-xs text-[rgb(var(--text-muted))]">
            No <code className="text-[rgb(var(--text-secondary))]">GATEWAY_MCP_URL</code> (or{' '}
            <code className="text-[rgb(var(--text-secondary))]">MONGODB_URI</code>) is configured on this deployment,
            so both the gateway and its Atlas fallback are still pointed at the Docker-internal defaults — neither
            resolves outside a local <code className="text-[rgb(var(--text-secondary))]">docker compose</code> network.
            Point <code className="text-[rgb(var(--text-secondary))]">GATEWAY_MCP_URL</code> at a reachable gateway
            (a tunnel or Tailscale address — the operator&apos;s call which) to bring this panel back, or set{' '}
            <code className="text-[rgb(var(--text-secondary))]">MONGODB_URI</code> to read lane status straight from Atlas.
          </p>
        ) : (
          <p className="text-xs text-[rgb(var(--text-muted))]">
            Neither the gateway nor its Atlas fallback answered. If this persists, check the gateway is running and
            reachable, or that Atlas (<code className="text-[rgb(var(--text-secondary))]">MONGODB_URI</code>) is up.
          </p>
        )}
      </div>
    </Card>
  );
}

export function SwarmWorkersPanel() {
  const { data, fetchedAt, offline } = useIdbCachedFetch<WorkerLaneResponse>('swarm-workers', '/api/swarm/workers', { pollMs: POLL_MS });

  const lanes = data?.lanes ?? [];
  const gatewayDown = data ? !data.gatewayOk : false;

  if (gatewayDown) {
    return <GatewayUnavailable envMissing={data?.envMissing} error={data?.error} />;
  }

  return (
    <Card
      title="Workers"
      meta={fetchedAt ? `${offline ? 'showing cached data · offline' : 'updated'} ${age(fetchedAt)}` : undefined}
    >
      {!data ? (
        <div className="p-6 text-sm text-[rgb(var(--text-muted))]">Loading…</div>
      ) : lanes.length === 0 ? (
        <EmptyState title="No lanes reported" description="No runner heartbeat has advertised any execution lane yet." />
      ) : (
        <div className="p-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {lanes.map((lane) => (
            <LaneCard key={lane.id} lane={lane} />
          ))}
        </div>
      )}
    </Card>
  );
}
