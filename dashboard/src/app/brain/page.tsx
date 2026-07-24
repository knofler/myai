// /brain — git-versioned agent-memory explorer. Read-only, tenant-scoped:
// browse namespaces, atoms (sessions / handoffs / memory), stashes, and
// code↔memory provenance served by the gateway `brain_explore` tool.

import { TabBar, resolveTab } from '@/components/ui/tabs';
import { PageHeader } from '@/components/page-header';
import AutoRefresh from '@/components/auto-refresh';
import BrainView from '@/views/brain';

export const dynamic = 'force-dynamic';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'atoms', label: 'Atoms' },
  { id: 'search', label: 'Search' },
  { id: 'stashes', label: 'Stashes' },
  { id: 'provenance', label: 'Provenance' },
];

const SUBTITLES: Record<string, string> = {
  overview: 'Namespaces, branches, and recent commits — the shape of the brain.',
  atoms: 'Session, handoff, and cross-repo memory atoms — newest first.',
  search: 'One ranked query across every repo-brain — atoms and the session corpus together.',
  stashes: 'Frozen context payloads waiting on main for any later session to pop.',
  provenance: 'Code ↔ memory links recorded on HEAD — what thinking produced which code.',
};

export default async function BrainPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: requested } = await searchParams;
  const tab = resolveTab(TABS, requested);

  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={30} />
      <PageHeader title="Brain" subtitle={SUBTITLES[tab]} />
      <TabBar base="/brain" tabs={TABS} active={tab} />
      <div className="mt-6">
        <BrainView tab={tab} />
      </div>
    </div>
  );
}
