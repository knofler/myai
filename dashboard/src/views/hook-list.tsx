'use client';

import { useState } from 'react';
import { toggleHookInList } from '@/lib/hook-toggle';

interface HookLastToggle {
  actorUserId?: string;
  role?: string;
  via?: string;
  previousState?: boolean;
  newState?: boolean;
  at?: string;
}

interface HookItem {
  _id: string;
  name: string;
  events: string[];
  priority: number;
  source: string;
  timeout: number;
  enabled: boolean;
  lastToggle?: HookLastToggle;
}

// "actor at time" tooltip text for the last-toggle governance record
// (task-bd18a5ec), e.g. "alice (admin) disabled -> enabled at 2026-07-28 03:12 UTC".
function lastToggleTooltip(t?: HookLastToggle): string | undefined {
  if (!t || !t.at) return undefined;
  const who = t.actorUserId ? `${t.actorUserId} (${t.role ?? 'unknown role'})` : `${t.role ?? 'system'} via ${t.via ?? 'unknown'}`;
  const from = t.previousState ? 'enabled' : 'disabled';
  const to = t.newState ? 'enabled' : 'disabled';
  return `Last toggle: ${who} — ${from} -> ${to} at ${t.at}`;
}

// Hooks table with the §3.2 enable/disable toggle. Optimistic flip → PATCH
// /api/hooks (gateway patches .claude/settings.json) → revert on failure.
export function HookList({ hooks: initial }: { hooks: HookItem[] }) {
  const [hooks, setHooks] = useState(initial);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(hook: HookItem) {
    const enabled = !hook.enabled;
    setPending(hook.name);
    setError(null);
    setHooks(h => toggleHookInList(h, hook.name, enabled));
    try {
      const res = await fetch('/api/hooks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: hook.name, enabled }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error((data as { error?: string } | null)?.error ?? `request failed (${res.status})`);
      }
      const lastToggle = (data as { lastToggle?: HookLastToggle } | null)?.lastToggle;
      if (lastToggle) {
        setHooks(h => h.map(x => (x.name === hook.name ? { ...x, lastToggle } : x)));
      }
    } catch (err) {
      setHooks(h => toggleHookInList(h, hook.name, hook.enabled));
      setError(`Could not ${enabled ? 'enable' : 'disable'} ${hook.name}: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div>
      {error && (
        <p className="mb-3 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">{error}</p>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <table className="card-table w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Events</th>
              <th className="px-4 py-3 text-center">Priority</th>
              <th className="px-4 py-3 text-center">Source</th>
              <th className="px-4 py-3 text-center">Timeout</th>
              <th className="px-4 py-3 text-center">Enabled</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/50">
            {hooks.map(h => (
              <tr
                key={h._id}
                title={lastToggleTooltip(h.lastToggle)}
                className={`hover:bg-zinc-800/30 active:bg-zinc-800/60 transition-colors ${h.enabled ? '' : 'opacity-60'}`}
              >
                <td className="m-title px-4 py-2.5 font-mono text-xs text-zinc-300">{h.name}</td>
                <td data-label="Events" className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1 justify-end md:justify-start">
                    {h.events.map(e => (
                      <span key={e} className="text-[10px] font-mono px-1.5 py-0.5 bg-zinc-800 rounded text-emerald-400">{e}</span>
                    ))}
                  </div>
                </td>
                <td data-label="Priority" className="px-4 py-2.5 text-center text-xs text-zinc-400">{h.priority}</td>
                <td data-label="Source" className="px-4 py-2.5 text-center">
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                    h.source === 'builtin' ? 'bg-blue-500/10 text-blue-400' :
                    h.source === 'bash' ? 'bg-orange-500/10 text-orange-400' :
                    'bg-zinc-800 text-zinc-400'
                  }`}>{h.source}</span>
                </td>
                <td data-label="Timeout" className="m-hide px-4 py-2.5 text-center text-xs text-zinc-500">{h.timeout}ms</td>
                <td data-label="Enabled" className="px-4 py-2.5 text-center">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={h.enabled}
                    aria-label={`${h.enabled ? 'Disable' : 'Enable'} ${h.name}`}
                    disabled={pending === h.name}
                    onClick={() => toggle(h)}
                    className={`tap-press relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                      h.enabled ? 'bg-emerald-500/80' : 'bg-zinc-700'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-zinc-100 transition-transform ${
                        h.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                      }`}
                    />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
