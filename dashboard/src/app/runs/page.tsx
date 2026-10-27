// /runs — searchable runner job-history archive (OBSERVABILITY, task-1873b3be).
// Past overnight/scheduled runner fires, indexed by repo / task / outcome /
// error substring in the tenant-scoped job-history store — queryable here
// instead of grepping ~/.ai-cli-runner/logs on whichever Mac ran the job.
// Reads go through the /api/runs proxy (api/runs/route.ts → gateway
// job_history_search MCP tool).
import { PageHeader } from '@/components/page-header';
import RunsSearch from './runs-search';

export const dynamic = 'force-dynamic';

export default function RunsPage() {
  return (
    <div className="max-w-6xl mx-auto">
      {/* §5.1: the answer first. This shell loads nothing (RunsSearch fetches
          client-side through /api/runs), so the sentence says what the page is
          FOR instead of quoting a count the server does not have. */}
      <PageHeader
        icon="runs"
        title="Run History"
        summary="Every runner fire for your tenant, newest first. Search by repo, task id, outcome, or an error substring across RESULT lines and failure excerpts."
        subtitle="Secrets are redacted before storage. Raw logs stay on the runner host under its rotation policy."
      />
      <div className="mt-6">
        <RunsSearch />
      </div>
    </div>
  );
}
