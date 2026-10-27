// /brain — the git-versioned agent-memory explorer. Read-only, tenant-scoped:
// browse the brain's namespaces, atoms (sessions / handoffs / cross-repo
// memory), open stashes, session/idea branches, recent commits, and the
// code↔memory provenance recorded on HEAD. Sources everything from the gateway
// `brain_explore` tool in one pass — never checks out, merges, or writes.

import Link from 'next/link';
import { StatCard, Card, EmptyState } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/ui/data-table';
import { GATEWAY_URL } from '@/lib/gateway';
import { connectDB, RepoCard } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { getRegistryCounts } from '@/lib/registry-cache';
import { timeAgo } from '@/lib/format';
import {
  fetchBrainExplore, fetchBrainHealth, fetchBanditStats, fetchRouterTrainReadiness, formatBrainStamp, parseBrainStamp,
  type BrainAtomMeta, type BrainHealth, type BrainSection, type BanditStats, type RouterTrainReadiness, type BrainExplore,
} from '@/lib/brain';
import {
  fetchHostedBrainInfo,
  quotaUsage,
  upgradeCta,
  formatBytes,
  capLabel,
  planLabel,
  shouldShowSyncUpsell,
  syncUpsellCopy,
  type HostedBrainInfo,
  type QuotaLevel,
} from '@/lib/hosted-brain';
import { HostedBrainUpgrade } from '@/components/hosted-brain-upgrade';
import { HostedBrainProvision } from '@/components/hosted-brain-provision';
import AskBrain from '@/components/brain/ask-brain';
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
    return <p className="text-xs text-[rgb(var(--text-muted))]">Not enough recorded snapshots yet for a trend.</p>;
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
      <span className="text-xs text-[rgb(var(--text-muted))]">{history.length} recorded point{history.length !== 1 ? 's' : ''}</span>
    </div>
  );
}

/** Shared formatter for the W5.3 capture-coverage signal — "n/a" below the
 *  minimum sample size mirrors the composite's own gating (runtime
 *  MIN_CAPTURE_COVERAGE_SAMPLE) so the dashboard never shows a number the
 *  score itself declined to score. */
function captureRateLabel(health: BrainHealth): string {
  const { captureCoverage, captureCoverageSampleSize } = health.signals;
  if (captureCoverage === null || captureCoverage === undefined) return 'n/a';
  const sample = captureCoverageSampleSize ?? 0;
  return `${Math.round(captureCoverage * 100)}% (${sample} session${sample !== 1 ? 's' : ''})`;
}

function HealthCard({ health }: { health: BrainHealth }) {
  const style = GRADE_STYLE[health.grade];
  const { signals, subscores } = health;
  return (
    <Card title="Brain health" meta={`updated ${new Date(health.computedAt).toLocaleString()}`} accent={style.accent}>
      <div className="p-4 flex flex-col md:flex-row md:items-center gap-6">
        <div className="flex items-baseline gap-2">
          <span className={`text-4xl font-bold ${style.text}`}>{health.score}</span>
          <span className="text-[rgb(var(--text-muted))] text-sm">/100</span>
          <Badge className={KIND_BADGE.memory}>{health.grade}</Badge>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 text-xs flex-1">
          <div>
            <dt className="text-[rgb(var(--text-muted))]">Freshness</dt>
            <dd className="text-[rgb(var(--text-primary))] font-mono">{signals.freshnessDays === null ? 'n/a' : `${signals.freshnessDays.toFixed(1)}d`} ({subscores.freshness})</dd>
          </div>
          <div>
            <dt className="text-[rgb(var(--text-muted))]">Coverage</dt>
            <dd className="text-[rgb(var(--text-primary))] font-mono">{signals.coverageGaps}/{signals.namespaceTotal} gaps ({subscores.coverage})</dd>
          </div>
          <div>
            <dt className="text-[rgb(var(--text-muted))]">Contradictions</dt>
            <dd className="text-[rgb(var(--text-primary))] font-mono">{signals.contradictionCount}/{signals.contradictionWindowDays}d ({subscores.contradictions})</dd>
          </div>
          <div>
            <dt className="text-[rgb(var(--text-muted))]">Recall hit-rate</dt>
            <dd className="text-[rgb(var(--text-primary))] font-mono">{signals.recallHitRate === null ? 'n/a' : `${Math.round(signals.recallHitRate * 100)}%`}{subscores.recall !== null && ` (${subscores.recall})`}</dd>
          </div>
          <div>
            <dt className="text-[rgb(var(--text-muted))]">Capture rate</dt>
            <dd className="text-[rgb(var(--text-primary))] font-mono">
              {captureRateLabel(health)}
              {subscores.captureCoverage !== null && subscores.captureCoverage !== undefined && ` (${subscores.captureCoverage})`}
            </dd>
          </div>
        </dl>
        <div>
          <p className="text-xs text-[rgb(var(--text-muted))] mb-1">Trend</p>
          <HealthTrend history={health.history} />
        </div>
      </div>
    </Card>
  );
}

