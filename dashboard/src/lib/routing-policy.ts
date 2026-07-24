// Per-tenant cost-aware routing policy — the Phase 3 control-plane core.
//
// The gateway already routes tasks to the cheapest capable tier (see
// documentation/COST_AWARE_ROUTING.md) using GLOBAL env config. This module is
// the per-TENANT control plane on top of that: each tenant can pin a default
// model, override the model per task priority (P0–P3), and set a monthly budget
// cap with soft/hard limits that the token guard consumes.
//
// Everything here is PURE (no DB, no network) so it is unit-testable and can be
// reused by both the settings API route and the gateway's router once it reads
// per-tenant policy. The DB model lives in db.ts (`RoutingPolicy`); the API
// route (/api/routing-policy) persists a sanitized policy; the settings UI
// (views/routing-settings.tsx + components/routing-policy-form.tsx) edits it.
//
// TOKEN-GUARD WIRING: `budgetState()` turns month-to-date spend + the policy's
// soft/hard limits into an actionable status the token guard maps to a routing
// action — soft → downgrade premium/ultra to standard; hard → block cloud,
// force local CLI. See `tokenGuardAction()`.

/* ── Tiers & models ─────────────────────────────────────────── */

export type Tier = 'budget' | 'standard' | 'premium' | 'ultra';

export interface ModelOption {
  /** Router model id (matches the gateway tier model ids). */
  id: string;
  /** Human label for the dropdown. */
  label: string;
  /** Which cost tier this model sits in. */
  tier: Tier;
}

// Curated selectable models, mirroring the provider cost table in
// documentation/COST_AWARE_ROUTING.md. Ordered cheapest → most expensive.
export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'local-cli', label: 'Local CLI (free)', tier: 'budget' },
  { id: 'gemini-flash', label: 'Gemini Flash', tier: 'budget' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', tier: 'budget' },
  { id: 'deepseek-v3', label: 'DeepSeek V3', tier: 'standard' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 'standard' },
  { id: 'gemini-pro', label: 'Gemini Pro', tier: 'premium' },
  { id: 'gpt-4o', label: 'GPT-4o', tier: 'premium' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', tier: 'premium' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', tier: 'ultra' },
];

const MODEL_IDS = new Set(MODEL_OPTIONS.map((m) => m.id));

export function isValidModel(id: unknown): id is string {
  return typeof id === 'string' && MODEL_IDS.has(id);
}

export function modelOption(id: string): ModelOption | undefined {
  return MODEL_OPTIONS.find((m) => m.id === id);
}

/* ── Priorities ─────────────────────────────────────────────── */

// Task-queue priorities (see config/schedule_priority.txt semantics). P0 is the
// most urgent → typically the strongest model; P3 the least → the cheapest.
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];

export function isPriority(p: unknown): p is Priority {
  return typeof p === 'string' && (PRIORITIES as string[]).includes(p);
}

/* ── Policy shape ───────────────────────────────────────────── */

export interface RoutingPolicy {
  /** Master switch — when false the tenant inherits the global gateway config. */
  enabled: boolean;
  /** Fallback model for any priority without an explicit override. */
  defaultModel: string;
  /** Optional per-priority model overrides. Missing key → defaultModel. */
  priorityOverrides: Partial<Record<Priority, string>>;
  /** Monthly spend cap in USD (0 = no cap). */
  monthlyBudgetUsd: number;
  /** Fraction of the cap at which the token guard starts downgrading (0–1). */
  softLimitPct: number;
  /** Fraction of the cap at which the token guard blocks cloud calls (0–1). */
  hardLimitPct: number;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  enabled: false,
  defaultModel: 'claude-sonnet-4-6',
  priorityOverrides: {
    P0: 'claude-opus-4-7',
    P3: 'deepseek-v3',
  },
  monthlyBudgetUsd: 50,
  softLimitPct: 0.8,
  hardLimitPct: 1.0,
};

/* ── Resolution ─────────────────────────────────────────────── */

/**
 * Resolve the model a given priority should route to under this policy:
 * the per-priority override if present and valid, else the default model.
 */
