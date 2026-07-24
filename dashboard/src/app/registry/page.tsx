// /registry — what the framework can do: agents, skills, hooks, rules and
// learned patterns. Merges five flat list pages into one tabbed catalog.

import { getRegistryCounts } from '@/lib/registry-cache';
import { TabBar, resolveTab } from '@/components/ui/tabs';
import { PageHeader } from '@/components/page-header';
import AgentsView from '@/views/agents';
import SkillsView from '@/views/skills';
import HooksView from '@/views/hooks';
import RulesView from '@/views/rules';
import PatternsView from '@/views/patterns';

export const dynamic = 'force-dynamic';

const SUBTITLES: Record<string, string> = {
  agents: 'Specialist agents auto-discovered from .claude/agents/.',
  skills: 'Repeatable playbooks with trigger keywords.',
  hooks: 'Event hooks (builtin + bash).',
  rules: 'Governance & routing documents.',
  patterns: 'SONA learned patterns with confidence scores.',
};

export default async function RegistryPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: requested } = await searchParams;

  // Cached (60s) — registry content only changes on framework syncs; the
  // counts + view data must not cost an Atlas round-trip per navigation.
  const counts = await getRegistryCounts();

  const tabs = [
    { id: 'agents', label: 'Agents', count: counts.agents },
    { id: 'skills', label: 'Skills', count: counts.skills },
    { id: 'hooks', label: 'Hooks', count: counts.hooks },
    { id: 'rules', label: 'Rules', count: counts.rules },
    { id: 'patterns', label: 'Patterns', count: counts.patterns },
  ];
  const tab = resolveTab(tabs, requested);

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader title="Registry" subtitle={SUBTITLES[tab]} />
      {/* prefetch: sibling tab payloads load in the background (server side is
          already cached), so a tab tap is an instant client-side swap. */}
      <TabBar base="/registry" tabs={tabs} active={tab} prefetch />
      <div className="mt-6">
        {tab === 'agents' && <AgentsView />}
        {tab === 'skills' && <SkillsView />}
        {tab === 'hooks' && <HooksView />}
        {tab === 'rules' && <RulesView />}
        {tab === 'patterns' && <PatternsView />}
      </div>
    </div>
  );
}