/** Compact, friendly health summary for the primary Brain page (phase 5b) —
 *  same score the Advanced tab's detailed HealthCard computes, plus the one
 *  capture-rate sentence, in plain language. Lives one screen away from the
 *  ask box rather than behind the Advanced tab, per the tech handoff's "one
 *  ask/search page" brief. Detail (freshness/coverage/contradictions/recall
 *  breakdown, trend chart) stays a tap away under Advanced — this card is the
 *  headline, not the explorer. */
function MemoryHealthSummary({ health }: { health: BrainHealth | null }) {
  if (!health) {
    return (
      <Card title="Memory health">
        <EmptyState>Health hasn&apos;t been measured yet.</EmptyState>
      </Card>
    );
  }
  const style = GRADE_STYLE[health.grade];
  const { captureCoverage, captureCoverageSampleSize, captureCoverageWindowDays } = health.signals;
  const captureCopy = captureCoverage === null || captureCoverage === undefined
    ? "Not enough recent sessions yet to tell how reliably it's capturing."
    : `Captured ${Math.round(captureCoverage * 100)}% of sessions over the last ${captureCoverageWindowDays ?? 7} days (${captureCoverageSampleSize ?? 0} observed).`;

  return (
    <Card title="Memory health" meta={`updated ${timeAgo(new Date(health.computedAt))}`} accent={style.accent}>
      <div className="p-4 flex flex-col sm:flex-row sm:items-center gap-5">
        <div className="flex items-baseline gap-2 shrink-0">
          <span className={`text-4xl font-bold ${style.text}`}>{health.score}</span>
          <span className="text-[rgb(var(--text-muted))] text-sm">/100</span>
          <Badge className={KIND_BADGE.memory}>{health.grade}</Badge>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-[rgb(var(--text-secondary))]">{captureCopy}</p>
          <Link href="/brain?tab=advanced" className="mt-1 inline-block text-xs text-teal-400 hover:underline">
            See freshness, coverage, contradictions & recall detail
          </Link>
        </div>
      </div>
    </Card>
  );
}

// ── Retrieval strategy (BRAIN B-7 follow-up, task-49fda69b) ─────────────────
// scripts/brain_route.py threads retrieval_bandit.py's recommended retrieval
// config (k, rerank on/off) into the live retrieval loop per query context
// (commit 49a99aa) — but that wiring was CLI/scripts-only, with no way for an
// operator to see which strategy the bandit currently favors without reading
// raw bandit_arms rows. This card surfaces the gateway's read-only snapshot
// (brain_bandit_stats -> retrieval_bandit.py --summary).

function formatArm(arm: { k: number; rerank_on: boolean } | null): string {
  if (!arm) return 'no data yet';
  return `k=${arm.k}, rerank ${arm.rerank_on ? 'on' : 'off'}`;
}

export function RetrievalStrategyCard({ stats }: { stats: BanditStats }) {
  if (!stats.available || stats.contexts.length === 0) {
    return (
      <Card title="Retrieval strategy" meta="bandit-tuned config">
        <EmptyState>
          No bandit data yet. Populated by <code>retrieval_bandit.py</code> replaying
          harvested traces, then read live by <code>brain_route.py</code>.
        </EmptyState>
      </Card>
    );
  }

  return (
    <DataTable
      title="Retrieval strategy"
      meta={`${stats.totalPulls} recorded pull${stats.totalPulls !== 1 ? 's' : ''} across ${stats.contexts.length} context${stats.contexts.length !== 1 ? 's' : ''}`}
      searchable={false}
      defaultSort="pulls"
      defaultDesc
      columns={[
        { label: 'Context', mobile: 'title' },
        { label: 'Favored config', mobile: 'badge' },
        { label: 'Mean reward', align: 'right', sortKey: 'reward', mobile: 'meta' },
        { label: 'Pulls', align: 'right', sortKey: 'pulls', mobile: 'meta' },
      ]}
      rows={stats.contexts.map((c) => {
        const favoredMean = c.arms.find(
          (a) => c.favoredArm && a.k === c.favoredArm.k && a.rerankOn === c.favoredArm.rerank_on,
        )?.meanReward;
        return {
          id: c.context,
          search: c.context.toLowerCase(),
          sort: { reward: favoredMean ?? -1, pulls: c.pullsTotal },
          cells: [
            <span key="ctx" className="font-mono text-xs text-[rgb(var(--text-primary))]">{c.context}</span>,
            <Badge key="arm" className={KIND_BADGE.session}>{formatArm(c.favoredArm)}</Badge>,
            <span key="rw" className="font-mono text-[rgb(var(--text-secondary))]">{favoredMean === undefined ? '—' : favoredMean.toFixed(3)}</span>,
            <span key="pl" className="font-mono text-[rgb(var(--text-secondary))]">{c.pullsTotal}</span>,
          ],
        };
      })}
    />
  );
}

