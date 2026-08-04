import { getHooksCached } from '@/lib/registry-cache';
import { HookList } from '@/views/hook-list';

export default async function HooksPage() {
  const hooks = await getHooksCached();
  return <HookList hooks={hooks} />;
}
