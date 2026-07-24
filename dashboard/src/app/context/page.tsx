// /context — "Your Context" (CONTEXT-PORT 3). View / download / port / upload
// your context + vectors, with a size / tokens / coverage summary. The visible
// home of "your context is yours, portable, importable."

import { PageHeader } from '@/components/page-header';
import AutoRefresh from '@/components/auto-refresh';
import ContextView from '@/views/context';

export const dynamic = 'force-dynamic';

export default function ContextPage() {
  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={60} />
      <PageHeader title="Your Context" subtitle="View, download, and port everything myAI knows for you — no lock-in." />
      <div className="mt-6">
        <ContextView />
      </div>
    </div>
  );
}
