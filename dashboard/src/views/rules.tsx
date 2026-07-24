import { getRulesCached } from '@/lib/registry-cache';
import { RuleViewer } from './rule-viewer';

export default async function RulesPage() {
  const serialized = await getRulesCached();

  return (
    <div>
      <RuleViewer rules={serialized} />
    </div>
  );
}
