// /connectors — per-tenant MCP connector manager (betaC bundled connector set).
// Lists the curated default bundle (auto-seeded on first read) plus any custom
// connectors, with per-tenant enable/disable toggles, so a fresh betaC install
// has working connectors day one. Reads + writes go through /api/connectors.

import { PageHeader } from '@/components/page-header';
import ConnectorManager from './connector-manager';

export const dynamic = 'force-dynamic';

/** The one-line answer (DESIGN_LANGUAGE §5.1). The bundle and its toggles are
 *  fetched client-side, so this shell names no counts. */
function connectorsSummary(): string {
  return 'Connectors are the tools your AI can reach out and use. A curated bundle is wired up on day one, and you decide what stays switched on and what else to add.';
}

export default function ConnectorsPage() {
  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        icon="connectors"
        title="Connectors"
        summary={connectorsSummary()}
        subtitle="MCP connectors · the bundled set plus your own."
      />
      <div className="mt-6">
        <ConnectorManager />
      </div>
    </div>
  );
}
