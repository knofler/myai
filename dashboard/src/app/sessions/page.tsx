// /sessions — active session / device management. List every device
// currently signed in (UA/IP/last-seen), revoke one, or revoke every other
// device at once. Backed by the gateway's UserSession store (core/user-sessions.ts).
import { PageHeader } from '@/components/page-header';
import { IdleTimeoutSettings } from '@/components/idle-timeout-settings';
import SessionsManager from './sessions-manager';

export const dynamic = 'force-dynamic';

export default function SessionsPage() {
  return (
    <div className="max-w-4xl mx-auto">
      {/* §5.1: the answer first. This shell loads nothing (SessionsManager
          fetches the device list client-side), so the sentence says what the
          page is FOR rather than quoting a device count not in scope here. */}
      <PageHeader
        icon="sessions"
        title="Active Sessions"
        summary="Every device currently signed in to your account. Revoke one to sign that device out immediately."
        subtitle="A password reset revokes every session automatically."
      />
      <div className="mt-6">
        <IdleTimeoutSettings />
      </div>
      <div className="mt-6">
        <SessionsManager />
      </div>
    </div>
  );
}
