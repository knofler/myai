// /memory — what the system has learned and done before: SONA analytics +
// gateway sessions / RAG corpus. Merges the old /sona and /sessions pages.

import { TabBar, resolveTab } from '@/components/ui/tabs';
import { PageHeader } from '@/components/page-header';
import AutoRefresh from '@/components/auto-refresh';
import SonaView from '@/views/sona';
import SessionsView from '@/views/sessions';

export const dynamic = 'force-dynamic';

const TABS = [
  { id: 'sona', label: 'SONA' },
  { id: 'sessions', label: 'Sessions & RAG' },
];

const SUBTITLES: Record<string, string> = {
  sona: 'Pattern analytics — confidence, usage, categories.',
  sessions: 'RAG vector corpus inspection, semantic search, and gateway sessions.',
};

export default async function MemoryPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: requested } = await searchParams;
  const tab = resolveTab(TABS, requested);

  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={15} />
      <PageHeader title="Memory" subtitle={SUBTITLES[tab]} />
      <TabBar base="/memory" tabs={TABS} active={tab} />
      <div className="mt-6">
        {tab === 'sona' && <SonaView />}
        {tab === 'sessions' && <SessionsView />}
      </div>
    </div>
  );
}
