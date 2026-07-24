// /brain — the git-versioned agent-memory explorer. Read-only, tenant-scoped:
// browse the brain's namespaces, atoms (sessions / handoffs / cross-repo
// memory), open stashes, session/idea branches, recent commits, and the
// code↔memory provenance recorded on HEAD. Sources everything from the gateway
// `brain_explore` tool in one pass — never checks out, merges, or writes.

import { StatCard, Card, EmptyState, THead } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { GATEWAY_URL } from '@/lib/gateway';
import {
  fetchBrainExplore, fetchBrainHealth, formatBrainStamp,
  type BrainAtomMeta, type BrainHealth, type BrainSection,
} from '@/lib/brain';
import {
  fetchHostedBrainInfo,
  quotaUsage,
  upgradeCta,
  formatBytes,
  capLabel,
  planLabel,
  type HostedBrainInfo,
  type QuotaLevel,
} from '@/lib/hosted-brain';
import { HostedBrainUpgrade } from '@/components/hosted-brain-upgrade';
import BrainSearch from '@/views/brain-search';

export const dynamic = 'force-dynamic';

const KIND_BADGE: Record<string, string> = {
  session: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  handoff: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  memory: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
};

function KindBadge({ kind }: { kind: string }) {
  return <Badge className={KIND_BADGE[kind]}>{kind}</Badge>;
}

const GRADE_STYLE: Record<BrainHealth['grade'], { text: string; accent: 'emerald' | 'blue' | 'amber' | 'red' }> = {
  excellent: { text: 'text-emerald-400', accent: 'emerald' },
  good: { text: 'text-blue-400', accent: 'blue' },
  fair: { text: 'text-amber-400', accent: 'amber' },
  poor: { text: 'text-red-400', accent: 'red' },
};

/** Minimal inline trend line — no charting dependency for one sparkline. Score
 *  is always 0-100, so the y-scale is fixed; x is just point order (oldest→
 *  newest), not a real time axis — fine for "is this trending up or down". */
function HealthTrend({ history }: { history: BrainHealth['history'] }) {
  if (history.length < 2) {
    return <p className="text-xs text-zinc-500">Not enough recorded snapshots yet for a trend.</p>;
  }
  const w = 240;
  const h = 48;
  const pad = 4;
  const step = (w - pad * 2) / (history.length - 1);
  const y = (score: number) => h - pad - (score / 100) * (h - pad * 2);
  const points = history.map((s, i) => `${pad + i * step},${y(s.score)}`).join(' ');
  const last = history[history.length - 1];
  const strokeColor = GRADE_STYLE[last.grade].text.replace('text-', '');
  return (
    <div className="flex items-center gap-3">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
        <polyline
          points={points}
          fill="none"
          className={GRADE_STYLE[last.grade].text}
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={pad + (history.length - 1) * step} cy={y(last.score)} r={3} className={GRADE_STYLE[last.grade].text} fill="currentColor" />
      </svg>
      <span className="text-xs text-zinc-500">{history.length} recorded point{history.length !== 1 ? 's' : ''}</span>
    </div>
  );
}

function HealthCard({ health }: { health: BrainHealth }) {
  const style = GRADE_STYLE[health.grade];
  const { signals, subscores } = health;
  return (
    <Card title="Brain health" meta={`updated ${new Date(health.computedAt).toLocaleString()}`} accent={style.accent}>
      <div className="p-4 flex flex-col md:flex-row md:items-center gap-6">
        <div className="flex items-baseline gap-2">
          <span className={`text-4xl font-bold ${style.text}`}>{health.score}</span>
          <span className="text-zinc-500 text-sm">/100</span>
          <Badge className={KIND_BADGE.memory}>{health.grade}</Badge>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs flex-1">
          <div>
            <dt className="text-zinc-500">Freshness</dt>
            <dd className="text-zinc-300 font-mono">{signals.freshnessDays === null ? 'n/a' : `${signals.freshnessDays.toFixed(1)}d`} ({subscores.freshness})</dd>
          </div>
          <div>
            <dt className="text-zinc-500">Coverage</dt>
            <dd className="text-zinc-300 font-mono">{signals.coverageGaps}/{signals.namespaceTotal} gaps ({subscores.coverage})</dd>
          </div>
          <div>
            <dt className="text-zinc-500">Contradictions</dt>
            <dd className="text-zinc-300 font-mono">{signals.contradictionCount}/{signals.contradictionWindowDays}d ({subscores.contradictions})</dd>
          </div>
          <div>
            <dt className="text-zinc-500">Recall hit-rate</dt>
            <dd className="text-zinc-300 font-mono">{signals.recallHitRate === null ? 'n/a' : `${Math.round(signals.recallHitRate * 100)}%`}{subscores.recall !== null && ` (${subscores.recall})`}</dd>
          </div>
        </dl>
        <div>
          <p className="text-xs text-zinc-500 mb-1">Trend</p>
          <HealthTrend history={health.history} />
        </div>
      </div>
    </Card>
  );
}

