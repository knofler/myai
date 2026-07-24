// /apps — where every app lives and whether it's wired right.
// Merges the old /directory (App Directory cards) and /repos (framework
// health) pages. The directory is the primary view, with a framework-health
// overlay (AI/ · STATE.md dots from the gateway) on each card.

import { connectDB, RepoCard } from '@/lib/db';
import { callGateway } from '@/lib/gateway';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { fmtSydney } from '@/lib/format';
import { LevelDot } from '@/components/ui/badge';
import { StatCard, EmptyState, Card } from '@/components/ui/card';
import { TabBar, resolveTab } from '@/components/ui/tabs';
import { PageHeader } from '@/components/page-header';
import AutoRefresh from '@/components/auto-refresh';
import RepoHealth from './repo-health';

export const dynamic = 'force-dynamic';

interface RepoCardDoc {
  repoName: string;
  description?: string;
  group?: string;
  localhostUrl?: string;
  appUrl?: string;
  apiUrl?: string;
  mongo?: string;
  vercelUrl?: string;
  dnsUrl?: string;
  lastStatus?: string;
  lastStatusLevel?: 'ok' | 'warn' | 'error' | 'unknown';
  reportedBy?: string;
  commitsAhead?: number;
  updatedAt?: string;
}

interface ManagedRepo {
  name: string;
  hasAiFolder?: boolean;
  hasStateFile?: boolean;
  stack?: string;
}

function staleDays(d?: string): number | null {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
}

