// /2fa — opt-in TOTP two-factor auth. Enrol with an authenticator app, manage
// recovery codes, disable, and (owner/admin) toggle the tenant-wide "require
// 2FA" enforcement policy. Backed by the gateway's core/totp-mfa.ts.
import { PageHeader } from '@/components/page-header';
import TotpManager from './totp-manager';

export const dynamic = 'force-dynamic';

export default function TwoFactorPage() {
  return (
    <div className="max-w-2xl mx-auto">
      <PageHeader
        title="Two-Factor Authentication"
        subtitle="Add a second factor to your login with an authenticator app, plus one-time recovery codes as a fallback."
      />
      <div className="mt-6">
        <TotpManager />
      </div>
    </div>
  );
}
