// /swarm — the Swarm section's landing page. Five tabs (URL-driven, ?tab=):
//   live    — the Control Room (SwarmControlRoom, dashboard redesign phase 2):
//             coordinator, every lane's state, Needs you, mail, today's
//             activity — the gateway's swarm_live aggregate.
//   plans   — planned swarms (SwarmOpsConsole): swarm_plan records with their
//             children; approve / stop / ack. Was the default view.
//   workers — connected/down/not-configured per execution lane (Claude
//             worker/runner Claude profiles, Codex, Antigravity, Copilot, Ollama,
//             DeepSeek/Kimi API) + 24h/30d executions (SwarmWorkersPanel).
//   demo    — how a swarm works: the topology lanes demo (SwarmDemoLanes).
//   videos  — short recordings of the real console (SwarmVideos).
// The page is a static shell; each tab's component owns its fetching.

import { PageHeader } from '@/components/page-header';
import { TabBar, type TabDef } from '@/components/ui/tabs';
import { SwarmOpsConsole } from '@/components/swarm-ops-console';
import { SwarmControlRoom } from '@/components/swarm/control-room';
import { SwarmWorkersPanel } from '@/components/swarm-workers-panel';
import { SwarmDemoLanes } from '@/components/swarm-demo-lanes';
import { SwarmVideos } from '@/components/swarm-videos';

export const metadata = {
  title: 'Swarm · myAI',
  description: 'Run the swarm: who is coordinating, what every lane is doing, what is waiting on you, and the mail between lanes — plus planned swarms, worker health, a demo and videos.',
};

const TABS: TabDef[] = [
  { id: 'live', label: 'Live' },
  { id: 'plans', label: 'Plans' },
  { id: 'workers', label: 'Workers' },
  { id: 'demo', label: 'How it works' },
  { id: 'videos', label: 'Videos' },
];

export default async function SwarmPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: raw } = await searchParams;
  const tab = TABS.some((t) => t.id === raw) ? (raw as string) : 'live';
  return (
    <div className="max-w-7xl mx-auto">
      {/* §5.1: the answer first. */}
      <PageHeader
        icon="swarm"
        title="Swarm"
        summary="Your lanes, who is coordinating them, and what they’re waiting on you for."
      />
      <TabBar base="/swarm" tabs={TABS} active={tab} />
      <div className="mt-6">
        {tab === 'live' && <SwarmControlRoom />}
        {tab === 'plans' && <SwarmOpsConsole />}
        {tab === 'workers' && <SwarmWorkersPanel />}
        {tab === 'demo' && <SwarmDemoLanes />}
        {tab === 'videos' && <SwarmVideos />}
      </div>
    </div>
  );
}
