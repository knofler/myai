import { StatCard } from '@/components/ui/card';
import { CircuitBadge, OnDot, RunStatusBadge } from '@/components/ui/badge';
export const dynamic = 'force-dynamic';

// API Health — LLM provider resilience dashboard.
//
// Four sections:
//   1. Gateway status card: uptime, Node version, MongoDB, MCP tools, memory
//   2. Provider resilience table: circuit breaker + rate limiter per provider
//   3. Managed repos table: name, path, AI folder, state file, stack
//   4. Active schedules: name, cron, kind, last run, status

// In Docker the gateway is reachable via its compose service name, not localhost
const GATEWAY_URL = process.env.GATEWAY_MCP_URL ?? 'http://gateway:3100/mcp';

interface GatewayHealth {
  uptime: string;
  nodeVersion: string;
  mongoConnected: boolean;
  totalMcpTools: number;
  memory: { heapUsedMB: number; rssMB: number };
}

interface ProviderResilience {
  provider: string;
  circuit: {
    state: 'closed' | 'open' | 'half-open';
    failureCount: number;
    successCount: number;
    lastFailure?: string;
  };
  rateLimiter: {
    available: number;
    max: number;
    totalAcquired: number;
    totalRejected: number;
  };
}

interface ManagedRepo {
  name: string;
  path: string;
  hasAiFolder: boolean;
  hasStateFile: boolean;
  stack: string;
}

interface ActiveSchedule {
  name: string;
  cron: string;
  kind: string;
  lastRun: string | null;
  status: string;
}

interface HealthStatusResult {
  gateway: GatewayHealth;
  providers: ProviderResilience[];
  managedRepos: ManagedRepo[];
  schedules: ActiveSchedule[];
}

async function callGateway<T>(toolName: string, args: Record<string, unknown> = {}): Promise<T | null> {
  try {
    // ADR-010: bridge token for non-loopback gateway calls under enforce=true.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.GATEWAY_LOCAL_TOKEN) headers['x-gateway-local-token'] = process.env.GATEWAY_LOCAL_TOKEN;
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: toolName, arguments: args },
        id: 1,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;

    const json = await res.json();

    // MCP tools/call returns { result: { content: [{ type: 'text', text: '...' }] } }
    const content = json?.result?.content;
    if (!content || !Array.isArray(content) || content.length === 0) return null;

    const textEntry = content.find((c: { type: string }) => c.type === 'text');
    if (!textEntry) return null;

    return JSON.parse(textEntry.text) as T;
  } catch {
    return null;
  }
}

// health_status alone doesn't carry providers/repos/schedules arrays — those
// live on dedicated tools. Fetch all four and adapt to the page's shapes.
async function fetchHealthStatus(): Promise<HealthStatusResult | null> {
  const [health, providerHealth, reposList, schedulesList] = await Promise.all([
    callGateway<{
      gateway?: { uptimeSeconds?: number; nodeVersion?: string; toolCount?: number };
      mongodb?: { connected?: boolean };
      memory?: { heapUsedMB?: number; rssMB?: number };
    }>('health_status'),
    callGateway<{ providers?: ProviderResilience[] }>('provider_health'),
    callGateway<{ repos?: Array<{ name: string; path: string; hasAiFolder?: boolean; hasStateFile?: boolean; stack?: string }> }>('repos_list'),
    callGateway<{ schedules?: Array<{ name: string; cronExpr?: string; kind: string; lastRun?: string | null; lastStatus?: string }> }>('schedules_list', { enabled: true }),
  ]);

  if (!health) return null;

  return {
    gateway: {
      uptime: String(health.gateway?.uptimeSeconds ?? ''),
      nodeVersion: health.gateway?.nodeVersion ?? '—',
      mongoConnected: health.mongodb?.connected ?? false,
      totalMcpTools: health.gateway?.toolCount ?? 0,
      memory: {
        heapUsedMB: health.memory?.heapUsedMB ?? 0,
        rssMB: health.memory?.rssMB ?? 0,
      },
    },
    providers: providerHealth?.providers ?? [],
    managedRepos: (reposList?.repos ?? []).map((r) => ({
      name: r.name,
      path: r.path,
      hasAiFolder: r.hasAiFolder ?? false,
      hasStateFile: r.hasStateFile ?? false,
      stack: r.stack ?? '—',
    })),
    schedules: (schedulesList?.schedules ?? []).map((s) => ({
      name: s.name,
      cron: s.cronExpr ?? '—',
      kind: s.kind,
      lastRun: s.lastRun ?? null,
      status: s.lastStatus ?? 'never',
    })),
  };
}

