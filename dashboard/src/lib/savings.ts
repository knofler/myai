// Per-user cold-start savings — dashboard read side.
//
// Aggregates the continuitymetrics read mirror (db.ts) into the per-user
// cumulative "tokens saved / $ saved" view and the share-card figure. Mirrors
// the canonical aggregation in runtime/src/monitoring/continuity-metrics.ts
// (getUserSavings) — same month-to-date-vs-all-time split, same tokens→USD
// pricing — but runs against the local read mirror so /savings renders without
// a gateway round-trip. Keep the two in sync.

import { ContinuityMetric } from './db';

/**
 * USD priced per 1M *input* tokens — cold-start tokens saved are context the
 * model would otherwise re-read as input every boot (Sonnet/Opus input ≈ $3/M
 * as of 2026-07). Overridable via MYAI_TOKEN_USD_PER_M. Mirror of the runtime
 * DEFAULT_USD_PER_MTOKENS.
 */
export const DEFAULT_USD_PER_MTOKENS = 3;

export function usdPerMillionTokens(): number {
  const raw = Number(process.env.MYAI_TOKEN_USD_PER_M);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_USD_PER_MTOKENS;
}

export function tokensToUsd(tokens: number, rate: number = usdPerMillionTokens()): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return (tokens / 1_000_000) * rate;
}

export interface SavingsBucket { tokens: number; boots: number; usd: number }
export interface UserSavingsRow extends SavingsBucket { userId: string }
export interface SavingsSummary {
  userId?: string;
  month: SavingsBucket;
  total: SavingsBucket;
  byUser: UserSavingsRow[];
  usdPerMTokens: number;
  monthStart: string;
}

function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function emptyBucket(): SavingsBucket { return { tokens: 0, boots: 0, usd: 0 }; }

/**
 * Per-user (or whole-tenant) cumulative cold-start savings. `tenantMatch` is the
 * filter from tenantFilter(tenantId). When `userId` is supplied the buckets
 * cover only that member and `byUser` is empty; otherwise buckets are the tenant
 * total and `byUser` is the month-to-date per-member breakdown (highest first).
 * Never throws — degrades to zeros so the share card always renders.
 */
export async function getUserSavings(
  tenantMatch: Record<string, unknown>,
  opts: { userId?: string; now?: Date } = {},
): Promise<SavingsSummary> {
  const rate = usdPerMillionTokens();
  const start = monthStartUtc(opts.now ?? new Date());
  const summary: SavingsSummary = {
    userId: opts.userId,
    month: emptyBucket(),
    total: emptyBucket(),
    byUser: [],
    usdPerMTokens: rate,
    monthStart: start.toISOString().slice(0, 10),
  };

  try {
    const match: Record<string, unknown> = { ...tenantMatch };
    if (opts.userId) match.userId = opts.userId;

    const rows = await ContinuityMetric.aggregate<{
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
  } catch {
    return summary;
  }
}
