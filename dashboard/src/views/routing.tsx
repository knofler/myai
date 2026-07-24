export const dynamic = 'force-dynamic';

// LLM Routing Configuration — displays tier config, agent mappings, channel overrides,
// tool routing, and complexity threshold from the gateway routing_config MCP tool.
//
// Five sections:
//   1. Tier Configuration — provider, model, chain, cacheable, batchable per tier
//   2. Agent → Tier Mapping — each agent with its assigned tier (premium/ultra highlighted)
//   3. Channel Overrides — channel-to-tier mappings and any per-channel overrides
//   4. Tool Routing — tool-specific routing rules (e.g. morning_sweep)
//   5. Complexity Threshold — the threshold value used by the router

const GATEWAY_URL = process.env.GATEWAY_MCP_URL ?? 'http://gateway:3100/mcp';

/* ── Types ──────────────────────────────────────────────────── */

interface TierConfig {
  provider: string;
  model: string;
  chain?: string[];
  cacheable?: boolean;
  batchable?: boolean;
}

interface ChannelOverride {
  tier?: string;
  forceCache?: boolean;
  forceBatch?: boolean;
  [key: string]: unknown;
}

interface ToolRoute {
  tier?: string;
  [key: string]: unknown;
}

// Keys match the gateway's `routing_config` MCP tool exactly:
// { tiers, agentMap, channelMap, channelOverrides, toolMap, complexityThreshold }
interface RoutingConfig {
  tiers: Record<string, TierConfig>;
  agentMap: Record<string, string>;
  channelMap?: Record<string, string>;
  channelOverrides?: Record<string, ChannelOverride>;
  toolMap?: Record<string, ToolRoute>;
  complexityThreshold?: number;
}

/* ── Gateway fetch helper ───────────────────────────────────── */

async function fetchRoutingConfig(): Promise<RoutingConfig | null> {
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
        params: { name: 'routing_config', arguments: {} },
        id: 1,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;

    const json = await res.json();
    const content = json?.result?.content;
    if (!content || !Array.isArray(content) || content.length === 0) return null;

    const textEntry = content.find((c: { type: string }) => c.type === 'text');
    if (!textEntry) return null;

    return JSON.parse(textEntry.text) as RoutingConfig;
  } catch {
    return null;
  }
}

/* ── Helper components ──────────────────────────────────────── */