// The compose-internal default only resolves inside the local docker-compose
// network — a remote deployment (Vercel) left on this default can never reach
// any gateway, which is the "brain not visible" symptom this card explains.
const GATEWAY_URL_IS_DEFAULT = GATEWAY_URL === 'http://gateway:3100/mcp';

function GatewayDown() {
  return (
    <Card title="Brain unavailable" accent="red">
      <div className="p-6 text-sm text-zinc-400 space-y-3">
        <p>The gateway didn&apos;t return a brain snapshot.</p>
        {GATEWAY_URL_IS_DEFAULT ? (
          <p className="text-xs text-zinc-500">
            No <code className="text-zinc-400">GATEWAY_MCP_URL</code> is configured on this deployment, so
            it&apos;s still pointed at the Docker-internal default (<code className="text-zinc-400">gateway:3100</code>)
            — that host only resolves inside a local <code className="text-zinc-400">docker compose</code> network,
            never from Vercel or any other remote host. The brain is git-backed on whichever machine runs the
            gateway (<code className="text-zinc-400">~/.myai/brain</code>), so a remote dashboard can only see it by
            reaching that gateway&apos;s <code className="text-zinc-400">brain_explore</code> tool over the network.
            Either set <code className="text-zinc-400">GATEWAY_MCP_URL</code> (+{' '}
            <code className="text-zinc-400">GATEWAY_LOCAL_TOKEN</code> if the gateway enforces tenancy) to a
            publicly reachable URL for that gateway, or provision the hosted-brain remote (ADR-017) as a
            synced, tenant-scoped store instead. See <code className="text-zinc-400">documentation/BRAIN_DASHBOARD.md</code>.
          </p>
        ) : (
          <p className="text-xs text-zinc-500">
            The brain is git-versioned agent memory served by the myai gateway
            (<code className="text-zinc-400">brain_explore</code> MCP tool). If the gateway is
            reachable but this persists, it may be running an image built before this tool
            shipped — rebuild the gateway from the master checkout.
          </p>
        )}
      </div>
    </Card>
  );
}

function NotInitialized() {
  return (
    <Card title="No brain store yet">
      <div className="p-6 text-sm text-zinc-400 space-y-2">
        <p>This tenant has no brain repo initialised.</p>
        <p className="text-xs text-zinc-500">
          Run <code className="text-zinc-400">myai brain init</code> (or complete a{' '}
          <code className="text-zinc-400">wrap up</code>, which merges a session atom into the
          brain) to create the store. Sessions = commits, wrap up = merge, <code className="text-zinc-400">main</code> ={' '}
          the consolidated truth every agent boots from.
        </p>
      </div>
    </Card>
  );
}

// ── Hosted brain (ADR-017) — managed remote quota bar + soft-limit upgrade ──

const QUOTA_BAR: Record<QuotaLevel, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  critical: 'bg-orange-500',
  over: 'bg-rose-500',
  unlimited: 'bg-blue-500',
};

const QUOTA_ACCENT: Record<QuotaLevel, 'emerald' | 'amber' | 'red' | 'blue'> = {
  ok: 'emerald',
  warn: 'amber',
  critical: 'amber',
  over: 'red',
  unlimited: 'blue',
};