function LinkRow({ label, url }: { label: string; url?: string }) {
  if (!url) return null;
  const href = url.startsWith('http') ? url : `https://${url}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      // tap-press + min tap height: on a phone each destination is a comfortable
      // 44px target with a press response, not a hairline text link (registry pass).
      className="tap-press flex items-center gap-2 text-xs -mx-1 px-1 py-2 sm:py-0.5 min-h-[44px] sm:min-h-0 rounded-md active:bg-zinc-800/60"
    >
      <span className="w-16 shrink-0 text-zinc-600 uppercase tracking-wider text-[10px]">{label}</span>
      <span className="text-emerald-400/90 hover:text-emerald-300 truncate font-mono">{url}</span>
    </a>
  );
}

function InfoRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 shrink-0 text-zinc-600 uppercase tracking-wider text-[10px]">{label}</span>
      <span className="text-zinc-300 truncate font-mono">{value}</span>
    </div>
  );
}

function AheadBadge({ count }: { count?: number }) {
  if (!count || count < 1) return null;
  return (
    <span
      className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/20"
      title={`test is ${count} commit${count === 1 ? '' : 's'} ahead of main — pending 'ship it'`}
    >
      {count} ahead
    </span>
  );
}

function FrameworkDot({ ok, label }: { ok?: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500" title={`${label}: ${ok === undefined ? 'unknown' : ok ? 'present' : 'missing'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${ok === undefined ? 'bg-zinc-700' : ok ? 'bg-emerald-400' : 'bg-red-400'}`} />
      {label}
    </span>
  );
}

async function DirectoryTab({ tenantId }: { tenantId: string }) {
  let cards: RepoCardDoc[] = [];
  let dbError = false;
  try {
    cards = JSON.parse(JSON.stringify(await RepoCard.find(tenantFilter(tenantId)).sort({ group: 1, repoName: 1 }).lean())) as RepoCardDoc[];
  } catch {
    dbError = true;
  }

  // Framework-health overlay from the gateway's managed-repo registry.
  const reposList = await callGateway<{ repos?: ManagedRepo[] }>('repos_list');
  const byName = new Map((reposList?.repos ?? []).map((r) => [r.name, r]));

  const reported = cards.filter((c) => c.lastStatusLevel && c.lastStatusLevel !== 'unknown').length;
  const pendingShip = cards.filter((c) => (c.commitsAhead ?? 0) > 0).length;
  const groups: Record<string, RepoCardDoc[]> = {};
  for (const c of cards) (groups[c.group || 'Apps'] ??= []).push(c);

  return (
    <div className="space-y-6">
      {dbError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400">
          Database not reachable — the directory needs the gateway Mongo at :27200.
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Tracked apps" value={cards.length} />
        <StatCard label="Reporting status" value={reported} accent={reported > 0 ? 'green' : 'gray'} />
        <StatCard label="Awaiting first report" value={cards.length - reported} />
        <StatCard label="Pending ship it" value={pendingShip} accent={pendingShip > 0 ? 'yellow' : 'gray'} />
      </div>

      {cards.length === 0 && !dbError && (
        <Card>
          <EmptyState>
            <p>
              No cards yet. Each repo populates its card on <code className="text-zinc-400">wrap up</code> via <code className="text-zinc-400">./AI/scripts/repo_card.sh</code>.
            </p>
            <p className="mt-2">
              First time here? <a href="/welcome/start" className="text-emerald-400 hover:underline">Connect a repo</a> and it shows up here immediately.
            </p>
          </EmptyState>
        </Card>
      )}

      {Object.entries(groups).map(([group, list]) => (
        <div key={group}>
          <h2 className="text-xs font-semibold text-zinc-500 mb-3 uppercase tracking-wider">{group}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {list.map((c) => {
              const stale = staleDays(c.updatedAt);
              const fw = byName.get(c.repoName);
              return (
                <div key={c.repoName} className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4 flex flex-col gap-3 hover:border-zinc-700 transition-colors">
                  <div className="flex items-start justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-sm text-zinc-100 truncate">{c.repoName}</p>
                        <AheadBadge count={c.commitsAhead} />
                      </div>
                      <p className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{c.description || 'No description yet'}</p>
                    </div>
                    <LevelDot level={c.lastStatusLevel} className="mt-1 !w-3 !h-3" />
                  </div>

                  <div className="space-y-1 border-t border-zinc-800/70 pt-2">
                    <LinkRow label="local" url={c.localhostUrl} />
                    <LinkRow label="app" url={c.appUrl} />
                    <LinkRow label="api" url={c.apiUrl} />
                    <LinkRow label="vercel" url={c.vercelUrl} />
                    <LinkRow label="dns" url={c.dnsUrl} />
                    <InfoRow label="mongo" value={c.mongo} />
                  </div>

                  <div className="border-t border-zinc-800/70 pt-2">
                    <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-0.5">Last status</p>
                    <p className="text-xs text-zinc-300 line-clamp-3">{c.lastStatus || '—'}</p>
                    <div className="flex items-center justify-between mt-1.5">
                      <p className="text-[10px] text-zinc-600">
                        {fmtSydney(c.updatedAt)}{stale !== null && stale > 7 ? ` · ${stale}d ago ⚠` : ''}
                        {c.reportedBy ? ` · ${c.reportedBy}` : ''}
                      </p>
                      <div className="flex items-center gap-2">
                        <FrameworkDot ok={fw?.hasAiFolder} label="AI/" />
                        <FrameworkDot ok={fw?.hasStateFile} label="STATE" />
                      </div>
                    </div>
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

export default async function AppsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: requested } = await searchParams;
  try { await connectDB(); } catch { /* directory tab reports the error */ }
  // §7.2 Day 4 — the App Directory is scoped to the active tenant.
  const tenantId = await getActiveTenant();

  const tabs = [
    { id: 'apps', label: 'App Directory' },
    { id: 'health', label: 'Repo Health' },
  ];
  const tab = resolveTab(tabs, requested);

  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={15} />
      <PageHeader
        title="Apps"
        subtitle="One-point pointer for every tracked app — URLs, datastore, framework wiring, and last-update status."
      >
        <a
          href="/apps/new"
          className="gel-brand px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 transition whitespace-nowrap"
        >
          + New App
        </a>
      </PageHeader>
      <TabBar base="/apps" tabs={tabs} active={tab} />
      <div className="mt-6">
        {tab === 'apps' && <DirectoryTab tenantId={tenantId} />}
        {tab === 'health' && <RepoHealth />}
      </div>
    </div>
  );
}
