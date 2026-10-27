// /audit — the in-dashboard audit-log viewer + permission matrix (RBAC v2,
// ADR-013 §5). owner/admin only: the gateway `members`-capability gate returns
// 403 to viewers/members, which the client renders as an access notice. Reads
// go through the /api/auth/audit + /api/auth/permissions proxies (session JWT).
import { PageHeader } from '@/components/page-header';
import AuditViewer from './audit-viewer';

export const dynamic = 'force-dynamic';

/** The one-line answer (DESIGN_LANGUAGE §5.1). The trail itself is fetched by
 *  the client viewer, so this shell states no counts. */
function auditSummary(): string {
  return 'Every privileged action and every access denial on your tenant, newest first. See who changed a role, who was invited, what billing or connectors moved, and what the permission rules turned away.';
}

export default function AuditPage() {
  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        icon="audit"
        title="Audit & Permissions"
        summary={auditSummary()}
        subtitle="Owner and admin only · exportable as SOC2 evidence."
      />
      <div className="mt-6">
        <AuditViewer />
      </div>
    </div>
  );
}
