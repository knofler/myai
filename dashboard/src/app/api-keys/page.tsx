// /api-keys — scoped per-tenant API-key management (ADR-010 §3.6). owner/admin
// only: the gateway members-capability gate returns 403 to viewers/members,
// which the client renders as an access notice. Create/rotate/revoke go through
// the /api/auth/api-keys* proxies (session JWT); the raw key is shown ONCE.
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import ApiKeysManager from './api-keys-manager';

export const dynamic = 'force-dynamic';

/** The one-line answer (DESIGN_LANGUAGE §5.1). The key list is fetched by the
 *  client manager, so this shell knows no counts and states none. */
function apiKeysSummary(): string {
  return 'API keys are how a machine talks to your gateway without a password. Create one, scope it to what it needs, rotate it with a grace window so nothing breaks, or revoke it the moment it leaks.';
}

export default function ApiKeysPage() {
  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        icon="keys"
        title="API Keys"
        summary={apiKeysSummary()}
        subtitle="Owner and admin only · every key action is audit-logged."
      >
        <Link
          href="/developers"
          target="_blank"
          className="rounded-lg border border-[rgb(var(--border-subtle))] px-3 py-1.5 text-meta text-[rgb(var(--text-secondary))] hover:bg-[rgb(var(--bg-hover))] hover:text-[rgb(var(--text-primary))]"
        >
          curl quickstart ↗
        </Link>
      </PageHeader>
      <div className="mt-6">
        <ApiKeysManager />
      </div>
    </div>
  );
}
