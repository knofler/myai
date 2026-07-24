/**
 * Phase 5b follow-up — provider invoice resolution (plan/PHASE_5B_BUDGET_GUARDS.md
 * §7/§8: "always compare with provider invoices" / "provider invoice
 * reconciliation" was listed as an unbuilt follow-up).
 *
 * `cost-estimator.ts` prices every call from a hand-maintained per-model rate
 * table. That table can drift from what a provider actually bills (rate
 * changes, promo pricing, rounding). This module resolves the *actual*
 * invoiced USD for a provider over a date range, in priority order:
 *
 *   1. Manual override — an operator with the provider's dashboard/invoice
 *      open pastes the period total into `PROVIDER_INVOICE_OVERRIDES_JSON`,
 *      e.g. `{"claude-api": 12.34, "deepseek-api": 0.87}`. Wins over any
 *      automated fetch — a human-entered number from the real invoice
 *      outranks a best-effort API guess.
 *   2. Anthropic Cost Report Admin API — when `ANTHROPIC_ADMIN_API_KEY` is
 *      set, `claude-api` spend is fetched automatically. Best-effort: any
 *      network/auth/shape error returns `null` rather than throwing, so a
 *      misconfigured or unreachable Admin API degrades to "no invoice data"
 *      instead of a false reconciliation alert.
 *   3. Unavailable — there is no automated source for deepseek-api /
 *      moonshot-api today. `budget-reconciliation.ts` simply skips a
 *      provider with no invoice on file rather than guessing.
 */
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'provider-invoice' });

export type InvoiceSource = 'manual' | 'anthropic_admin_api';

export interface ActualInvoice {
  costUsd: number;
  source: InvoiceSource;
}

/**
 * Parse the manual override env blob into a provider → USD map. Malformed
 * JSON, a non-object, or non-numeric/negative values are dropped silently —
 * this is operator-entered data on a best-effort audit path, not something
 * that should crash a scheduled job.
 */
export function parseInvoiceOverrides(raw: string | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[provider] = value;
    }
    return out;
  } catch (err) {
    log.warn({ err }, 'PROVIDER_INVOICE_OVERRIDES_JSON is not valid JSON — ignoring');
    return {};
  }
}

/**
 * Best-effort fetch of Anthropic's actual billed cost for [from, to) via the
 * Cost Report Admin API. Requires `ANTHROPIC_ADMIN_API_KEY` — a separate,
 * higher-privilege key from the `ANTHROPIC_API_KEY` used for completions.
 * Returns `null` on missing key, network error, non-2xx, or an unexpected
 * response shape. This is reconciliation tooling, not a hot-path call —
 * silently degrading beats throwing and taking the check runner down with it.
 */
export async function fetchAnthropicInvoiceUsd(from: Date, to: Date): Promise<number | null> {
  const apiKey = process.env.ANTHROPIC_ADMIN_API_KEY;
  if (!apiKey) return null;

  try {
    const url = new URL('https://api.anthropic.com/v1/organizations/cost_report');
    url.searchParams.set('starting_at', from.toISOString());
    url.searchParams.set('ending_at', to.toISOString());

    const res = await fetch(url, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) {
      log.warn({ status: res.status }, 'Anthropic cost_report returned non-2xx — treating as unavailable');
      return null;
    }

    const body = (await res.json()) as {
      data?: Array<{ results?: Array<{ amount?: { value?: string | number } }> }>;
    };
    let total = 0;
    for (const bucket of body.data ?? []) {
      for (const result of bucket.results ?? []) {
        const value = Number(result.amount?.value);
        if (Number.isFinite(value)) total += value;
      }
    }
    return total;
  } catch (err) {
    log.warn({ err }, 'Anthropic cost_report fetch failed — treating as unavailable');
    return null;
  }
}

/** Providers with an automated invoice fetcher wired up. */
const AUTOMATED_FETCHERS: Record<string, (from: Date, to: Date) => Promise<number | null>> = {
  'claude-api': fetchAnthropicInvoiceUsd,
};

/**
 * Resolve the actual invoiced USD for `provider` over [from, to). Manual
 * override always wins; falls back to the provider's automated fetcher (if
 * any); returns `null` when no invoice data is available at all — the
 * caller's job is to skip reconciliation for that provider, not to guess.
 */
export async function getActualInvoiceUsd(provider: string, from: Date, to: Date): Promise<ActualInvoice | null> {
  const overrides = parseInvoiceOverrides(process.env.PROVIDER_INVOICE_OVERRIDES_JSON);
  if (typeof overrides[provider] === 'number') {
    return { costUsd: overrides[provider], source: 'manual' };
  }

  const fetcher = AUTOMATED_FETCHERS[provider];
  if (!fetcher) return null;

  const costUsd = await fetcher(from, to);
  if (costUsd === null) return null;
  return { costUsd, source: 'anthropic_admin_api' };
}
