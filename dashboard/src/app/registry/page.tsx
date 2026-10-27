// /registry — what the framework can do: agents, skills, hooks, rules and
// learned patterns. Merges five flat list pages into one tabbed catalog.

import { getRegistryCounts } from '@/lib/registry-cache';
import { TabBar, resolveTab } from '@/components/ui/tabs';
import { PageHeader } from '@/components/page-header';
import { plural, joinClauses } from '@/lib/summary';
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

/** The one-line answer (DESIGN_LANGUAGE §5.1) — what your AI is actually made
 *  of, in words, built only from the counts this page already loads. Reads
 *  correctly at zero and when the registry cache falls back to all-zeroes
 *  because Atlas was unreachable. */
function registrySummary(c: { agents: number; skills: number; hooks: number; rules: number; patterns: number }): string {
  const capabilities = joinClauses([
    c.agents > 0 && plural(c.agents, 'specialist agent'),
    c.skills > 0 && plural(c.skills, 'skill'),
    c.hooks > 0 && plural(c.hooks, 'hook'),
    c.rules > 0 && plural(c.rules, 'rule'),
  ]);
  const learned = c.patterns > 0 ? ` It has also learned ${plural(c.patterns, 'pattern')} from past work.` : '';
  if (!capabilities) {
    return c.patterns > 0
      ? `No agents, skills, hooks or rules are registered yet, but your AI has already learned ${plural(c.patterns, 'pattern')} from past work.`
      : 'Nothing is registered yet. A framework sync fills this catalog with the agents, skills, hooks and rules your AI runs on.';
  }
  return `Your AI runs on ${capabilities}.${learned}`;
}

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
      <PageHeader
        icon="registry"
        title="Registry"
        summary={registrySummary(counts)}
        subtitle={SUBTITLES[tab]}
      />
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