function TierBadge({ tier }: { tier: string }) {
  const normalized = tier.toLowerCase();
  let style = 'bg-zinc-700/50 text-zinc-400 border-zinc-600';
  if (normalized === 'ultra') style = 'bg-purple-500/20 text-purple-300 border-purple-500/40';
  else if (normalized === 'premium') style = 'bg-blue-500/20 text-blue-300 border-blue-500/40';
  else if (normalized === 'standard') style = 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
  else if (normalized === 'budget') style = 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${style}`}>
      {tier}
    </span>
  );
}

function BoolChip({ value, label }: { value: boolean | undefined; label: string }) {
  if (value === undefined) return <span className="text-zinc-600 text-xs">—</span>;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${value ? 'text-emerald-400' : 'text-zinc-500'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${value ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
      {label}
    </span>
  );
}

/* ── Page ────────────────────────────────────────────────────── */

export default async function RoutingPage() {
  const data = await fetchRoutingConfig();

  if (!data) {
    return (
      <div>
        <div className="bg-red-950/30 border border-red-800/50 rounded-lg p-8 text-center">
          <div className="text-3xl mb-3">!</div>
          <h2 className="text-lg font-semibold text-red-400 mb-2">Gateway Unreachable</h2>
          <p className="text-sm text-zinc-400">
            Could not connect to the AI gateway at{' '}
            <code className="text-zinc-300">{GATEWAY_URL}</code>.
          </p>
          <p className="text-xs text-zinc-500 mt-2">
            Ensure the gateway is running:{' '}
            <code className="text-zinc-400">docker compose up -d</code>
          </p>
        </div>
      </div>
    );
  }

  // Alias the gateway keys to the local names the rest of this component uses.
  const {
    tiers = {},
    agentMap: agentTiers = {},
    channelMap: channelDefaults = {},
    channelOverrides = {},
    toolMap: toolRouting = {},
    complexityThreshold,
  } = data;

  const tierOrder = ['budget', 'standard', 'premium', 'ultra'];
  const sortedTiers = Object.entries(tiers).sort(([a], [b]) => {
    const ai = tierOrder.indexOf(a.toLowerCase());
    const bi = tierOrder.indexOf(b.toLowerCase());
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const agentEntries = Object.entries(agentTiers).sort(([, a], [, b]) => {
    const ai = tierOrder.indexOf(a.toLowerCase());
    const bi = tierOrder.indexOf(b.toLowerCase());
    return (bi === -1 ? -1 : bi) - (ai === -1 ? -1 : ai); // higher tiers first
  });

  const channelEntries = [
    ...Object.entries(channelDefaults).map(([ch, tier]) => ({
      channel: ch,
      tier,
      override: channelOverrides[ch],
    })),
    // Also include channels only in overrides
    ...Object.entries(channelOverrides)
      .filter(([ch]) => !(ch in channelDefaults))
      .map(([ch, override]) => ({
        channel: ch,
        tier: override.tier ?? '—',
        override,
      })),
  ];

  const toolEntries = Object.entries(toolRouting);

  return (
    <div className="max-w-7xl mx-auto space-y-8">

      {/* ── 1. Tier Configuration ─────────────────────────────── */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-zinc-300">Tier Configuration</h2>
          <span className="text-xs text-zinc-500">{sortedTiers.length} tier(s)</span>
        </div>
        {sortedTiers.length === 0 ? (
          <div className="p-8 text-center text-zinc-600">
            No tiers configured. Check gateway routing config.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="card-table w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800 uppercase tracking-wider">
                  <th className="px-4 py-2">Tier</th>
                  <th className="px-4 py-2">Provider</th>
                  <th className="px-4 py-2">Model</th>
                  <th className="px-4 py-2">Chain</th>
                  <th className="px-4 py-2">Cacheable</th>
                  <th className="px-4 py-2">Batchable</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {sortedTiers.map(([tierName, cfg]) => (
                  <tr key={tierName} className="hover:bg-zinc-800/30">
                    <td className="m-title px-4 py-2.5">
                      <TierBadge tier={tierName} />
                    </td>
                    <td data-label="Provider" className="px-4 py-2.5 text-zinc-300 font-medium">{cfg.provider || '—'}</td>
                    <td data-label="Model" className="px-4 py-2.5 text-zinc-400 font-mono text-xs">{cfg.model || '—'}</td>
                    <td data-label="Chain" className="px-4 py-2.5 text-zinc-500 text-xs">{cfg.chain?.length ? cfg.chain.join(' → ') : '—'}</td>
                    <td data-label="Cacheable" className="px-4 py-2.5">
                      <BoolChip value={cfg.cacheable} label={cfg.cacheable ? 'Yes' : 'No'} />
                    </td>
                    <td data-label="Batchable" className="px-4 py-2.5">
                      <BoolChip value={cfg.batchable} label={cfg.batchable ? 'Yes' : 'No'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 2. Agent → Tier Mapping ──────────────────────────── */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-zinc-300">Agent → Tier Mapping</h2>
          <span className="text-xs text-zinc-500">{agentEntries.length} agent(s)</span>
        </div>
        {agentEntries.length === 0 ? (
          <div className="p-8 text-center text-zinc-600">
            No agent tier mappings found. Configure agent tiers in the gateway routing config.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="card-table w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800 uppercase tracking-wider">
                  <th className="px-4 py-2">Agent</th>
                  <th className="px-4 py-2">Tier</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {agentEntries.map(([agent, tier]) => (
                  <tr key={agent} className="hover:bg-zinc-800/30">
                    <td className="m-title px-4 py-2.5 text-zinc-300 font-mono text-xs">{agent}</td>
                    <td data-label="Tier" className="px-4 py-2.5">
                      <TierBadge tier={tier} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 3. Channel Overrides ─────────────────────────────── */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-zinc-300">Channel Overrides</h2>
          <span className="text-xs text-zinc-500">{channelEntries.length} channel(s)</span>
        </div>
        {channelEntries.length === 0 ? (
          <div className="p-8 text-center text-zinc-600">
            No channel overrides configured.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="card-table w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800 uppercase tracking-wider">
                  <th className="px-4 py-2">Channel</th>
                  <th className="px-4 py-2">Tier</th>
                  <th className="px-4 py-2">Force Cache</th>
                  <th className="px-4 py-2">Force Batch</th>
                  <th className="px-4 py-2">Extra Overrides</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {channelEntries.map(({ channel, tier, override }) => {
                  const extra = override
                    ? Object.entries(override)
                        .filter(([k]) => !['tier', 'forceCache', 'forceBatch'].includes(k))
                        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                        .join(', ')
                    : '';
                  return (
                    <tr key={channel} className="hover:bg-zinc-800/30">
                      <td className="m-title px-4 py-2.5 text-zinc-300 font-mono text-xs">{channel}</td>
                      <td data-label="Tier" className="px-4 py-2.5">
                        {tier && tier !== '—' ? <TierBadge tier={tier} /> : <span className="text-zinc-600 text-xs">—</span>}
                      </td>
                      <td data-label="Force cache" className="px-4 py-2.5">
                        <BoolChip value={override?.forceCache} label={override?.forceCache ? 'Yes' : 'No'} />
                      </td>
                      <td data-label="Force batch" className="px-4 py-2.5">
                        <BoolChip value={override?.forceBatch} label={override?.forceBatch ? 'Yes' : 'No'} />
                      </td>
                      <td data-label="Extra overrides" className="px-4 py-2.5 text-zinc-500 text-xs font-mono truncate max-w-[240px]">
                        {extra || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 4. Tool Routing ──────────────────────────────────── */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-zinc-300">Tool Routing</h2>
          <span className="text-xs text-zinc-500">{toolEntries.length} tool rule(s)</span>
        </div>
        {toolEntries.length === 0 ? (
          <div className="p-8 text-center text-zinc-600">
            No tool-specific routing rules configured.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="card-table w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800 uppercase tracking-wider">
                  <th className="px-4 py-2">Tool</th>
                  <th className="px-4 py-2">Tier</th>
                  <th className="px-4 py-2">Additional Config</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {toolEntries.map(([toolName, route]) => {
                  const extra = Object.entries(route)
                    .filter(([k]) => k !== 'tier')
                    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                    .join(', ');
                  return (
                    <tr key={toolName} className="hover:bg-zinc-800/30">
                      <td className="m-title px-4 py-2.5 text-zinc-300 font-mono text-xs">{toolName}</td>
                      <td data-label="Tier" className="px-4 py-2.5">
                        {route.tier ? <TierBadge tier={route.tier} /> : <span className="text-zinc-600 text-xs">—</span>}
                      </td>
                      <td data-label="Additional config" className="px-4 py-2.5 text-zinc-500 text-xs font-mono truncate max-w-[360px]">
                        {extra || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 5. Complexity Threshold ──────────────────────────── */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-zinc-300 mb-3">Complexity Threshold</h2>
        {complexityThreshold != null ? (
          <div className="flex items-center gap-4">
            <div className="text-3xl font-bold text-emerald-400 font-mono">
              {complexityThreshold}
            </div>
            <div>
              <p className="text-xs text-zinc-400">
                Requests with complexity score above this value are automatically routed to the next tier.
              </p>
              <p className="text-xs text-zinc-600 mt-1">
                Range: 0 (always escalate) – 1 (never escalate). Typical: 0.6–0.8
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-600">Complexity threshold not set in routing config.</p>
        )}
      </div>

    </div>
  );
}
