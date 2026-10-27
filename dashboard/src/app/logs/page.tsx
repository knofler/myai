// /logs — tenant-scoped structured request-log live-tail viewer
// (OBSERVABILITY: correlation ids threaded gateway→runner→agent, secrets
// redacted at write time in monitoring/log-store.ts). Reads go through the
// /api/logs proxy (api/logs/route.ts → gateway logs_list MCP tool).
import { PageHeader } from '@/components/page-header';
import LogsViewer from './logs-viewer';

export const dynamic = 'force-dynamic';

/** The one-line answer (DESIGN_LANGUAGE §5.1). The tail is streamed by the
 *  client viewer, so this shell never claims a line count. */
function logsSummary(): string {
  return 'Every request your gateway has served, newest first and live. Follow one correlation id to watch a single request travel from gateway to runner to agent.';
}

export default function LogsPage() {
  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        icon="logs"
        title="Logs"
        summary={logsSummary()}
        subtitle="Structured JSON · filter by service, level or correlation id · secrets redacted before they are written."
      />
      <div className="mt-6">
        <LogsViewer />
      </div>
    </div>
  );
}
