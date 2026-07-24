import { getAgentsCached } from '@/lib/registry-cache';
import { AgentList } from './agent-list';

export default async function AgentsPage() {
  const serialized = await getAgentsCached();
  const categories = [...new Set(serialized.map(a => a.category))].sort();

  return (
    <div>
      <AgentList agents={serialized} categories={categories} />
    </div>
  );
}