// ── Router-training readiness (BRAIN B-7.1, task-7fdc970b) ──────────────────
// scripts/brain_router_train_ready.py gates LoRA router training on >=500
// labeled traces — but checking progress meant running that script by hand.
// This card surfaces the gateway's read-only report (brain_router_train_readiness):
// traces banked vs the floor, ingestion rate, and ETA at the current rate.

function formatEta(readiness: RouterTrainReadiness): string {
  if (readiness.ready) return 'floor met';
  if (readiness.etaDays === null) return 'unknown — no recent ingestion';
  const days = Math.ceil(readiness.etaDays);
  const when = readiness.estimatedReadyAt ? ` (~${new Date(readiness.estimatedReadyAt).toLocaleDateString()})` : '';
  return `~${days} day${days !== 1 ? 's' : ''}${when}`;
}

export function RouterTrainReadinessCard({ readiness }: { readiness: RouterTrainReadiness }) {
  if (!readiness.available) {
    return (
      <Card title="Router training readiness" meta="B-7.1 LoRA gate">
        <EmptyState>
          No trace store yet. Labeled traces bank in <code>route_eval</code> as{' '}
          <code>brain_route.py</code> dispatches resolve a clear top-1; readiness is
          reported by <code>brain_router_train_ready.py</code>.
        </EmptyState>
      </Card>
    );
  }

  const pct = Math.min(100, Math.round((readiness.traceCount / readiness.minTracesRequired) * 100));
  return (
    <Card
      title="Router training readiness"
      meta={readiness.ready ? 'trace floor met — training stays manual' : `${readiness.tracesRemaining} traces to go`}
      accent={readiness.ready ? 'emerald' : 'blue'}
    >
      <div className="p-4 space-y-4">
        <div>
          <div className="flex items-baseline justify-between mb-1.5 text-sm">
            <span className="text-[rgb(var(--text-secondary))]">Labeled traces banked</span>
            <span className="font-mono text-[rgb(var(--text-primary))]">
              {readiness.traceCount}
              <span className="text-[rgb(var(--text-muted))]"> / {readiness.minTracesRequired}</span>
              <span className="text-[rgb(var(--text-muted))]"> · {pct}%</span>
            </span>
          </div>
          <div
            className="h-2.5 bg-[rgb(var(--bg-page))] rounded-full overflow-hidden"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Labeled router-training traces banked toward the training floor"
          >
            <div
              className={`h-full rounded-full transition-all ${readiness.ready ? 'bg-emerald-500' : 'bg-blue-500'}`}
              style={{ width: `${Math.max(pct, 2)}%` }}
            />
          </div>
        </div>

        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
          <div>
            <dt className="text-[rgb(var(--text-muted))]">Live (route_eval)</dt>
            <dd className="text-[rgb(var(--text-primary))] font-mono">{readiness.sources.liveRouteEvalLabeled}</dd>
          </div>
          <div>
            <dt className="text-[rgb(var(--text-muted))]">Harvested (spike)</dt>
            <dd className="text-[rgb(var(--text-primary))] font-mono">{readiness.sources.harvestedSpikeLabeled}</dd>
          </div>
          <div>
            <dt className="text-[rgb(var(--text-muted))]">Ingestion ({readiness.ingestion.windowDays}d)</dt>
            <dd className="text-[rgb(var(--text-primary))] font-mono">
              {readiness.ingestion.recentLabeled} (~{readiness.ingestion.perDay.toFixed(1)}/day)
            </dd>
          </div>
          <div>
            <dt className="text-[rgb(var(--text-muted))]">ETA to floor</dt>
            <dd className={`font-mono ${readiness.ready ? 'text-emerald-400' : 'text-[rgb(var(--text-primary))]'}`}>
              {formatEta(readiness)}
            </dd>
          </div>
        </dl>

        <p className="text-xs text-[rgb(var(--text-muted))]">{readiness.trainingStatus}</p>
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
      <div className="p-6 text-sm text-[rgb(var(--text-secondary))] space-y-3">
        <p>Neither the gateway nor a configured git remote returned a brain snapshot.</p>
        {GATEWAY_URL_IS_DEFAULT ? (
          <p className="text-xs text-[rgb(var(--text-muted))]">
            No <code className="text-[rgb(var(--text-secondary))]">GATEWAY_MCP_URL</code> is configured on this deployment, so
            it&apos;s still pointed at the Docker-internal default (<code className="text-[rgb(var(--text-secondary))]">gateway:3100</code>)
            — that host only resolves inside a local <code className="text-[rgb(var(--text-secondary))]">docker compose</code> network,
            never from Vercel or any other remote host. The brain is a real git repo on whichever machine runs the
            gateway (<code className="text-[rgb(var(--text-secondary))]">~/.myai/brain</code>) — it already has its own <code className="text-[rgb(var(--text-secondary))]">origin</code> remote,
            so a remote dashboard can read it straight from there without the gateway: set{' '}
            <code className="text-[rgb(var(--text-secondary))]">BRAIN_GIT_REMOTE</code> to that remote&apos;s URL (the same value{' '}
            <code className="text-[rgb(var(--text-secondary))]">git -C ~/.myai/brain remote get-url origin</code> prints — currently
            only GitHub remotes are supported), plus <code className="text-[rgb(var(--text-secondary))]">BRAIN_GIT_TOKEN</code> for a
            private repo. Alternatively, point <code className="text-[rgb(var(--text-secondary))]">GATEWAY_MCP_URL</code> (+{' '}
            <code className="text-[rgb(var(--text-secondary))]">GATEWAY_LOCAL_TOKEN</code> if the gateway enforces tenancy) at a
            publicly reachable gateway, or provision the hosted-brain remote (ADR-017) as a synced, tenant-scoped
            store instead. See <code className="text-[rgb(var(--text-secondary))]">documentation/BRAIN_DASHBOARD.md</code>.
          </p>
        ) : (
          <p className="text-xs text-[rgb(var(--text-muted))]">
            The brain is git-versioned agent memory, normally served by the myai gateway
            (<code className="text-[rgb(var(--text-secondary))]">brain_explore</code> MCP tool). If the gateway is
            reachable but this persists, it may be running an image built before this tool
            shipped — rebuild the gateway from the master checkout. A{' '}
            <code className="text-[rgb(var(--text-secondary))]">BRAIN_GIT_REMOTE</code> git-remote fallback is also available
            (see <code className="text-[rgb(var(--text-secondary))]">documentation/BRAIN_DASHBOARD.md</code>) if the repo/branch it
            points at is unreachable or the configured token lacks access.
          </p>
        )}
      </div>
    </Card>
  );
}

