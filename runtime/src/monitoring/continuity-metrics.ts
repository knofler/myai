/**
 * Continuity metrics — the cold-start tokens-saved meter.
 *
 * Every time the continuity layer serves a context block to a blank agent
 * (context_boot bundle, memory_context block), the serving handler records the
 * estimated token size here. That number is the re-teaching cost the operator
 * avoided: without the gateway, those tokens are re-typed / re-read into the
 * model by hand every cold start. Aggregated per month it becomes the headline
 * marketing claim ("myAI saved N tokens this month") surfaced on the dashboard
 * /analytics page and in `myai status`.
 *
 * Recording is strictly best-effort: a DB outage, a zero estimate, or a model
 * mock without the collection must NEVER fail the context call it decorates.
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createChildLogger } from '../shared/logger.js';
import { getConfig } from '../shared/config.js';
import { isConnected, ContinuityMetricModel } from '../shared/db.js';
import type { ContinuityTool } from '../shared/db.js';

const log = createChildLogger({ module: 'continuity-metrics' });

export interface ContextServedEvent {
  repo?: string;
  tool: ContinuityTool;
  tokens: number;
  /** Measured legacy file-read boot cost at serve time — the today-vs-brain comparator. */
  baselineTokens?: number;
  /** M2 Team tier — tenant member the boot was served to. Drives per-user savings + the share card. */
  userId?: string;
  sessionId?: string;
}

// ── Legacy boot baseline (B7 today-vs-brain) ─────────────────
// The files a legacy `agent mode` session start reads in full (CLAUDE.md "On
// Session Start"). Their live size ÷ 4 chars/token is the measured cost of the
// file-read path a brain/context_boot boot replaced — stamped per served
// context so the dashboard can render "today vs brain" from real data.
const LEGACY_BOOT_FILES = [
  'CLAUDE.md',
  'state/STATE.md',
  'state/AI_AGENT_HANDOFF.md',
  'documentation/AI_RULES.md',
  'documentation/MULTI_AGENT_ROUTING.md',
];
const BASELINE_CACHE_MS = 5 * 60_000;
let baselineCache: { at: number; tokens?: number } | undefined;

/**
 * Estimate the legacy file-read boot cost in tokens from the live sizes of the
 * session-start reading set under aiRoot. Cached ~5 min; returns undefined when
 * none of the files are readable (e.g. hosted tenant without an aiRoot mount).
 */
export function estimateLegacyBootTokens(now: number = Date.now()): number | undefined {
  if (baselineCache && now - baselineCache.at < BASELINE_CACHE_MS) return baselineCache.tokens;
  let bytes = 0;
  let found = false;
  try {
    const root = getConfig().aiRoot;
    for (const rel of LEGACY_BOOT_FILES) {
      try {
        bytes += statSync(resolve(root, rel)).size;
        found = true;
      } catch { /* file absent — skip */ }
    }
  } catch (err) {
    log.debug({ err }, 'legacy boot baseline unavailable');
  }
  const tokens = found ? Math.ceil(bytes / 4) : undefined;
  baselineCache = { at: now, tokens };
  return tokens;
}

/**
 * Record one context-served event. Fire-and-forget safe: returns false (never
 * throws) when the DB is down or the event is empty, so callers can `void` it.
 */
export async function recordContextServed(tenantId: string, event: ContextServedEvent): Promise<boolean> {
  if (!Number.isFinite(event.tokens) || event.tokens <= 0) return false;
  try {
    if (!isConnected()) return false;
    const baseline = Number.isFinite(event.baselineTokens) && (event.baselineTokens as number) > 0
      ? Math.round(event.baselineTokens as number)
      : undefined;
    await ContinuityMetricModel.create({
      tenantId,
      repo: event.repo?.trim() || 'unknown',
      tool: event.tool,
      tokens: Math.round(event.tokens),
      baselineTokens: baseline,
      userId: event.userId?.trim() || undefined,
      sessionId: event.sessionId,
    });
    return true;
  } catch (err) {
    log.debug({ err, tool: event.tool }, 'continuity metric not recorded');
    return false;
  }
}

export interface ContinuityBucket {
  boots: number;   // context blocks served
  tokens: number;  // estimated tokens served (= cold-start tokens saved)
}

/**
 * The B7 demo number: tokens-to-productive per session start, today vs brain.
 * `brain` averages what boot surfaces (context_boot + brain_delta) actually
 * served this month; `legacy` averages the measured file-read baseline stamped
 * on those same events. Savings are per session start.
 */