function HostedBrainCard({ info }: { info: HostedBrainInfo }) {
  // Not provisioned — describe the opt-in upsell; self-host stays the default.
  if (!info.provisioned) {
    return (
      <Card title="Hosted brain" meta="not provisioned">
        <div className="p-6 text-sm text-zinc-400 space-y-2">
          <p>
            No managed brain remote for this tenant. The <strong className="text-zinc-200">hosted brain</strong>{' '}
            is a gateway-served, tenant-scoped git remote your brain pushes to — turnkey cross-device
            continuity for anyone who won&apos;t self-host git (ADR-017).
          </p>
          <p className="text-xs text-zinc-500">
            An opt-in Pro/Team upsell — self-hosting stays the default (your brain is your own git repo in
            every tier). Provision it with <code className="text-zinc-400">brain host provision</code> once your
            plan includes it.
          </p>
        </div>
      </Card>
    );
  }

  const usage = quotaUsage(info);
  const cta = upgradeCta(usage, info.plan);
  const accent = QUOTA_ACCENT[usage.level];
  const usedLabel = formatBytes(info.usedBytes);
  const limitLabel = usage.unlimited ? 'Unlimited' : capLabel(info.plan);

  return (
    <Card
      title="Hosted brain"
      meta={`${planLabel(info.plan)} · ${info.dataEncrypted ? 'encrypted at rest' : 'encryption not asserted'}`}
      accent={accent}
    >
      <div className="p-4 space-y-4">
        {/* Quota bar */}
        <div>
          <div className="flex items-baseline justify-between mb-1.5 text-sm">
            <span className="text-zinc-400">Storage used</span>
            <span className="font-mono text-zinc-200">
              {usedLabel}
              <span className="text-zinc-500"> / {limitLabel}</span>
              {!usage.unlimited && <span className="text-zinc-500"> · {usage.percent}%</span>}
            </span>
          </div>
          <div
            className="h-2.5 bg-zinc-950 rounded-full overflow-hidden"
            role="progressbar"
            aria-valuenow={usage.unlimited ? 0 : usage.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Hosted brain storage used"
          >
            <div
              className={`h-full rounded-full transition-all ${QUOTA_BAR[usage.level]}`}
              style={{ width: usage.unlimited ? '100%' : `${Math.max(usage.percent, 2)}%` }}
            />
          </div>
          {usage.unlimited && (
            <p className="mt-1.5 text-xs text-zinc-500">Unlimited storage on {planLabel(info.plan)} — no cap.</p>
          )}
        </div>

        {/* Soft-limit upgrade prompt */}
        {cta && (
          <div className={`rounded-lg border px-3.5 py-3 flex flex-col sm:flex-row sm:items-center gap-3 ${
            usage.level === 'over' ? 'border-rose-500/40 bg-rose-500/10' : 'border-amber-500/40 bg-amber-500/10'
          }`}>
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium ${usage.level === 'over' ? 'text-rose-200' : 'text-amber-200'}`}>
                {cta.headline}
              </p>
              <p className={`text-xs mt-0.5 ${usage.level === 'over' ? 'text-rose-300/70' : 'text-amber-300/70'}`}>
                {cta.body}
              </p>
            </div>
            <HostedBrainUpgrade nextPlan={cta.nextPlan} over={usage.level === 'over'} />
          </div>
        )}

        {/* Remote + timestamps */}
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
          {info.remoteUrl && (
            <div className="sm:col-span-2 min-w-0">
              <dt className="text-zinc-500 uppercase tracking-wider text-[10px]">Remote</dt>
              <dd className="font-mono text-zinc-300 truncate">{info.remoteUrl}</dd>
            </div>
          )}
          <div>
            <dt className="text-zinc-500 uppercase tracking-wider text-[10px]">Provisioned</dt>
            <dd className="text-zinc-300">{info.createdAt ? new Date(info.createdAt).toLocaleDateString() : '—'}</dd>
          </div>
          <div>
            <dt className="text-zinc-500 uppercase tracking-wider text-[10px]">Token rotated</dt>
            <dd className="text-zinc-300">{info.rotatedAt ? new Date(info.rotatedAt).toLocaleDateString() : '—'}</dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}

// Each tab renders exactly one heavy section (the always-shown header needs
// only counts). Fetch just that section so, e.g., opening Overview never pays
// for the atom file reads, stash previews, or the provenance blame walk.
const TAB_SECTIONS: Record<string, BrainSection[]> = {
  overview: [],
  atoms: ['atoms'],
  search: [],
  stashes: ['stashes'],
  provenance: ['provenance'],
};

export default async function BrainView({ tab }: { tab: string }) {
  const [brain, hosted, health] = await Promise.all([
    fetchBrainExplore(TAB_SECTIONS[tab] ?? []),
    fetchHostedBrainInfo(),
    tab === 'overview' ? fetchBrainHealth() : Promise.resolve(null),
  ]);
  if (!brain) return <GatewayDown />;
  if (!brain.initialized) return <NotInitialized />;

  return (
    <div className="space-y-8">
      {/* Header stats — always shown, every tab. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Namespaces"
          value={brain.totals.namespaces}
          sub={brain.namespaces.map((n) => n.name).slice(0, 3).join(', ') || 'none'}
          accent={brain.totals.namespaces > 0 ? 'blue' : 'gray'}
        />
        <StatCard
          label="Session atoms"
          value={brain.totals.sessions}
          sub={`${brain.totals.handoffs} handoff atom${brain.totals.handoffs !== 1 ? 's' : ''}`}
          accent={brain.totals.sessions > 0 ? 'green' : 'gray'}
        />
        <StatCard
          label="Memory facts"
          value={brain.totals.memory}
          sub="cross-repo atoms"
          accent={brain.totals.memory > 0 ? 'purple' : 'gray'}
        />
        <StatCard
          label="Open stashes"
          value={brain.stashes.length}
          sub={`branch: ${brain.branch ?? 'main'}`}
          accent={brain.stashes.length > 0 ? 'yellow' : 'gray'}
        />
      </div>

      {tab === 'overview' && (
        <>
          {health && <HealthCard health={health} />}
          {hosted && <HostedBrainCard info={hosted} />}
          <OverviewTab brain={brain} />
        </>
      )}
      {tab === 'atoms' && <AtomsTab atoms={brain.atoms} truncated={brain.atomsTruncated} />}
      {tab === 'search' && <BrainSearch />}
      {tab === 'stashes' && <StashesTab stashes={brain.stashes} />}
      {tab === 'provenance' && <ProvenanceTab provenance={brain.provenance} />}
    </div>
  );
}

function OverviewTab({ brain }: { brain: NonNullable<Awaited<ReturnType<typeof fetchBrainExplore>>> }) {
  return (
    <>
      <Card title="Namespaces" meta={`${brain.namespaces.length} repo${brain.namespaces.length !== 1 ? 's' : ''}`}>
        {brain.namespaces.length === 0 ? (
          <EmptyState>No repo namespaces yet.</EmptyState>
        ) : (
          <table className="card-table w-full text-sm">
            <THead cols={[
              { label: 'Namespace' },
              { label: 'Sessions', align: 'right' },
              { label: 'Handoffs', align: 'right' },
              { label: 'Compiled', align: 'right' },
            ]} />
            <tbody className="divide-y divide-zinc-800/50">
              {brain.namespaces.map((n) => (
                <tr key={n.name} className="hover:bg-zinc-800/30 transition-colors">
                  <td className="px-4 py-2.5 font-mono text-xs text-zinc-300">{n.name}</td>
                  <td className="px-4 py-2.5 text-right text-zinc-300 font-mono">{n.sessions}</td>
                  <td className="px-4 py-2.5 text-right text-zinc-300 font-mono">{n.handoffs}</td>
                  <td className="px-4 py-2.5 text-right text-xs text-zinc-500">
                    {[n.hasBrief && 'brief', n.hasWorking && 'working'].filter(Boolean).join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Branches" meta={`${brain.branches.sessions.length + brain.branches.ideas.length} open`}>
          {brain.branches.sessions.length === 0 && brain.branches.ideas.length === 0 ? (
            <EmptyState>No open session or idea branches.</EmptyState>
          ) : (
            <div className="p-4 space-y-3">
              {brain.branches.ideas.length > 0 && (
                <div>
                  <p className="text-[11px] text-zinc-500 uppercase tracking-wider mb-1.5">Idea (long-lived)</p>
                  <div className="flex flex-wrap gap-1.5">
                    {brain.branches.ideas.map((b) => (
                      <Badge key={b} className="bg-cyan-500/15 text-cyan-400 border-cyan-500/30 font-mono">{b}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {brain.branches.sessions.length > 0 && (
                <div>
                  <p className="text-[11px] text-zinc-500 uppercase tracking-wider mb-1.5">Session (in-flight)</p>
                  <div className="flex flex-wrap gap-1.5">
                    {brain.branches.sessions.map((b) => (
                      <Badge key={b} className="bg-blue-500/15 text-blue-400 border-blue-500/30 font-mono">{b}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>

        <Card title="Recent commits" meta={brain.lastCommit ?? ''}>
          {brain.recentCommits.length === 0 ? (
            <EmptyState>No commits.</EmptyState>
          ) : (
            <ul className="divide-y divide-zinc-800/50">
              {brain.recentCommits.map((c) => (
                <li key={c.sha} className="px-4 py-2.5 flex items-start gap-3 text-sm hover:bg-zinc-800/30 transition-colors">
                  <span className="font-mono text-xs text-zinc-500 shrink-0">{c.short}</span>
                  <span className="text-zinc-300 min-w-0 truncate">{c.subject}</span>
                  <span className="ml-auto text-[11px] text-zinc-600 shrink-0">
                    {c.date ? new Date(c.date).toLocaleDateString() : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function AtomsTab({ atoms, truncated }: { atoms: BrainAtomMeta[]; truncated: boolean }) {
  return (
    <Card
      title="Atoms"
      meta={`${atoms.length} shown, newest first${truncated ? ' (capped)' : ''}`}
    >
      {atoms.length === 0 ? (
        <EmptyState>No atoms written yet. Sessions, handoffs and memory facts appear here as they&apos;re committed.</EmptyState>
      ) : (
        <table className="card-table w-full text-sm">
          <THead cols={[
            { label: 'Kind' },
            { label: 'Repo' },
            { label: 'Slug' },
            { label: 'Provenance' },
            { label: 'Host' },
            { label: 'Written', align: 'right' },
          ]} />
          <tbody className="divide-y divide-zinc-800/50">
            {atoms.map((a) => (
              <tr key={a.path} className="hover:bg-zinc-800/30 transition-colors align-top">
                <td className="px-4 py-2.5"><KindBadge kind={a.kind} /></td>
                <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">{a.repo || <span className="text-zinc-600">(cross-repo)</span>}</td>
                <td className="px-4 py-2.5 text-zinc-300">
                  {a.slug}
                  <span className="block font-mono text-[10px] text-zinc-600">{a.sha8}</span>
                </td>
                <td className="px-4 py-2.5 text-xs">
                  {a.code ? (
                    <span className="font-mono text-[11px] text-orange-400/90">
                      {a.code.branch ?? ''}{a.code.sha ? `@${a.code.sha.slice(0, 7)}` : ''}
                      {a.code.commits.length ? ` · ${a.code.commits.length} commit${a.code.commits.length !== 1 ? 's' : ''}` : ''}
                    </span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-zinc-500">{a.host || '—'}</td>
                <td className="px-4 py-2.5 text-right text-[11px] text-zinc-500 whitespace-nowrap">{formatBrainStamp(a.written)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function StashesTab({ stashes }: { stashes: import('@/lib/brain').BrainStashDetail[] }) {
  return (
    <Card title="Stashes" meta={`${stashes.length} frozen on main`} accent={stashes.length > 0 ? 'purple' : undefined}>
      {stashes.length === 0 ? (
        <EmptyState>No open stashes. A stash freezes a context payload on <code>main</code> so any later session can <code>brain pop</code> it.</EmptyState>
      ) : (
        <ul className="divide-y divide-zinc-800/50">
          {stashes.map((s) => (
            <li key={s.path} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="font-medium text-zinc-200">{s.slug}</span>
                {s.repo && <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30 font-mono text-[10px]">{s.repo}</Badge>}
                {s.from && <span className="text-[11px] text-zinc-500 font-mono">from {s.from}</span>}
                <span className="ml-auto text-[11px] text-zinc-600">{formatBrainStamp(s.written)}</span>
              </div>
              {s.preview && (
                <p className="text-xs text-zinc-400 whitespace-pre-wrap line-clamp-3 font-mono bg-zinc-950/40 rounded p-2 border border-zinc-800/60">
                  {s.preview}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ProvenanceTab({ provenance }: { provenance: import('@/lib/brain').BrainBlameEntry[] }) {
  return (
    <Card
      title="Code ↔ memory provenance"
      meta={`${provenance.length} link${provenance.length !== 1 ? 's' : ''} on HEAD`}
      accent={provenance.length > 0 ? 'emerald' : undefined}
    >
      {provenance.length === 0 ? (
        <EmptyState>
          No provenance-stamped commits on HEAD. Atoms written with <code>code_*</code> provenance
          (which code branch / SHA / commits they&apos;re about) link back here.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-zinc-800/50">
          {provenance.map((e) => (
            <li key={e.sha} className="px-4 py-3 space-y-1.5">
              <div className="flex items-start gap-3">
                <span className="font-mono text-xs text-zinc-500 shrink-0">{e.short}</span>
                <span className="text-sm text-zinc-300 min-w-0">{e.subject}</span>
                <span className="ml-auto text-[11px] text-zinc-600 shrink-0">
                  {e.date ? new Date(e.date).toLocaleDateString() : ''}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 pl-8 text-[11px] font-mono">
                {e.code.repo && <span className="text-zinc-400">{e.code.repo}</span>}
                {e.code.branch && <span className="text-orange-400/90">{e.code.branch}</span>}
                {e.code.sha && <span className="text-emerald-400/90">@{e.code.sha.slice(0, 7)}</span>}
                {e.code.commits.map((c) => (
                  <span key={c} className="text-zinc-500 bg-zinc-800/50 rounded px-1.5 py-0.5">{c.slice(0, 7)}</span>
                ))}
              </div>
              {e.atoms.length > 0 && (
                <div className="pl-8 text-[11px] text-zinc-600 font-mono truncate">
                  {e.atoms.map((a) => a.split('/').pop()).join(' · ')}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
