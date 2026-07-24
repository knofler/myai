// /connectors — per-tenant MCP connector manager (betaC bundled connector set).
// Lists the curated default bundle (auto-seeded on first read) plus any custom
// connectors, with per-tenant enable/disable toggles, so a fresh betaC install
// has working connectors day one. Reads + writes go through /api/connectors.

import { PageHeader } from '@/components/page-header';
import ConnectorManager from './connector-manager';

export const dynamic = 'force-dynamic';

export default function ConnectorsPage() {
  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        title="Connectors"
        subtitle="The MCP connectors betaC talks to — a curated bundle wired day one, plus your own. Toggle what's active; add custom servers."
      />
      <div className="mt-6">
        <ConnectorManager />
      </div>
    </div>
  );
}
