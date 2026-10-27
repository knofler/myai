// /context — "Your Context" (CONTEXT-PORT 3). View / download / port / upload
// your context + vectors, with a size / tokens / coverage summary. The visible
// home of "your context is yours, portable, importable."

import { PageHeader } from '@/components/page-header';
import AutoRefresh from '@/components/auto-refresh';
import ContextView from '@/views/context';

export const dynamic = 'force-dynamic';

/** The one-line answer (DESIGN_LANGUAGE §5.1). Size, token and coverage figures
 *  are loaded by the client view, so this shell states none of them. */
function contextSummary(): string {
  return 'Everything myAI knows for you, ready to leave with you. Look through it, download the lot, or port it into another install whenever you like.';
}

export default function ContextPage() {
  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={60} />
      <PageHeader
        icon="context"
        title="Your Context"
        summary={contextSummary()}
        subtitle="Context and vectors · yours to take, no lock-in."
      />
      <div className="mt-6">
        <ContextView />
      </div>
    </div>
  );
}
