// Reader for the CLI session Usage Guard's thresholds
// (config/session-limits.json, enforced by hooks/pre-tool/10-usage-guard.sh).
// Phase 6 settings menu: this config has never had a UI home — an operator
// had to grep the repo to see what a session's time/action/token budget is.
// Read-only, same AI_ROOT-mounted-repo + containment-guard pattern as
// lib/schedule-policy.ts.

import { promises as fs } from 'fs';
import path from 'path';
import { AI_ROOT } from './docs';

export interface UsageGuardPolicy {
  sessionDurationMinutes: number;
  maxWeightedActions: number;
  warnAtPercent: number[];
  blockAtPercent: number | null;
  blockTools: string[];
  tokenBudget: {
    enabled: boolean;
    sessionOutputBudget: number;
    warnAtPercent: number[];
    rollingWindowMinutes: number;
    rollingWindowOutputBudget: number;
  } | null;
  autosave: {
    enabled: boolean;
    staleMinutes: number;
    minWeightedSince: number;
  } | null;
}

const DEFAULTS: UsageGuardPolicy = {
  sessionDurationMinutes: 240,
  maxWeightedActions: 300,
  warnAtPercent: [80, 90, 95],
  blockAtPercent: null,
  blockTools: [],
  tokenBudget: null,
  autosave: null,
};

function asNumberArray(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : [];
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

export async function readUsageGuardPolicy(): Promise<UsageGuardPolicy> {
  const resolved = path.resolve(path.join(AI_ROOT, 'config', 'session-limits.json'));
  if (!resolved.startsWith(path.resolve(AI_ROOT))) return DEFAULTS; // containment guard
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 200_000) return DEFAULTS;
    const raw = await fs.readFile(resolved, 'utf-8');
    const cfg = JSON.parse(raw) as Record<string, unknown>;

    const tb = cfg.token_budget as Record<string, unknown> | undefined;
    const rw = tb?.rolling_window as Record<string, unknown> | undefined;
    const autosave = cfg.autosave as Record<string, unknown> | undefined;

    return {
      sessionDurationMinutes: Number(cfg.session_duration_minutes) || DEFAULTS.sessionDurationMinutes,
      maxWeightedActions: Number(cfg.max_weighted_actions) || DEFAULTS.maxWeightedActions,
      warnAtPercent: asNumberArray(cfg.warn_at_percent).length ? asNumberArray(cfg.warn_at_percent) : DEFAULTS.warnAtPercent,
      blockAtPercent: typeof cfg.block_at_percent === 'number' ? cfg.block_at_percent : null,
      blockTools: asStringArray(cfg.block_tools),
      tokenBudget: tb
        ? {
            enabled: Boolean(tb.enabled),
            sessionOutputBudget: Number(tb.session_output_budget) || 0,
            warnAtPercent: asNumberArray(tb.warn_at_percent),
            rollingWindowMinutes: Number(rw?.window_minutes) || 0,
            rollingWindowOutputBudget: Number(rw?.output_budget) || 0,
          }
        : null,
      autosave: autosave
        ? {
            enabled: Boolean(autosave.enabled),
            staleMinutes: Number(autosave.stale_minutes) || 0,
            minWeightedSince: Number(autosave.min_weighted_since) || 0,
          }
        : null,
    };
  } catch {
    return DEFAULTS;
  }
}
