import { getSkillsCached } from '@/lib/registry-cache';
import { SkillList } from './skill-list';

export default async function SkillsPage() {
  const serialized = await getSkillsCached();

  return (
    <div>
      <SkillList skills={serialized} />
    </div>
  );
}
