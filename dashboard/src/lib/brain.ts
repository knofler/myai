// Brain explorer data — mirrors the gateway `brain_explore` tool output
// (runtime/src/core/brain.ts → brainExplore). Read-only, tenant-scoped: the
// gateway resolves the tenant from the local bridge token and serves that
// tenant's brain store only (ADR-010 directory isolation).

import { callGateway } from './gateway';

export interface BrainAtomMeta {
  path: string;
  file: string;
  kind: 'session' | 'handoff' | 'memory';
  repo: string;
  slug: string;
  host: string;
  written: string;
  sha8: string;
  code?: { repo?: string; branch?: string; sha?: string; commits: string[] };
}

export interface BrainNamespaceSummary {
  name: string;
  sessions: number;
  handoffs: number;
  hasBrief: boolean;
  hasWorking: boolean;
}

export interface BrainStashDetail {
  slug: string;
  path: string;
  file: string;
  from?: string;
  repo?: string;
  host?: string;
  written?: string;
  preview: string;
}

export interface BrainLogEntry {
  sha: string;
  short: string;
  date: string;
  subject: string;
}

export interface BrainBlameEntry {
  sha: string;
  short: string;
  date: string;
  subject: string;
  atoms: string[];
  code: { repo?: string; branch?: string; sha?: string; commits: string[] };
}

export interface BrainExplore {
  dir: string;
  initialized: boolean;
  branch?: string;
  lastCommit?: string;
  namespaces: BrainNamespaceSummary[];
  memoryAtoms: number;
  totals: { sessions: number; handoffs: number; memory: number; namespaces: number };
  atoms: BrainAtomMeta[];
  atomsTruncated: boolean;
  stashes: BrainStashDetail[];
  branches: { sessions: string[]; ideas: string[] };
  recentCommits: BrainLogEntry[];
  provenance: BrainBlameEntry[];
}

/** The three EXPENSIVE explorer sections, one per dashboard tab. Omit for all;
 *  pass only the active tab's section so an off-tab load skips the atom file
 *  reads / per-stash previews / provenance blame walk it never renders. */
export type BrainSection = 'atoms' | 'stashes' | 'provenance';

export function fetchBrainExplore(sections?: BrainSection[]): Promise<BrainExplore | null> {
  return callGateway<BrainExplore>('brain_explore', sections ? { sections } : {});
}

// ── Brain health — composite index (BRAIN health-score) ─────────────────────
// Mirrors the gateway `brain_health` tool (runtime/src/core/brain-health.ts):
// ONE 0-100 score + grade rolling up freshness / coverage gaps / contradictions
// / recall hit-rate, plus the recorded trend so this page can render a trend
// line. Distinct from per-atom recall analytics (most-recalled/staleness) —
// this is the one number to watch over time.

export type BrainHealthGrade = 'excellent' | 'good' | 'fair' | 'poor';

export interface BrainHealthSignals {
  freshnessDays: number | null;
  coverageGaps: number;
  namespaceTotal: number;
  contradictionCount: number;
  contradictionWindowDays: number;
  recallHitRate: number | null;
}

export interface BrainHealthSubscores {
  freshness: number;
  coverage: number;
  contradictions: number;
  recall: number | null;
}

export interface BrainHealthSnapshot {
  at: string;
  score: number;
  grade: BrainHealthGrade;
}

export interface BrainHealth {
  score: number;
  grade: BrainHealthGrade;
  signals: BrainHealthSignals;
  subscores: BrainHealthSubscores;
  computedAt: string;
  history: BrainHealthSnapshot[];
}

/** `record: false` so a dashboard page load never counts as a trend snapshot —
 *  only `myai brain status` / a deliberate MCP call records one. */
export function fetchBrainHealth(): Promise<BrainHealth | null> {
  return callGateway<BrainHealth>('brain_health', { record: false });
}

// ── Retrieval bandit stats (BRAIN B-7 follow-up, task-49fda69b) ─────────────
// Mirrors the gateway `brain_bandit_stats` tool (runtime/src/repos/bandit-stats.ts)
// — a read-only snapshot of scripts/retrieval_bandit.py's bandit_arms table:
// which retrieval config (k, rerank on/off) the bandit currently favors per
// query context, and the per-arm pull/reward stats backing that pick. Distinct
// from BrainHealth — this is retrieval-config tuning state, not memory hygiene.

export interface BanditArmStat {
  arm: string;
  k: number;
  rerankOn: boolean;
  pulls: number;
  rewardSum: number;
  meanReward: number;
}

export interface BanditFavoredArm {
  k: number;
  rerank_on: boolean;
}

export interface BanditContextStat {
  context: string;
  favoredArm: BanditFavoredArm | null;
  pullsTotal: number;
  arms: BanditArmStat[];
}

export interface BanditStats {
  available: boolean;
  totalPulls: number;
  contexts: BanditContextStat[];
}

export function fetchBanditStats(): Promise<BanditStats | null> {
  return callGateway<BanditStats>('brain_bandit_stats', {});
}

/** Render a brain UTC stamp (`YYYYMMDDTHHMMSSZ`) as a locale date-time; falls
 *  back to the raw value when it isn't the expected shape. */
export function formatBrainStamp(stamp?: string): string {
  if (!stamp) return '—';
  const m = stamp.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return stamp;
  const [, y, mo, d, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? stamp : dt.toLocaleString();
}
