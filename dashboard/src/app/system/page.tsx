// /system — how the system behaves: LLM routing, budget guards, spend
// analytics, provider/API health. Merges the old /routing, /budgets, /costs
// and /api-health pages as tabs.

import { TabBar, resolveTab } from '@/components/ui/tabs';
import { PageHeader } from '@/components/page-header';
import AutoRefresh from '@/components/auto-refresh';
import RoutingView from '@/views/routing';
import RoutingSettingsView from '@/views/routing-settings';
import BudgetsView from '@/views/budgets';
import CostsView from '@/views/costs';
import UsageView from '@/views/usage';
import ApiHealthView from '@/views/api-health';
import RunnerHealthView from '@/views/runner-health';
import McpToolsView from '@/views/mcp-tools';
import GiftCodesView from '@/views/gift-codes';
import FeatureFlagsView from '@/views/feature-flags';
import GuardsView from '@/views/guards';

export const dynamic = 'force-dynamic';

const TABS = [
  { id: 'routing', label: 'Routing' },
  { id: 'policy', label: 'Policy' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'costs', label: 'Costs' },
  { id: 'usage', label: 'Usage' },
  { id: 'api', label: 'API Health' },
  { id: 'runner', label: 'Runner Health' },
  { id: 'mcp-tools', label: 'MCP Tools' },
  { id: 'gift-codes', label: 'Gift Codes' },
  { id: 'flags', label: 'Feature Flags' },
  { id: 'guards', label: 'Guards' },
];

// The one-line answer (DESIGN_LANGUAGE §5.1). This page loads no data of its
// own — every tab is a self-fetching view — so each sentence says what that
// tab is FOR, in the homepage voice, rather than quoting a count that is not
// in scope here. SUBTITLES stays the small dim qualifier underneath.
const SUMMARIES: Record<string, string> = {
  routing: 'How your AI decides which model handles which job, tier by tier and agent by agent.',
  policy: 'Your own routing rules. The model your AI reaches for by default, the overrides per priority, and the monthly cap it will not cross.',
  budgets: 'What your AI is allowed to spend, and whether the guard has had to step in.',
  costs: 'Where the money actually went, broken down by provider, model and day.',
  usage: 'What your AI used, metered as billable units by tool, member and day.',
  api: 'Whether every model provider is answering right now, and what happens when one stops.',
  runner: 'Whether the CLI runner is alive, what it last shipped in each repo, and whether it has stalled with work still waiting.',
  'mcp-tools': 'Which MCP tools each org is allowed to see. Admin only.',
  'gift-codes': 'Mint, list and revoke the subscription codes you hand out. Admin only.',
  flags: 'Turn a platform feature on or off, globally or for one tenant, and kill it instantly if it misbehaves. Admin only.',
  guards: 'Admin auth, the CLI session Usage Guard thresholds, and the autonomous-scheduling consent list — in one read-only place.',
};

const SUBTITLES: Record<string, string> = {
  routing: 'Tier configuration, agent mappings, channel overrides, and routing rules.',
  policy: 'Per-tenant routing control-plane — default model, per-priority overrides, and the monthly budget cap.',
  budgets: 'Spend audit + budget guard status.',
  costs: 'Cost analytics — spend by provider, model, day, and month.',
  usage: 'Product-usage meter — billable units (tasks, off-hours minutes, apps, agents) by tool, member, and day.',
  api: 'LLM provider resilience — circuit breakers, rate limiters, managed repos, schedules.',
  runner: 'CLI task-runner pulse — last fire, last RESULT per repo, queue depth, and the zero-work stall flag.',
  'mcp-tools': "Admin-only — per-org MCP tool visibility override (OPERATOR_ONLY_TOOLS allow/deny exceptions).",
  'gift-codes': 'Admin-only — mint/list/revoke platform-wide gift/redeemable subscription codes.',
  flags: 'Admin-only — platform feature flags: global + per-tenant, percentage rollout, kill-switch.',
  guards: 'Config/toggles with no other UI home: ADMIN_API_TOKEN posture, config/session-limits.json thresholds, config/schedule_ignore.txt + schedule_priority.txt.',
};

export default async function SystemPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: requested } = await searchParams;
  const tab = resolveTab(TABS, requested);

  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={15} />
      <PageHeader
        icon="system"
        title="System"
        summary={SUMMARIES[tab]}
        subtitle={SUBTITLES[tab]}
      />
      <TabBar base="/system" tabs={TABS} active={tab} />
      <div className="mt-6">
        {tab === 'routing' && <RoutingView />}
        {tab === 'policy' && <RoutingSettingsView />}
        {tab === 'budgets' && <BudgetsView />}
        {tab === 'costs' && <CostsView />}
        {tab === 'usage' && <UsageView />}
        {tab === 'api' && <ApiHealthView />}
        {tab === 'runner' && <RunnerHealthView />}
        {tab === 'mcp-tools' && <McpToolsView />}
        {tab === 'gift-codes' && <GiftCodesView />}
        {tab === 'flags' && <FeatureFlagsView />}
        {tab === 'guards' && <GuardsView />}
      </div>
    </div>
  );
}
