// /swarm — Swarm console. Exposes the swarm-coordinator's 4 topologies
// (hierarchical / mesh / ring / star) as a picker when dispatching a
// multi-agent task, with a live lane/progress view. Surfaces existing
// coordination machinery (AI/documentation/SWARM_COORDINATION.md) as a
// product feature. All interaction is client-side (SwarmConsole); the page
// itself is a static shell.

import { PageHeader } from '@/components/page-header';
import { SwarmConsole } from '@/components/swarm-console';

export const metadata = {
  title: 'Swarm · myAI',
  description: 'Pick a topology and watch the swarm dispatch a multi-agent task across lanes.',
};

export default function SwarmPage() {
  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader
        title="Swarm"
        subtitle="Pick a topology, dispatch a multi-agent task, and watch the lanes work in real time."
      />
      <SwarmConsole />
    </div>
  );
}