export interface ColdStartComparison {
  /** Month-to-date boot-path serves (context_boot + brain_delta). */
  brain: { boots: number; avgTokens: number };
  /** Measured legacy file-read baseline over the same boots (0 when unmeasured). */
  legacy: { measuredBoots: number; avgTokens: number };
  /** legacy.avgTokens − brain.avgTokens (0 when either side unmeasured). */
  savedPerBoot: number;
  /** Percent of the legacy cost avoided per boot (0 when unmeasured). */
  savedPct: number;
}

export interface ContinuityStats {
  /** Calendar month-to-date (UTC) — the headline number. */
  month: ContinuityBucket;
  /** All-time totals. */
  total: ContinuityBucket;
  /** Month-to-date split by serving tool. */
  byTool: Record<string, ContinuityBucket>;
  /** Month-to-date average tokens per served context. */
  avgTokensPerBoot: number;
  /** Cold-start today-vs-brain comparison (month-to-date). */
  coldStart: ColdStartComparison;
  /** ISO date the month bucket starts at (UTC). */
  monthStart: string;
  repo?: string;
}

const EMPTY: ContinuityBucket = { boots: 0, tokens: 0 };
/** Surfaces that replace a full session-start boot (vs mid-session context). */
const BOOT_TOOLS: ReadonlySet<string> = new Set(['context_boot', 'brain_delta']);

function emptyColdStart(): ColdStartComparison {
  return {
    brain: { boots: 0, avgTokens: 0 },
    legacy: { measuredBoots: 0, avgTokens: 0 },
    savedPerBoot: 0,
    savedPct: 0,
  };
}

/** UTC start of the current calendar month. */
export function monthStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Aggregate the tokens-saved meter for a tenant (optionally one repo).
 * Degrades to zeros when the DB is unreachable — status surfaces must render.
 */
export async function getContinuityStats(
  tenantId: string,
  opts: { repo?: string; now?: () => Date } = {},
): Promise<ContinuityStats> {
  const start = monthStartUtc(opts.now?.() ?? new Date());
  const stats: ContinuityStats = {
    month: { ...EMPTY },
    total: { ...EMPTY },
    byTool: {},
    avgTokensPerBoot: 0,
    coldStart: emptyColdStart(),
    monthStart: start.toISOString().slice(0, 10),
    repo: opts.repo,
  };

  try {
    if (!isConnected()) return stats;
    const match: Record<string, unknown> = { tenantId };
    if (opts.repo) match.repo = opts.repo;

    const rows = await ContinuityMetricModel.aggregate<{
      _id: { tool: string; inMonth: boolean };
      boots: number;
      tokens: number;
      baselineTokens: number;
      baselineBoots: number;
    }>([
      { $match: match },
      {
        $group: {
          _id: { tool: '$tool', inMonth: { $gte: ['$createdAt', start] } },
          boots: { $sum: 1 },
          tokens: { $sum: '$tokens' },
          baselineTokens: { $sum: { $ifNull: ['$baselineTokens', 0] } },
          baselineBoots: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$baselineTokens', 0] }, 0] }, 1, 0] } },
        },
      },
    ]);

    let bootTokens = 0;
    let baselineSum = 0;
    for (const row of rows) {
      stats.total.boots += row.boots;
      stats.total.tokens += row.tokens;
      if (row._id.inMonth) {
        stats.month.boots += row.boots;
        stats.month.tokens += row.tokens;
        const bucket = (stats.byTool[row._id.tool] ??= { ...EMPTY });
        bucket.boots += row.boots;
        bucket.tokens += row.tokens;
        if (BOOT_TOOLS.has(row._id.tool)) {
          stats.coldStart.brain.boots += row.boots;
          bootTokens += row.tokens;
          stats.coldStart.legacy.measuredBoots += row.baselineBoots ?? 0;
          baselineSum += row.baselineTokens ?? 0;
        }
      }
    }
    stats.avgTokensPerBoot = stats.month.boots > 0 ? Math.round(stats.month.tokens / stats.month.boots) : 0;

    const cs = stats.coldStart;
    cs.brain.avgTokens = cs.brain.boots > 0 ? Math.round(bootTokens / cs.brain.boots) : 0;
    cs.legacy.avgTokens = cs.legacy.measuredBoots > 0 ? Math.round(baselineSum / cs.legacy.measuredBoots) : 0;
    if (cs.brain.avgTokens > 0 && cs.legacy.avgTokens > 0) {
      cs.savedPerBoot = Math.max(0, cs.legacy.avgTokens - cs.brain.avgTokens);
      cs.savedPct = Math.round((cs.savedPerBoot / cs.legacy.avgTokens) * 100);
    }
    return stats;
  } catch (err) {
    log.debug({ err }, 'continuity stats unavailable — returning zeros');
    return stats;
  }
}

