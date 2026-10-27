// Client-safe half of budget-suggestions.ts: the types plus the pure
// formatting/apply helpers that components/budget-suggestions-panel.tsx (a
// client component) calls at runtime. budget-suggestions.ts imports ./db
// (Mongoose models) and ./tenant-cookie, so importing ANY value from it in a
// client component drags the model layer into the browser bundle, where
// `mongoose.models` is undefined. That crashed every /system tab with
// "Cannot read properties of undefined (reading 'StripeEvent')" (found by
// the G8 every-screen proof, dashboard/e2e/g8-empty-brain.spec.ts).
// Nothing here may import a server-only module. budget-suggestions.ts
// re-exports all of it, so server callers keep their import path.

export type CapRecommendation = 'increase' | 'decrease' | 'keep' | 'insufficient_data';

export interface CapSuggestion {
  currentCapUsd: number;
  observedDays: number;
  avgDailyUsd: number;
  p95DailyUsd: number;
  suggestedCapUsd: number;
  recommendation: CapRecommendation;
  rationale: string;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** View-model the panel renders from — the pure formatting layer the component test covers. */
export interface SuggestionSummary {
  deltaUsd: number;
  deltaPct: number;
  badgeLabel: string;
}

export function summarizeSuggestion(s: CapSuggestion): SuggestionSummary {
  const deltaUsd = round2(s.suggestedCapUsd - s.currentCapUsd);
  const deltaPct = s.currentCapUsd > 0 ? round2((deltaUsd / s.currentCapUsd) * 100) : 0;
  const badgeLabel = s.recommendation === 'insufficient_data' ? 'insufficient data' : s.recommendation;
  return { deltaUsd, deltaPct, badgeLabel };
}

/** The three cap fields a BudgetCapOverride document (src/lib/db.ts) can hold. */
export type CapOverrideField = 'monthlyHardCapUsd' | 'dailyCapUsd' | 'perChannelCapUsd';

export type ApplySource = 'adaptive-suggested' | 'manual';

export interface ApplySuggestionPayload {
  field: CapOverrideField;
  valueUsd: number;
  source: ApplySource;
}

/**
 * Only 'increase'/'decrease' represent an actual change worth a write —
 * 'keep' and 'insufficient_data' both pin suggestedCapUsd to currentCapUsd
 * (see buildCapSuggestion in budget-suggestions.ts), so applying either would
 * be a no-op PATCH.
 */
export function canApplySuggestion(recommendation: CapRecommendation): boolean {
  return recommendation === 'increase' || recommendation === 'decrease';
}

/** Builds the /api/budget-caps PATCH body for a given suggestion row. */
export function buildApplyPayload(field: CapOverrideField, s: CapSuggestion): ApplySuggestionPayload {
  return { field, valueUsd: s.suggestedCapUsd, source: 'adaptive-suggested' };
}
