// /brain — git-versioned agent-memory explorer. Read-only, tenant-scoped:
// browse namespaces, atoms (sessions / handoffs / memory), stashes, and
// code↔memory provenance served by the gateway `brain_explore` tool.

import { TabBar } from '@/components/ui/tabs';
import { PageHeader } from '@/components/page-header';
import AutoRefresh from '@/components/auto-refresh';
import BrainView from '@/views/brain';

export const dynamic = 'force-dynamic';

// Two top-level tabs only: the friendly primary view everyone lands on, and
// one "Advanced" door into the store internals (namespaces, atoms, corpus
// search, stashes, provenance). Deep links from global search / the command
// palette (?tab=atoms, ?tab=stashes, ?tab=provenance) still work — they just
// render inside Advanced, with the top bar correctly showing Advanced active.
const TOP_TABS = [
  { id: 'overview', label: 'Brain' },
  { id: 'advanced', label: 'Advanced' },
];

const ADVANCED_DEEP_LINKS = new Set(['advanced', 'atoms', 'search', 'stashes', 'provenance']);

const SUBTITLES: Record<string, string> = {
  overview: 'Read-only and tenant-scoped · refreshed every 30 seconds.',
  advanced: 'Namespaces, atoms, corpus search, stashes and provenance · read-only.',
};

/** The one-line answer (DESIGN_LANGUAGE §5.1). This shell only picks a tab, and
 *  the atoms themselves are loaded inside BrainView, so the sentence describes
 *  what the tab is for rather than quoting a memory count it cannot see. */
function brainSummary(topActive: string): string {
  if (topActive === 'advanced') {
    return 'The memory store itself, up close. Walk the namespaces, read individual atoms, search the whole corpus, and trace a memory back to the commit that produced it.';
  }
  return 'Everything your AI knows, in one place. Browse what it remembers, when it learned it, and which repo the memory came from.';
}

export default async function BrainPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: requested } = await searchParams;
  const tab = requested && ADVANCED_DEEP_LINKS.has(requested) ? requested : 'overview';
  const topActive = tab === 'overview' ? 'overview' : 'advanced';

  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={30} />
      <PageHeader
        icon="brain"
        title="Brain"
        summary={brainSummary(topActive)}
        subtitle={SUBTITLES[topActive]}
      />
      <TabBar base="/brain" tabs={TOP_TABS} active={topActive} />
      <div className="mt-6">
        <BrainView tab={tab} />
      </div>
    </div>
  );
}
