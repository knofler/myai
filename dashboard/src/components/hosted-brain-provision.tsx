'use client';

// Hosted-brain provisioning card (ADR-023 Slice P1a) — the "connect another
// machine" action the quota bar (HostedBrainCard in views/brain.tsx) never
// had. Calls the existing brain_host_provision / brain_host_rotate MCP tools
// (ADR-017) via /api/brain/host/{provision,rotate}, revealing the remote URL
// + one-time access token exactly once with a copy-to-clipboard and an
// explicit "shown once — copy now" notice (mirrors the api-keys manager's
// show-once pattern). No new gateway surface — dashboard-only work.

import { useCallback, useState } from 'react';
import { useTenant } from '@/lib/tenant-context';
import { provisionRevealNote, provisionCtaLabel, type HostedBrainProvisionResult } from '@/lib/hosted-brain';

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — the field is select-all as a fallback */ }
  }, [value]);

  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">{label}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 select-all break-all rounded bg-black/50 px-3 py-2 font-mono text-xs text-emerald-200">
          {value}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className="shrink-0 rounded border border-emerald-700 px-3 py-2 text-xs text-emerald-300 hover:bg-emerald-900/40"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function HostedBrainProvision({ provisioned }: { provisioned: boolean }) {
  const { current, authHeaders } = useTenant();
  const [busy, setBusy] = useState<'provision' | 'rotate' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<HostedBrainProvisionResult | null>(null);

  const call = useCallback(async (action: 'provision' | 'rotate') => {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/brain/host/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error || `Could not ${action} the hosted brain.`);
        return;
      }
      setReveal(json as HostedBrainProvisionResult);
    } catch {
      setError('Could not reach the gateway. Try again.');
    } finally {
      setBusy(null);
    }
  }, [authHeaders]);

  const rotate = useCallback(() => {
    if (!confirm(
      'Rotate the hosted-brain access token? The old token stops working immediately — any machine still using it will need the new one.',
    )) return;
    void call('rotate');
  }, [call]);

  // Nothing to provision for the local/default tenant (never billed, never hostable).
  if (!current) return null;

  return (
    <div className="space-y-3">
      {reveal && (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/30 px-4 py-3 space-y-3">
          <p className="text-sm text-emerald-300">
            {provisionRevealNote(reveal)} It won&apos;t be shown again — use{' '}
            <code className="text-emerald-200">brain host rotate</code> to reissue if you lose it.
          </p>
          <CopyField label="Remote URL (includes credential)" value={reveal.remoteUrl} />
          <CopyField label="Access token" value={reveal.token} />
          <button
            type="button"
            onClick={() => setReveal(null)}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
          >
            Done
          </button>
        </div>
      )}

      {error && <p className="text-xs text-rose-400">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void call('provision')}
          disabled={busy !== null}
          className="rounded-md bg-sky-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {busy === 'provision' ? 'Connecting…' : provisionCtaLabel(provisioned)}
        </button>
        {provisioned && (
          <button
            type="button"
            onClick={rotate}
            disabled={busy !== null}
            className="rounded-md border border-amber-700 px-3.5 py-1.5 text-sm font-semibold text-amber-300 hover:bg-amber-950/40 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {busy === 'rotate' ? 'Rotating…' : 'Rotate access token'}
          </button>
        )}
      </div>
    </div>
  );
}
