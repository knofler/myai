'use client';

// Install panel for a marketplace listing detail page — the client shell that
// drives the ADR-019 install state machine through /api/marketplace/installs:
//   no live install  → Install (free tier only; gate reason shown otherwise)
//   active           → Disable · Uninstall
//   disabled         → Enable · Uninstall
// Every mutation router.refresh()es so the server-rendered detail (and the
// catalog's "installed" badge) re-reads the store — the server is the truth,
// this component holds no state beyond in-flight/error.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { InstallAction, InstallStatus } from '@/lib/marketplace';

interface InstallSnapshot {
  installId: string;
  status: InstallStatus;
  version: string;
}

const BTN = 'px-3 py-1.5 text-sm rounded-md border transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const BTN_PRIMARY = `${BTN} bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:border-emerald-500/60`;
const BTN_NEUTRAL = `${BTN} bg-zinc-800 text-zinc-300 border-zinc-700 hover:border-zinc-500`;
const BTN_DANGER = `${BTN} bg-red-500/10 text-red-400 border-red-500/30 hover:border-red-500/60`;

export function MarketplaceInstallPanel({
  slug,
  install,
  gate,
}: {
  slug: string;
  install: InstallSnapshot | null;
  gate: { ok: boolean; reason?: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mutate(run: () => Promise<Response>) {
    setBusy(true);
    setError(null);
    try {
      const res = await run();
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `request failed (${res.status})`);
      } else {
        router.refresh();
      }
    } catch {
      setError('request failed — dashboard unreachable');
    } finally {
      setBusy(false);
    }
  }

  const doInstall = () =>
    mutate(() =>
      fetch('/api/marketplace/installs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      }),
    );

  const doAction = (action: InstallAction) =>
    mutate(() =>
      fetch(`/api/marketplace/installs/${install!.installId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      }),
    );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {!install ? (
          <>
            <button className={BTN_PRIMARY} disabled={busy || !gate.ok} onClick={doInstall}>
              {busy ? 'Installing…' : 'Install'}
            </button>
            {!gate.ok && <span className="text-xs text-amber-400/90">{gate.reason}</span>}
          </>
        ) : install.status === 'active' ? (
          <>
            <span className="text-xs text-emerald-400">Installed v{install.version} · active</span>
            <button className={BTN_NEUTRAL} disabled={busy} onClick={() => doAction('disable')}>Disable</button>
            <button className={BTN_DANGER} disabled={busy} onClick={() => doAction('uninstall')}>Uninstall</button>
          </>
        ) : (
          <>
            <span className="text-xs text-zinc-400">Installed v{install.version} · disabled</span>
            <button className={BTN_PRIMARY} disabled={busy} onClick={() => doAction('enable')}>Enable</button>
            <button className={BTN_DANGER} disabled={busy} onClick={() => doAction('uninstall')}>Uninstall</button>
          </>
        )}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