function NotInitialized() {
  return (
    <Card title="No brain store yet">
      <div className="p-6 text-sm text-[rgb(var(--text-secondary))] space-y-2">
        <p>This tenant has no brain repo initialised.</p>
        <p className="text-xs text-[rgb(var(--text-muted))]">
          Run <code className="text-[rgb(var(--text-secondary))]">myai brain init</code> (or complete a{' '}
          <code className="text-[rgb(var(--text-secondary))]">wrap up</code>, which merges a session atom into the
          brain) to create the store. Sessions = commits, wrap up = merge, <code className="text-[rgb(var(--text-secondary))]">main</code> ={' '}
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

function HostedBrainCard({ info, hasBrainActivity }: { info: HostedBrainInfo; hasBrainActivity: boolean }) {
  // Not provisioned — describe the opt-in upsell; self-host stays the default.
  if (!info.provisioned) {
    const showUpsell = shouldShowSyncUpsell({ plan: info.plan, hasBrainActivity });
    const upsell = showUpsell ? syncUpsellCopy() : null;
    return (
      <Card title="Hosted brain" meta="not provisioned">
        <div className="p-6 text-sm text-[rgb(var(--text-secondary))] space-y-2">
          <p>
            No managed brain remote for this tenant. The <strong className="text-[rgb(var(--text-primary))]">hosted brain</strong>{' '}
            is a gateway-served, tenant-scoped git remote your brain pushes to — turnkey cross-device
            continuity for anyone who won&apos;t self-host git (ADR-017).
          </p>
          <p className="text-xs text-[rgb(var(--text-muted))]">
            An opt-in Pro/Team upsell — self-hosting stays the default (your brain is your own git repo in
            every tier). Provision it with <code className="text-[rgb(var(--text-secondary))]">brain host provision</code> once your
            plan includes it.
          </p>
          {upsell && (
            <div
              data-testid="hosted-brain-sync-upsell"
              className="mt-3 rounded-lg border border-teal-500/40 bg-teal-500/10 px-3.5 py-3 flex flex-col sm:flex-row sm:items-center gap-3"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-teal-200">{upsell.headline}</p>
                <p className="text-xs mt-0.5 text-teal-300/70">{upsell.body}</p>
              </div>
              <HostedBrainUpgrade nextPlan="solo" over={false} />
            </div>
          )}
          <HostedBrainProvision provisioned={false} />
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
            <span className="text-[rgb(var(--text-secondary))]">Storage used</span>
            <span className="font-mono text-[rgb(var(--text-primary))]">
              {usedLabel}
              <span className="text-[rgb(var(--text-muted))]"> / {limitLabel}</span>
              {!usage.unlimited && <span className="text-[rgb(var(--text-muted))]"> · {usage.percent}%</span>}
            </span>
          </div>
          <div
            className="h-2.5 bg-[rgb(var(--bg-page))] rounded-full overflow-hidden"
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
            <p className="mt-1.5 text-xs text-[rgb(var(--text-muted))]">Unlimited storage on {planLabel(info.plan)} — no cap.</p>
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
              <dt className="text-[rgb(var(--text-muted))] uppercase tracking-wider text-label">Remote</dt>
              <dd className="font-mono text-[rgb(var(--text-primary))] truncate">{info.remoteUrl}</dd>
            </div>
          )}
          <div>
            <dt className="text-[rgb(var(--text-muted))] uppercase tracking-wider text-label">Provisioned</dt>
            <dd className="text-[rgb(var(--text-primary))]">{info.createdAt ? new Date(info.createdAt).toLocaleDateString() : '—'}</dd>
          </div>
          <div>
            <dt className="text-[rgb(var(--text-muted))] uppercase tracking-wider text-label">Token rotated</dt>
            <dd className="text-[rgb(var(--text-primary))]">{info.rotatedAt ? new Date(info.rotatedAt).toLocaleDateString() : '—'}</dd>
          </div>
        </dl>

        <HostedBrainProvision provisioned={true} />
      </div>
    </Card>
  );
}

// The primary view (`overview`) is the product's visual signature — a hero
// memory count, a plain-language ask box, a stat row, and a recently-learned
// feed. It must read as "what myAI knows", never as a database explorer:
// no vector embeddings / corpus / atoms / handoffs / recall traces anywhere
// in this section. Everything store-internal (namespaces, health scoring,
// retrieval tuning, raw atom/stash/provenance browsing) lives one tap away
// under the `advanced` tab and its sub-views.
const ADVANCED_SUBTABS = ['advanced', 'atoms', 'search', 'stashes', 'provenance'] as const;
type AdvancedSubtab = (typeof ADVANCED_SUBTABS)[number];
function isAdvancedSubtab(tab: string): tab is AdvancedSubtab {
  return (ADVANCED_SUBTABS as readonly string[]).includes(tab);
}

// Each advanced sub-view renders exactly one heavy section (nothing else needs
// more than the always-available counts). The primary view needs the atom
// list (for the feed) and the provenance links (for each entry's recall
// count) — both already computed for the Atoms/Provenance sub-views, so this
// doesn't add a new read path, just reuses it on the page most people land on.
const TAB_SECTIONS: Record<string, BrainSection[]> = {
  overview: ['atoms', 'provenance'],
  advanced: [],
  atoms: ['atoms'],
  search: [],
  stashes: ['stashes'],
  provenance: ['provenance'],
};

const KNOWN_TYPE: Record<BrainAtomMeta['kind'], { label: string; badge: string }> = {
  session: { label: 'Update', badge: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
  handoff: { label: 'Decision', badge: 'bg-purple-500/15 text-purple-400 border-purple-500/30' },
  memory: { label: 'Fact', badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
};

/** How many times a later commit's provenance link points back at this atom —
 *  the honest, already-computed stand-in for "how often you've drawn on this". */
function buildRecallCounts(provenance: BrainExplore['provenance']): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of provenance) {
    for (const ref of entry.atoms) {
      const key = ref.split('/').pop() ?? ref;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

async function fetchKnownStats(): Promise<{ repos: number; skills: number; agents: number }> {
  let repos = 0;
  try {
    await connectDB();
    const tenantId = await getActiveTenant();
    repos = await RepoCard.countDocuments(tenantFilter(tenantId));
  } catch {
    repos = 0;
  }
  const registry = await getRegistryCounts();
  return { repos, skills: registry.skills, agents: registry.agents };
}

function MemoryCore({ count }: { count: number }) {
  return (
    <div className="relative flex flex-col items-center justify-center py-6">
      <div
        aria-hidden="true"
        className="absolute h-36 w-36 animate-pulse rounded-full bg-gradient-to-br from-fuchsia-500/30 via-blue-500/25 to-teal-400/20 blur-2xl"
      />
      <div
        aria-hidden="true"
        className="absolute h-20 w-20 rounded-full bg-gradient-to-br from-fuchsia-400/40 to-blue-400/30 blur-xl [animation:pulse_3s_ease-in-out_infinite]"
      />
      <div className="relative text-center">
        <p className="text-4xl font-bold tabular-nums text-[rgb(var(--text-primary))] sm:text-5xl">{count.toLocaleString()}</p>
        <p className="mt-1 text-sm text-[rgb(var(--text-muted))]">memories</p>
      </div>
    </div>
  );
}

function KnownStatsRow({ repos, skills, agents, decisions }: { repos: number; skills: number; agents: number; decisions: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard label="Repos" value={repos} icon="fleet" tone={repos > 0 ? 'ok' : 'muted'} />
      <StatCard label="Skills" value={skills} icon="apps" tone={skills > 0 ? 'ok' : 'muted'} />
      <StatCard label="Agents" value={agents} icon="swarm" tone={agents > 0 ? 'ok' : 'muted'} />
      <StatCard label="Decisions" value={decisions} icon="audit" tone={decisions > 0 ? 'ok' : 'muted'} />
    </div>
  );
}

function RecentlyLearnedFeed({ atoms, recallCounts }: { atoms: BrainAtomMeta[]; recallCounts: Map<string, number> }) {
  const recent = [...atoms]
    .sort((a, b) => (b.written ?? '').localeCompare(a.written ?? ''))
    .slice(0, 8);

  return (
    <Card title="Recently learned">
      {recent.length === 0 ? (
        <EmptyState>Nothing learned yet — it fills in as your AI works and you talk to it.</EmptyState>
      ) : (
        <ul className="divide-y divide-[rgb(var(--border-subtle))]/50">
          {recent.map((a) => {
            const type = KNOWN_TYPE[a.kind] ?? KNOWN_TYPE.memory;
            const recalls = recallCounts.get(a.file) ?? 0;
            const when = parseBrainStamp(a.written);
            return (
              <li key={a.path} className="flex items-start gap-3 px-4 py-3">
                <Badge className={`${type.badge} shrink-0`}>{type.label}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-[rgb(var(--text-primary))]">{a.slug.replace(/[-_]/g, ' ')}</p>
                  <p className="mt-0.5 text-xs text-[rgb(var(--text-muted))]">
                    {a.repo || 'General'} · {when ? timeAgo(when) : '—'} · used {recalls}×
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function KnownView({
  brain,
  stats,
  health,
}: {
  brain: BrainExplore;
  stats: { repos: number; skills: number; agents: number };
  health: BrainHealth | null;
}) {
  const totalMemories = brain.totals.sessions + brain.totals.handoffs + brain.totals.memory;
  const recallCounts = buildRecallCounts(brain.provenance);

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <AskBrain />
      <MemoryHealthSummary health={health} />
      <MemoryCore count={totalMemories} />
      <KnownStatsRow repos={stats.repos} skills={stats.skills} agents={stats.agents} decisions={brain.totals.handoffs} />
      <RecentlyLearnedFeed atoms={brain.atoms} recallCounts={recallCounts} />
      <p className="text-center text-xs text-[rgb(var(--text-muted))]">
        Want to inspect the store directly? <Link href="/brain?tab=advanced" className="text-teal-400 hover:underline">Open Advanced</Link>.
      </p>
    </div>
  );
}

// ── Advanced (store-internal) ───────────────────────────────────────────────
// Everything below is the pre-existing explorer UI, unreachable except by
// deliberately opening Advanced (or a direct deep link from global search /
// the command palette, which still point at these same tab ids).

const ADVANCED_SUBNAV: { id: AdvancedSubtab; label: string }[] = [
  { id: 'advanced', label: 'Store overview' },
  { id: 'atoms', label: 'Atoms' },
  { id: 'search', label: 'Corpus search' },
  { id: 'stashes', label: 'Stashes' },
  { id: 'provenance', label: 'Provenance' },
];

function AdvancedSubNav({ active }: { active: AdvancedSubtab }) {
  return (
    <div className="flex flex-wrap gap-1.5 text-xs">
      {ADVANCED_SUBNAV.map((s) => (
        <Link
          key={s.id}
          href={`/brain?tab=${s.id}`}
          className={`rounded-full px-3 py-1.5 transition-colors ${
            s.id === active
              ? 'bg-teal-500/15 text-teal-300'
              : 'bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))]'
          }`}
        >
          {s.label}
        </Link>
      ))}
    </div>
  );
}

export default async function BrainView({ tab }: { tab: string }) {
  const resolvedTab = isAdvancedSubtab(tab) ? tab : 'overview';
  const advancedTab = resolvedTab === 'overview' ? null : resolvedTab;

  // Health is fetched for both the primary page (MemoryHealthSummary) and
  // Advanced (HealthCard) — phase 5b consolidates health score + capture rate
  // onto the one ask/search page instead of hiding them behind a tab.
  const [brain, hosted, health, bandit, routerReadiness, knownStats] = await Promise.all([
    fetchBrainExplore(TAB_SECTIONS[resolvedTab] ?? []),
    fetchHostedBrainInfo(),
    advancedTab === 'advanced' || advancedTab === null ? fetchBrainHealth() : Promise.resolve(null),
    advancedTab === 'advanced' ? fetchBanditStats() : Promise.resolve(null),
    advancedTab === 'advanced' ? fetchRouterTrainReadiness() : Promise.resolve(null),
    advancedTab === null ? fetchKnownStats() : Promise.resolve(null),
  ]);
  if (!brain) return <GatewayDown />;
  if (!brain.initialized) return <NotInitialized />;

  if (advancedTab === null) {
    return <KnownView brain={brain} stats={knownStats!} health={health} />;
  }

  return (
    <div className="space-y-8">
      <AdvancedSubNav active={advancedTab} />

      {/* Header stats — every advanced sub-view. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Namespaces"
          value={brain.totals.namespaces}
          sub={brain.namespaces.map((n) => n.name).slice(0, 3).join(', ') || 'none'}
          icon="registry"
          tone={brain.totals.namespaces > 0 ? 'ok' : 'muted'}
        />
        <StatCard
          label="Session atoms"
          value={brain.totals.sessions}
          sub={`${brain.totals.handoffs} handoff atom${brain.totals.handoffs !== 1 ? 's' : ''}`}
          icon="sessions"
          tone={brain.totals.sessions > 0 ? 'ok' : 'muted'}
        />
        <StatCard
          label="Memory facts"
          value={brain.totals.memory}
          sub="cross-repo atoms"
          icon="memory"
          tone={brain.totals.memory > 0 ? 'ok' : 'muted'}
        />
        <StatCard
          label="Open stashes"
          value={brain.stashes.length}
          sub={`branch: ${brain.branch ?? 'main'}`}
          icon="queue"
          tone={brain.stashes.length > 0 ? 'warn' : 'muted'}
        />
      </div>

      {advancedTab === 'advanced' && (
        <>
          {health && <HealthCard health={health} />}
          {bandit && <RetrievalStrategyCard stats={bandit} />}
          {routerReadiness && <RouterTrainReadinessCard readiness={routerReadiness} />}
          {hosted && (
            <HostedBrainCard
              info={hosted}
              hasBrainActivity={brain.totals.sessions > 0 || brain.totals.namespaces > 0}
            />
          )}
          <OverviewTab brain={brain} />
        </>
      )}
      {advancedTab === 'atoms' && <AtomsTab atoms={brain.atoms} truncated={brain.atomsTruncated} />}
      {advancedTab === 'search' && <BrainSearch />}
      {advancedTab === 'stashes' && <StashesTab stashes={brain.stashes} />}
      {advancedTab === 'provenance' && <ProvenanceTab provenance={brain.provenance} />}
    </div>
  );
}

function OverviewTab({ brain }: { brain: NonNullable<Awaited<ReturnType<typeof fetchBrainExplore>>> }) {
  return (
    <>
      <DataTable
        title="Namespaces"
        meta={`${brain.namespaces.length} repo${brain.namespaces.length !== 1 ? 's' : ''}`}
        defaultSort="sessions"
        defaultDesc
        columns={[
          { label: 'Namespace', mobile: 'title' },
          { label: 'Sessions', align: 'right', sortKey: 'sessions', mobile: 'meta' },
          { label: 'Handoffs', align: 'right', sortKey: 'handoffs', mobile: 'meta' },
          { label: 'Compiled', align: 'right', mobile: 'detail' },
        ]}
        searchPlaceholder="Search namespace…"
        emptyText="No repo namespaces yet."
        rows={brain.namespaces.map((n) => ({
          id: n.name,
          search: n.name.toLowerCase(),
          sort: { sessions: n.sessions, handoffs: n.handoffs },
          cells: [
            <span key="n" className="font-mono text-xs text-[rgb(var(--text-primary))]">{n.name}</span>,
            <span key="s" className="text-[rgb(var(--text-primary))] font-mono">{n.sessions}</span>,
            <span key="h" className="text-[rgb(var(--text-primary))] font-mono">{n.handoffs}</span>,
            <span key="c" className="text-xs text-[rgb(var(--text-muted))]">{[n.hasBrief && 'brief', n.hasWorking && 'working'].filter(Boolean).join(' · ') || '—'}</span>,
          ],
        }))}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Branches" meta={`${brain.branches.sessions.length + brain.branches.ideas.length} open`}>
          {brain.branches.sessions.length === 0 && brain.branches.ideas.length === 0 ? (
            <EmptyState>No open session or idea branches.</EmptyState>
          ) : (
            <div className="p-4 space-y-3">
              {brain.branches.ideas.length > 0 && (
                <div>
                  <p className="text-label text-[rgb(var(--text-muted))] uppercase tracking-wider mb-1.5">Idea (long-lived)</p>
                  <div className="flex flex-wrap gap-1.5">
                    {brain.branches.ideas.map((b) => (
                      <Badge key={b} className="bg-cyan-500/15 text-cyan-400 border-cyan-500/30 font-mono">{b}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {brain.branches.sessions.length > 0 && (
                <div>
                  <p className="text-label text-[rgb(var(--text-muted))] uppercase tracking-wider mb-1.5">Session (in-flight)</p>
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
            <ul className="divide-y divide-[rgb(var(--border-subtle))]/50">
              {brain.recentCommits.map((c) => (
                <li key={c.sha} className="px-4 py-2.5 flex items-start gap-3 text-sm hover:bg-[rgb(var(--bg-hover))]/30 transition-colors">
                  <span className="font-mono text-xs text-[rgb(var(--text-muted))] shrink-0">{c.short}</span>
                  <span className="text-[rgb(var(--text-primary))] min-w-0 truncate">{c.subject}</span>
                  <span className="ml-auto text-label text-zinc-600 shrink-0">
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
    <DataTable
      title="Atoms"
      meta={`${atoms.length} shown, newest first${truncated ? ' (capped)' : ''}`}
      defaultSort="written"
      defaultDesc
      columns={[
        { label: 'Kind', mobile: 'badge' },
        { label: 'Repo', mobile: 'meta' },
        { label: 'Slug', mobile: 'title' },
        { label: 'Provenance', mobile: 'detail' },
        { label: 'Host', mobile: 'detail' },
        { label: 'Written', align: 'right', sortKey: 'written', mobile: 'meta' },
      ]}
      searchPlaceholder="Search kind, repo, slug…"
      emptyText="No atoms written yet. Sessions, handoffs and memory facts appear here as they're committed."
      rows={atoms.map((a) => ({
        id: a.path,
        search: `${a.kind} ${a.repo ?? ''} ${a.slug} ${a.host ?? ''}`.toLowerCase(),
        sort: { written: a.written ?? '' },
        cells: [
          <KindBadge key="k" kind={a.kind} />,
          <span key="r" className="font-mono text-xs text-[rgb(var(--text-secondary))]">{a.repo || <span className="text-zinc-600">(cross-repo)</span>}</span>,
          <span key="s" className="text-[rgb(var(--text-primary))]">
            {a.slug}
            <span className="block font-mono text-label text-zinc-600">{a.sha8}</span>
          </span>,
          a.code ? (
            <span key="p" className="font-mono text-label text-orange-400/90">
              {a.code.branch ?? ''}{a.code.sha ? `@${a.code.sha.slice(0, 7)}` : ''}
              {a.code.commits.length ? ` · ${a.code.commits.length} commit${a.code.commits.length !== 1 ? 's' : ''}` : ''}
            </span>
          ) : (
            <span key="p" className="text-zinc-600">—</span>
          ),
          <span key="h" className="font-mono text-label text-[rgb(var(--text-muted))]">{a.host || '—'}</span>,
          <span key="w" className="text-label text-[rgb(var(--text-muted))] whitespace-nowrap">{formatBrainStamp(a.written)}</span>,
        ],
      }))}
    />
  );
}

function StashesTab({ stashes }: { stashes: import('@/lib/brain').BrainStashDetail[] }) {
  return (
    <Card title="Stashes" meta={`${stashes.length} frozen on main`} accent={stashes.length > 0 ? 'purple' : undefined}>
      {stashes.length === 0 ? (
        <EmptyState>No open stashes. A stash freezes a context payload on <code>main</code> so any later session can <code>brain pop</code> it.</EmptyState>
      ) : (
        <ul className="divide-y divide-[rgb(var(--border-subtle))]/50">
          {stashes.map((s) => (
            <li key={s.path} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="font-medium text-[rgb(var(--text-primary))]">{s.slug}</span>
                {s.repo && <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30 font-mono text-label">{s.repo}</Badge>}
                {s.from && <span className="text-label text-[rgb(var(--text-muted))] font-mono">from {s.from}</span>}
                <span className="ml-auto text-label text-zinc-600">{formatBrainStamp(s.written)}</span>
              </div>
              {s.preview && (
                <p className="text-xs text-[rgb(var(--text-secondary))] whitespace-pre-wrap line-clamp-3 font-mono bg-[rgb(var(--bg-page))]/40 rounded p-2 border border-[rgb(var(--border-subtle))]/60">
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
        <ul className="divide-y divide-[rgb(var(--border-subtle))]/50">
          {provenance.map((e) => (
            <li key={e.sha} className="px-4 py-3 space-y-1.5">
              <div className="flex items-start gap-3">
                <span className="font-mono text-xs text-[rgb(var(--text-muted))] shrink-0">{e.short}</span>
                <span className="text-sm text-[rgb(var(--text-primary))] min-w-0">{e.subject}</span>
                <span className="ml-auto text-label text-zinc-600 shrink-0">
                  {e.date ? new Date(e.date).toLocaleDateString() : ''}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 pl-8 text-label font-mono">
                {e.code.repo && <span className="text-[rgb(var(--text-secondary))]">{e.code.repo}</span>}
                {e.code.branch && <span className="text-orange-400/90">{e.code.branch}</span>}
                {e.code.sha && <span className="text-emerald-400/90">@{e.code.sha.slice(0, 7)}</span>}
                {e.code.commits.map((c) => (
                  <span key={c} className="text-[rgb(var(--text-muted))] bg-[rgb(var(--bg-hover))]/50 rounded px-1.5 py-0.5">{c.slice(0, 7)}</span>
                ))}
              </div>
              {e.atoms.length > 0 && (
                <div className="pl-8 text-label text-zinc-600 font-mono truncate">
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