function fmtUptime(uptime: string): string {
  // Gateway may return seconds as a number string or a formatted string
  const secs = Number(uptime);
  if (isNaN(secs)) return uptime;
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default async function ApiHealthPage() {
  const data = await fetchHealthStatus();

  if (!data) {
    return (
      <div>
        <div className="bg-red-950/30 border border-red-800/50 rounded-lg p-8 text-center">
          <div className="text-3xl mb-3">!</div>
          <h2 className="text-lg font-semibold text-red-400 mb-2">Gateway Unreachable</h2>
          <p className="text-sm text-zinc-400">
            Could not connect to the AI gateway at <code className="text-zinc-300">{GATEWAY_URL}</code>.
          </p>
          <p className="text-xs text-zinc-500 mt-2">
            Ensure the gateway is running: <code className="text-zinc-400">docker compose up -d</code>
          </p>
        </div>
      </div>
    );
  }

  const { gateway, providers, managedRepos, schedules } = data;

  return (
    <div>
      {/* Header */}

      {/* ── 1. Gateway Status Card ─────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <StatCard
          label="Uptime"
          value={fmtUptime(gateway.uptime)}
          sub={`Node ${gateway.nodeVersion}`}
          accent="green"
        />
        <StatCard
          label="MongoDB"
          value={gateway.mongoConnected ? 'Connected' : 'Disconnected'}
          sub={gateway.mongoConnected ? 'Healthy' : 'Check connection'}
          accent={gateway.mongoConnected ? 'green' : 'red'}
        />
        <StatCard
          label="MCP Tools"
          value={String(gateway.totalMcpTools)}
          sub="Registered tools"
          accent="blue"
        />
        <StatCard
          label="Heap Used"
          value={`${gateway.memory.heapUsedMB.toFixed(0)} MB`}
          sub="V8 heap memory"
          accent="gray"
        />
        <StatCard
          label="RSS"
          value={`${gateway.memory.rssMB.toFixed(0)} MB`}
          sub="Resident set size"
          accent="gray"
        />
      </div>

      {/* ── 2. Provider Resilience Table ───────────────────────── */}
      <div className="mb-8 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Provider Resilience</h2>
          <span className="text-xs text-zinc-500">{providers.length} provider(s)</span>
        </div>
        {providers.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">
            No LLM providers registered. Configure providers in the gateway to populate.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="card-table w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Provider</th>
                  <th className="px-4 py-3">Circuit State</th>
                  <th className="px-4 py-3 text-right">Failures</th>
                  <th className="px-4 py-3 text-right">Successes</th>
                  <th className="px-4 py-3 text-right">Rate Avail / Max</th>
                  <th className="px-4 py-3 text-right">Acquired</th>
                  <th className="px-4 py-3 text-right">Rejected</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {providers.map((p) => (
                  <tr key={p.provider} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="m-title px-4 py-2.5 text-zinc-200 font-medium">{p.provider}</td>
                    <td data-label="Circuit" className="px-4 py-2.5">
                      <CircuitBadge state={p.circuit.state} />
                    </td>
                    <td data-label="Failures" className="px-4 py-2.5 text-right font-mono text-zinc-400">
                      {p.circuit.failureCount}
                    </td>
                    <td data-label="Successes" className="px-4 py-2.5 text-right font-mono text-zinc-400">
                      {p.circuit.successCount}
                    </td>
                    <td data-label="Rate avail / max" className="px-4 py-2.5 text-right font-mono text-zinc-400">
                      <span className="text-zinc-200">{p.rateLimiter.available}</span>
                      <span className="text-zinc-600"> / </span>
                      <span className="text-zinc-500">{p.rateLimiter.max}</span>
                    </td>
                    <td data-label="Acquired" className="px-4 py-2.5 text-right font-mono text-zinc-400">
                      {p.rateLimiter.totalAcquired}
                    </td>
                    <td data-label="Rejected" className="px-4 py-2.5 text-right font-mono">
                      <span className={p.rateLimiter.totalRejected > 0 ? 'text-red-400' : 'text-zinc-500'}>
                        {p.rateLimiter.totalRejected}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 3. Managed Repos Table ─────────────────────────────── */}
      <div className="mb-8 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Managed Repos</h2>
          <span className="text-xs text-zinc-500">{managedRepos.length} repo(s)</span>
        </div>
        {managedRepos.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">
            No managed repos found. Add repos with <code className="text-zinc-400">add repo [path]</code>.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="card-table w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Path</th>
                  <th className="px-4 py-3 text-center">AI Folder</th>
                  <th className="px-4 py-3 text-center">State File</th>
                  <th className="px-4 py-3">Stack</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {managedRepos.map((repo) => (
                  <tr key={repo.path} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="m-title px-4 py-2.5 text-zinc-200 font-medium">{repo.name}</td>
                    <td data-label="Path" className="px-4 py-2.5 text-xs font-mono text-zinc-500 max-w-[280px] truncate">
                      {repo.path}
                    </td>
                    <td data-label="AI folder" className="px-4 py-2.5 text-center">
                      <OnDot on={repo.hasAiFolder} />
                    </td>
                    <td data-label="State file" className="px-4 py-2.5 text-center">
                      <OnDot on={repo.hasStateFile} />
                    </td>
                    <td data-label="Stack" className="px-4 py-2.5 text-xs text-zinc-400">
                      {repo.stack || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 4. Active Schedules ────────────────────────────────── */}
      <div className="mb-8 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Active Schedules</h2>
          <span className="text-xs text-zinc-500">{schedules.length} schedule(s)</span>
        </div>
        {schedules.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">
            No active schedules. Configure cron jobs in the gateway to populate.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="card-table w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Cron</th>
                  <th className="px-4 py-3">Kind</th>
                  <th className="px-4 py-3">Last Run</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {schedules.map((s) => (
                  <tr key={s.name} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="m-title px-4 py-2.5 text-zinc-200 font-medium">{s.name}</td>
                    <td data-label="Cron" className="px-4 py-2.5 font-mono text-xs text-zinc-400">{s.cron}</td>
                    <td data-label="Kind" className="px-4 py-2.5 text-xs text-zinc-400">{s.kind}</td>
                    <td data-label="Last run" className="px-4 py-2.5 text-xs text-zinc-500">
                      {s.lastRun ? new Date(s.lastRun).toLocaleString() : '—'}
                    </td>
                    <td data-label="Status" className="px-4 py-2.5">
                      <RunStatusBadge status={s.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}