// ── Per-user cumulative savings + $ value (the viral share card) ─────────────
// The dashboard /savings view and the shareable card ("myAI saved me N tokens /
// $X this month") read this. Tokens saved = cold-start re-teaching cost the
// gateway served on the member's behalf; the $ figure prices those tokens at
// the input-token tier the model would otherwise re-ingest by hand.

/**
 * USD priced per 1M *input* tokens. Cold-start tokens saved are context the
 * model would otherwise re-read as input every boot, so the input tier is the
 * honest comparator (Sonnet/Opus input ≈ $3/M as of 2026-07). Overridable via
 * MYAI_TOKEN_USD_PER_M so the meter tracks pricing without a code change.
 */
export const DEFAULT_USD_PER_MTOKENS = 3;

export function usdPerMillionTokens(): number {
  const raw = Number(process.env.MYAI_TOKEN_USD_PER_M);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_USD_PER_MTOKENS;
}

/** Convert a token count to its USD value at the configured input-token rate. Never negative/NaN. */
export function tokensToUsd(tokens: number, rate: number = usdPerMillionTokens()): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return (tokens / 1_000_000) * rate;
}

export interface SavingsBucket {
  tokens: number;   // cold-start tokens saved
  boots: number;    // context blocks served
  usd: number;      // tokens priced at usdPerMillionTokens()
}

/** One tenant member's savings (for the per-user breakdown / leaderboard). */
export interface UserSavingsRow extends SavingsBucket {
  userId: string;   // '' when the boot carried no member attribution (system/agent traffic)
}

export interface SavingsSummary {
  /** Scope: whole tenant, or a single member when `userId` was supplied. */
  userId?: string;
  /** Calendar month-to-date (UTC) — the share-card headline. */
  month: SavingsBucket;
  /** All-time cumulative. */
  total: SavingsBucket;
  /** Month-to-date per-member breakdown, highest savings first (whole-tenant scope only). */
  byUser: UserSavingsRow[];
  /** USD priced per 1M tokens used for this summary. */
  usdPerMTokens: number;
  monthStart: string;
}

function emptyBucket(): SavingsBucket { return { tokens: 0, boots: 0, usd: 0 }; }

/**
 * Per-user (or whole-tenant) cumulative cold-start savings for the /savings view
 * and share card. When `opts.userId` is set the buckets cover only that member
 * and `byUser` is empty; otherwise the buckets are the tenant total and
 * `byUser` is the month-to-date per-member breakdown. Degrades to zeros when the
 * DB is unreachable — the share card must always render something.
 */
export async function getUserSavings(
  tenantId: string,
  opts: { userId?: string; now?: () => Date } = {},
): Promise<SavingsSummary> {
  const rate = usdPerMillionTokens();
  const start = monthStartUtc(opts.now?.() ?? new Date());
  const summary: SavingsSummary = {
    userId: opts.userId,
    month: emptyBucket(),
    total: emptyBucket(),
    byUser: [],
    usdPerMTokens: rate,
    monthStart: start.toISOString().slice(0, 10),
  };

  try {
    if (!isConnected()) return summary;
    const match: Record<string, unknown> = { tenantId };
    if (opts.userId) match.userId = opts.userId;

    const rows = await ContinuityMetricModel.aggregate<{
      _id: { userId: string | null; inMonth: boolean };
      boots: number;
      tokens: number;
    }>([
      { $match: match },
      {
        $group: {
          _id: { userId: '$userId', inMonth: { $gte: ['$createdAt', start] } },
          boots: { $sum: 1 },
          tokens: { $sum: '$tokens' },
        },
      },
    ]);

    const byUser = new Map<string, SavingsBucket>();
    for (const row of rows) {
      summary.total.tokens += row.tokens;
      summary.total.boots += row.boots;
      if (row._id.inMonth) {
        summary.month.tokens += row.tokens;
        summary.month.boots += row.boots;
        if (!opts.userId) {
          const key = row._id.userId ?? '';
          const b = byUser.get(key) ?? emptyBucket();
          b.tokens += row.tokens;
          b.boots += row.boots;
          byUser.set(key, b);
        }
      }
    }

    summary.month.usd = tokensToUsd(summary.month.tokens, rate);
    summary.total.usd = tokensToUsd(summary.total.tokens, rate);
    summary.byUser = [...byUser.entries()]
      .map(([userId, b]) => ({ userId, tokens: b.tokens, boots: b.boots, usd: tokensToUsd(b.tokens, rate) }))
      .sort((a, b) => b.tokens - a.tokens);
    return summary;
  } catch (err) {
    log.debug({ err }, 'user savings unavailable — returning zeros');
    return summary;
  }
}