export function resolveModel(policy: RoutingPolicy, priority: Priority): string {
  const override = policy.priorityOverrides?.[priority];
  if (isValidModel(override)) return override;
  return policy.defaultModel;
}

/* ── Budget state (token-guard wiring) ──────────────────────── */

export type BudgetStatus = 'ok' | 'soft' | 'hard';

export interface BudgetState {
  status: BudgetStatus;
  spentUsd: number;
  capUsd: number;
  softLimitUsd: number;
  hardLimitUsd: number;
  /** spent / cap as a percentage (0 when no cap). */
  pct: number;
  /** Remaining before the hard limit (never negative). */
  remainingUsd: number;
}

/**
 * Turn month-to-date spend + the policy's soft/hard limits into an actionable
 * budget status. When the policy is disabled or the cap is 0 (unlimited) the
 * status is always 'ok'.
 */
export function budgetState(spentUsd: number, policy: RoutingPolicy): BudgetState {
  const spent = Math.max(0, Number.isFinite(spentUsd) ? spentUsd : 0);
  const cap = Math.max(0, policy.monthlyBudgetUsd || 0);
  const softLimitUsd = cap * clamp01(policy.softLimitPct);
  const hardLimitUsd = cap * clamp01(policy.hardLimitPct);

  let status: BudgetStatus = 'ok';
  if (policy.enabled && cap > 0) {
    if (spent >= hardLimitUsd) status = 'hard';
    else if (spent >= softLimitUsd) status = 'soft';
  }

  return {
    status,
    spentUsd: spent,
    capUsd: cap,
    softLimitUsd,
    hardLimitUsd,
    pct: cap > 0 ? (spent / cap) * 100 : 0,
    remainingUsd: Math.max(0, hardLimitUsd - spent),
  };
}

/**
 * The routing action the token guard applies for a given budget status:
 *   ok   → route normally per the policy
 *   soft → downgrade premium/ultra requests to the standard tier
 *   hard → block all cloud calls; force local CLI (tier 1)
 */
export function tokenGuardAction(status: BudgetStatus): 'normal' | 'downgrade' | 'block-cloud' {
  if (status === 'hard') return 'block-cloud';
  if (status === 'soft') return 'downgrade';
  return 'normal';
}

/* ── Validation / sanitization ──────────────────────────────── */

function clamp01(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * Coerce arbitrary (untrusted) input into a valid RoutingPolicy, falling back
 * to defaults for missing/invalid fields. Guarantees:
 *   • defaultModel is a known model
 *   • priorityOverrides only contains valid priority→model pairs
 *   • budget is a finite, non-negative number
 *   • soft/hard limits are in [0,1] and soft ≤ hard
 */
export function sanitizePolicy(input: unknown): RoutingPolicy {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  const defaultModel = isValidModel(raw.defaultModel)
    ? raw.defaultModel
    : DEFAULT_ROUTING_POLICY.defaultModel;

  const overrides: Partial<Record<Priority, string>> = {};
  const rawOverrides = raw.priorityOverrides;
  if (rawOverrides && typeof rawOverrides === 'object') {
    for (const [k, v] of Object.entries(rawOverrides as Record<string, unknown>)) {
      if (isPriority(k) && isValidModel(v)) overrides[k] = v;
    }
  }

  const monthlyBudgetUsd = (() => {
    const n = Number(raw.monthlyBudgetUsd);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_ROUTING_POLICY.monthlyBudgetUsd;
  })();

  let softLimitPct = clamp01(
    raw.softLimitPct ?? DEFAULT_ROUTING_POLICY.softLimitPct,
  );
  let hardLimitPct = clamp01(
    raw.hardLimitPct ?? DEFAULT_ROUTING_POLICY.hardLimitPct,
  );
  // Soft can never exceed hard — a soft limit above the hard block is meaningless.
  if (softLimitPct > hardLimitPct) softLimitPct = hardLimitPct;

  return {
    enabled: raw.enabled === true,
    defaultModel,
    priorityOverrides: overrides,
    monthlyBudgetUsd,
    softLimitPct,
    hardLimitPct,
  };
}
