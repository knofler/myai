// /logs — tenant-scoped structured request-log live-tail viewer
// (OBSERVABILITY: correlation ids threaded gateway→runner→agent, secrets
// redacted at write time in monitoring/log-store.ts). Reads go through the
// /api/logs proxy (api/logs/route.ts → gateway logs_list MCP tool).
import { PageHeader } from '@/components/page-header';
import LogsViewer from './logs-viewer';

export const dynamic = 'force-dynamic';

export default function LogsPage() {
  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        title="Logs"
        subtitle="Structured JSON request logs for your tenant — filter by service, level, or correlation id to follow one request's whole gateway→runner→agent story. Secrets are redacted before they ever reach the buffer."
      />
      <div className="mt-6">
        <LogsViewer />
      </div>
    </div>
  );
}
