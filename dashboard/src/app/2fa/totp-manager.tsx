'use client';

// Client manager for TOTP two-factor auth (SECURITY: opt-in 2FA — enrol,
// verify, disable, recovery codes, per-tenant enforce policy). Backed by the
// gateway's core/totp.ts (crypto) + core/totp-mfa.ts (orchestration) via the
// /api/auth/totp/* and /api/auth/tenant/2fa-policy proxy routes.
//
// QR: the gateway hands back the standard otpauth:// URI; rendering it as an
// actual scannable image is left to a follow-up (no QR-image dependency here
// — see totp.ts header). Every authenticator app supports manual base32
// entry, so enrolment is fully functional via the secret shown below.

import { useCallback, useEffect, useState } from 'react';

interface TotpStatus {
  enabled: boolean;
  recoveryCodesRemaining: number;
}

interface EnrollState {
  secret: string;
  otpauthUri: string;
}

const inputCls =
  'w-full px-3 py-2 rounded-lg bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] text-sm text-[rgb(var(--text-primary))] placeholder-zinc-600 focus:border-teal-600 outline-none transition-colors font-mono tracking-widest';

// Group a base32 secret into 4-char chunks for easier manual entry.
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

export default function TotpManager() {
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [role, setRole] = useState<string | null>(null);
  const [policy, setPolicy] = useState<boolean | null>(null);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);

  const [enroll, setEnroll] = useState<EnrollState | null>(null);
  const [enrollCode, setEnrollCode] = useState('');
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const [manageCode, setManageCode] = useState('');
  const [manageBusy, setManageBusy] = useState<'disable' | 'regenerate' | null>(null);
  const [manageError, setManageError] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState<'disable' | 'regenerate' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, meRes, policyRes] = await Promise.all([
        fetch('/api/auth/totp/status', { cache: 'no-store' }),
        fetch('/api/auth/me', { cache: 'no-store' }),
        fetch('/api/auth/tenant/2fa-policy', { cache: 'no-store' }),
      ]);
      if (!statusRes.ok) throw new Error('failed to load 2FA status');
      setStatus(await statusRes.json());
      if (meRes.ok) {
        const me = await meRes.json();
        setRole(typeof me.role === 'string' ? me.role : null);
      }
      if (policyRes.ok) {
        const json = await policyRes.json();
        setPolicy(!!json.require2fa);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load 2FA settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function startEnroll() {
    setEnrollError(null);
    setEnrollBusy(true);
    try {
      const res = await fetch('/api/auth/totp/enroll', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'failed to start enrolment');
      setEnroll({ secret: json.secret, otpauthUri: json.otpauthUri });
    } catch (err) {
      setEnrollError(err instanceof Error ? err.message : 'failed to start enrolment');
    } finally {
      setEnrollBusy(false);
    }
  }

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault();
    setEnrollError(null);
    setEnrollBusy(true);
    try {
      const res = await fetch('/api/auth/totp/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: enrollCode.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'invalid code');
      setRecoveryCodes(Array.isArray(json.recoveryCodes) ? json.recoveryCodes : []);
      setEnroll(null);
      setEnrollCode('');
      await load();
    } catch (err) {
      setEnrollError(err instanceof Error ? err.message : 'invalid code');
    } finally {
      setEnrollBusy(false);
    }
  }

  async function submitManage(action: 'disable' | 'regenerate') {
    setManageError(null);
    setManageBusy(action);
    try {
      const url =
        action === 'disable' ? '/api/auth/totp/disable' : '/api/auth/totp/recovery-codes/regenerate';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: manageCode.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'invalid code');
      if (action === 'regenerate') {
        setRecoveryCodes(Array.isArray(json.recoveryCodes) ? json.recoveryCodes : []);
      }
      setManageCode('');
      setManageOpen(null);
      await load();
    } catch (err) {
      setManageError(err instanceof Error ? err.message : 'invalid code');
    } finally {
      setManageBusy(null);
    }
  }

  async function togglePolicy(enabled: boolean) {
    setPolicyError(null);
    setPolicyBusy(true);
    try {
      const res = await fetch('/api/auth/tenant/2fa-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'failed to update policy');
      setPolicy(!!json.require2fa);
    } catch (err) {
      setPolicyError(err instanceof Error ? err.message : 'failed to update policy');
    } finally {
      setPolicyBusy(false);
    }
  }

  if (loading) return <div className="text-sm text-[rgb(var(--text-muted))]">Loading…</div>;

  // ── Show-once recovery codes (after confirm or regenerate) ──
  if (recoveryCodes) {
    return (
      <div className="rounded-lg border border-amber-700/40 p-4">
        <p className="text-sm text-[rgb(var(--text-primary))] font-medium">Save your recovery codes</p>
        <p className="mt-1 text-xs text-[rgb(var(--text-muted))]">
          Each code works once and lets you sign in if you lose access to your authenticator app. Store them
          somewhere safe — they are shown <strong className="text-[rgb(var(--text-primary))]">only once</strong>.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-xs text-teal-300">
          {recoveryCodes.map((c) => (
            <div key={c} className="px-2 py-1 rounded bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] select-all">
              {c}
            </div>
          ))}
        </div>
        <button
          onClick={() => setRecoveryCodes(null)}
          className="gel-brand mt-4 w-full px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 transition"
        >
          I&apos;ve saved these codes
        </button>
      </div>
    );
  }

  // ── Enrolment in progress (secret issued, awaiting confirm code) ──
  if (enroll) {
    return (
      <div className="rounded-lg border border-[rgb(var(--border-subtle))] p-4">
        <p className="text-sm text-[rgb(var(--text-primary))] font-medium">Set up your authenticator app</p>
        <p className="mt-1 text-xs text-[rgb(var(--text-muted))]">
          Add this account to your authenticator app (1Password, Authy, Google Authenticator, …) using the setup
          link below, or enter this secret manually:
        </p>
        <div className="mt-3 px-3 py-2 rounded-lg bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] font-mono text-sm text-teal-300 select-all tracking-widest">
          {groupSecret(enroll.secret)}
        </div>
        <a
          href={enroll.otpauthUri}
          className="mt-2 block text-xs text-teal-400 hover:text-teal-300 break-all transition"
        >
          {enroll.otpauthUri}
        </a>
        {enrollError && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-rose-950/50 border border-rose-800/50 text-xs text-rose-300">
            {enrollError}
          </div>
        )}
        <form onSubmit={confirmEnroll} className="mt-3 space-y-2">
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={enrollCode}
            onChange={(e) => setEnrollCode(e.target.value)}
            placeholder="123456"
            className={inputCls}
            required
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={enrollBusy || !enrollCode.trim()}
              className="gel-brand flex-1 px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {enrollBusy ? 'Confirming…' : 'Confirm & enable'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEnroll(null);
                setEnrollCode('');
                setEnrollError(null);
              }}
              className="px-3 py-2 rounded-lg text-sm text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))] transition"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-[rgb(var(--border-subtle))] p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-[rgb(var(--text-primary))]">
              Authenticator app 2FA — {status?.enabled ? <span className="text-emerald-400">Enabled</span> : <span className="text-[rgb(var(--text-muted))]">Not enabled</span>}
            </p>
            <p className="mt-1 text-xs text-[rgb(var(--text-muted))]">
              {status?.enabled
                ? `${status.recoveryCodesRemaining} recovery code${status.recoveryCodesRemaining === 1 ? '' : 's'} remaining.`
                : 'Require a 6-digit code from an authenticator app in addition to your password.'}
            </p>
          </div>
          {!status?.enabled && (
            <button
              onClick={startEnroll}
              disabled={enrollBusy}
              className="gel-brand px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 disabled:opacity-40 transition whitespace-nowrap"
            >
              Enable 2FA
            </button>
          )}
        </div>
        {error && <p role="alert" className="mt-2 text-xs text-rose-400">{error}</p>}

        {status?.enabled && (
          <div className="mt-4 pt-4 border-t border-[rgb(var(--border-subtle))]/70 space-y-3">
            {manageOpen ? (
              <div className="space-y-2">
                <p className="text-xs text-[rgb(var(--text-muted))]">
                  Enter a current authenticator code to {manageOpen === 'disable' ? 'disable 2FA' : 'regenerate your recovery codes'}.
                </p>
                {manageError && <p role="alert" className="text-xs text-rose-400">{manageError}</p>}
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={manageCode}
                  onChange={(e) => setManageCode(e.target.value)}
                  placeholder="123456"
                  className={inputCls}
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => submitManage(manageOpen)}
                    disabled={manageBusy !== null || !manageCode.trim()}
                    className="gel-surface flex-1 px-3 py-2 rounded-lg border border-[rgb(var(--border-subtle))] text-sm text-[rgb(var(--text-primary))] hover:border-zinc-700 disabled:opacity-40 transition"
                  >
                    {manageBusy ? 'Working…' : 'Confirm'}
                  </button>
                  <button
                    onClick={() => {
                      setManageOpen(null);
                      setManageCode('');
                      setManageError(null);
                    }}
                    className="px-3 py-2 rounded-lg text-sm text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))] transition"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  onClick={() => setManageOpen('regenerate')}
                  className="gel-surface px-3 py-2 rounded-lg border border-[rgb(var(--border-subtle))] text-xs text-[rgb(var(--text-primary))] hover:border-zinc-700 transition"
                >
                  Regenerate recovery codes
                </button>
                <button
                  onClick={() => setManageOpen('disable')}
                  className="px-3 py-2 rounded-lg border border-rose-900/50 text-xs text-rose-300 hover:border-rose-700 transition"
                >
                  Disable 2FA
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {(role === 'owner' || role === 'admin') && policy !== null && (
        <div className="rounded-lg border border-[rgb(var(--border-subtle))] p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-[rgb(var(--text-primary))]">Require 2FA for every member</p>
              <p className="mt-1 text-xs text-[rgb(var(--text-muted))]">
                Members without 2FA enabled will be forced to enrol the next time they sign in.
              </p>
            </div>
            <button
              onClick={() => togglePolicy(!policy)}
              disabled={policyBusy}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition disabled:opacity-40 whitespace-nowrap ${
                policy ? 'gel-brand text-teal-100 hover:brightness-110' : 'gel-surface border border-[rgb(var(--border-subtle))] text-[rgb(var(--text-primary))] hover:border-zinc-700'
              }`}
            >
              {policy ? 'Required' : 'Not required'}
            </button>
          </div>
          {policyError && <p role="alert" className="mt-2 text-xs text-rose-400">{policyError}</p>}
        </div>
      )}
    </div>
  );
}
