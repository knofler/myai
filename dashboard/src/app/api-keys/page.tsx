// /api-keys — scoped per-tenant API-key management (ADR-010 §3.6). owner/admin
// only: the gateway members-capability gate returns 403 to viewers/members,
// which the client renders as an access notice. Create/rotate/revoke go through
// the /api/auth/api-keys* proxies (session JWT); the raw key is shown ONCE.
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import ApiKeysManager from './api-keys-manager';

export const dynamic = 'force-dynamic';

export default function ApiKeysPage() {
  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        title="API Keys"
        subtitle="Create, scope, rotate, and revoke the per-tenant API keys that authenticate machine access to your gateway. Rotation keeps the old key alive for a grace window so you can swap it in with zero downtime. Every action is audit-logged."
      >
        <Link
          href="/developers"
          target="_blank"
          className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
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
