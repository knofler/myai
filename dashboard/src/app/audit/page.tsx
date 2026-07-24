// /audit — the in-dashboard audit-log viewer + permission matrix (RBAC v2,
// ADR-013 §5). owner/admin only: the gateway `members`-capability gate returns
// 403 to viewers/members, which the client renders as an access notice. Reads
// go through the /api/auth/audit + /api/auth/permissions proxies (session JWT).
import { PageHeader } from '@/components/page-header';
import AuditViewer from './audit-viewer';

export const dynamic = 'force-dynamic';

export default function AuditPage() {
  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        title="Audit & Permissions"
        subtitle="Every privileged action and access denial on your tenant — role changes, invites, connector/schedule/billing changes — plus the role permission matrix. Export the trail for SOC2 evidence."
      />
      <div className="mt-6">
        <AuditViewer />
      </div>
    </div>
  );
}
