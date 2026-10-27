// /2fa — opt-in TOTP two-factor auth. Enrol with an authenticator app, manage
// recovery codes, disable, and (owner/admin) toggle the tenant-wide "require
// 2FA" enforcement policy. Backed by the gateway's core/totp-mfa.ts.
import { PageHeader } from '@/components/page-header';
import TotpManager from './totp-manager';

export const dynamic = 'force-dynamic';

/** The one-line answer (DESIGN_LANGUAGE §5.1). This page is a thin shell around
 *  a client manager and loads no data server-side, so the sentence says what the
 *  page is for rather than stating a count it cannot know. */
function twoFactorSummary(): string {
  return 'Ask for a second factor from an authenticator app every time you sign in. Keep the one-time recovery codes somewhere safe so a lost phone never locks you out.';
}

export default function TwoFactorPage() {
  return (
    <div className="max-w-2xl mx-auto">
      <PageHeader
        icon="security"
        title="Two-Factor Authentication"
        summary={twoFactorSummary()}
        subtitle="Account security · TOTP authenticator apps."
      />
      <div className="mt-6">
        <TotpManager />
      </div>
    </div>
  );
}
