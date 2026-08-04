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
];

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
};

export default async function SystemPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: requested } = await searchParams;
  const tab = resolveTab(TABS, requested);

  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={15} />
      <PageHeader title="System" subtitle={SUBTITLES[tab]} />
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
      </div>
    </div>
  );
}
