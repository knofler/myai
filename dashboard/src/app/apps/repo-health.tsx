'use client';

// Repo Health tab — the old /repos page. Client-side fetch against the
// gateway REST API (browser-reachable on the host), framework compliance
// dots per managed repo.

import { useState, useEffect } from 'react';
import { StatCard } from '@/components/ui/card';

interface Repo {
  name: string;
  path: string;
  group: string;
  accessible: boolean;
  aiDir: boolean;
  stateExists: boolean;
  stateFresh: boolean;
  claudeMd: boolean;
  geminiMd: boolean;
}

function StatusDot({ ok, unknown, label }: { ok: boolean; unknown?: boolean; label: string }) {
  return (
    <div className="flex items-center gap-1.5" title={label}>
      <span className={`w-2 h-2 rounded-full ${unknown ? 'bg-zinc-600' : ok ? 'bg-emerald-400' : 'bg-red-400'}`} />
      <span className="text-[10px] text-zinc-500">{label}</span>
    </div>
  );
}

export default function RepoHealth() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:3200';
    fetch(`${gatewayUrl}/api/repos`)
      .then(r => r.json())
      .then(data => { setRepos(data.repos || []); setLoading(false); })
      .catch(() => { setError('Gateway not reachable — repo health requires the gateway API at :3200'); setLoading(false); });
  }, []);

  if (loading) return <div className="text-zinc-500 text-sm">Loading repos…</div>;

  if (error) {
    return (
      <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-6 text-center">
        <p className="text-zinc-400 mb-2">{error}</p>
        <p className="text-xs text-zinc-600">Run locally with Docker to see repo health</p>
      </div>
    );
  }

  const accessible = repos.filter(r => r.accessible);
  const healthy = repos.filter(r => r.aiDir && r.stateExists && r.claudeMd);
  const inDocker = repos.length > 0 && accessible.length === 0;

  const groups: Record<string, Repo[]> = {};
  for (const r of repos) (groups[r.group || 'Other'] ??= []).push(r);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Total repos" value={repos.length} />
        <StatCard label="Accessible" value={accessible.length} accent={accessible.length > 0 ? 'green' : 'gray'} />
        <StatCard label="Healthy" value={healthy.length} accent={healthy.length > 0 ? 'green' : 'gray'} />
      </div>

      {inDocker && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
          <p className="text-sm text-amber-400">Running inside Docker — repo paths are not accessible from the container.</p>
          <p className="text-xs text-amber-400/60 mt-1">Health checks require running the gateway on the host machine or mounting the repo paths.</p>
        </div>
      )}

      {Object.entries(groups).map(([group, groupRepos]) => (
        <div key={group}>
          <h2 className="text-xs font-semibold text-zinc-500 mb-3 uppercase tracking-wider">{group}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {groupRepos.map(r => {
              const allGreen = r.aiDir && r.stateExists && r.claudeMd;
              const notAccessible = !r.accessible;
              return (
                <div
                  key={r.path}
                  className={`bg-zinc-900/70 border rounded-xl p-4 ${notAccessible ? 'border-zinc-800/50 opacity-70' : allGreen ? 'border-zinc-800' : 'border-amber-500/30'}`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="font-medium text-sm text-zinc-200">{r.name}</p>
                      <p className="text-[10px] text-zinc-600 font-mono mt-0.5 truncate max-w-[250px]">{r.path}</p>
                    </div>
                    <span className={`w-3 h-3 rounded-full ${notAccessible ? 'bg-zinc-600' : allGreen ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  </div>
                  <div className="grid grid-cols-2 gap-y-1.5">
                    <StatusDot ok={r.aiDir} unknown={notAccessible} label="AI/" />
                    <StatusDot ok={r.claudeMd} unknown={notAccessible} label="CLAUDE.md" />
                    <StatusDot ok={r.stateExists} unknown={notAccessible} label="STATE.md" />
                    <StatusDot ok={r.geminiMd} unknown={notAccessible} label="GEMINI.md" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
