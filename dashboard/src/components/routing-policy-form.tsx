'use client';

// Per-tenant cost-aware routing policy editor (Phase 3 control-plane UI).
// Edits the default model, per-priority (P0–P3) model overrides, and the
// monthly budget cap with soft/hard limits — persisting to /api/routing-policy
// (tenant-scoped). A live budget meter shows month-to-date spend against the
// cap using the same soft/hard math the token guard enforces server-side.

import { useMemo, useState } from 'react';
import {
  MODEL_OPTIONS,
  PRIORITIES,
  budgetState,
  isMeteredModel,
  modelOption,
  type Priority,
  type RoutingPolicy,
} from '@/lib/routing-policy';

const inputCls =
  'px-3 py-2 rounded-lg bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] text-sm text-[rgb(var(--text-primary))] placeholder-zinc-600 focus:border-teal-600 outline-none transition-colors';

const TIER_STYLE: Record<string, string> = {
  budget: 'text-[rgb(var(--text-secondary))]',
  standard: 'text-emerald-400',
  premium: 'text-blue-300',
  ultra: 'text-purple-300',
};

function ModelSelect({
  value,
  onChange,
  allowInherit,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  allowInherit?: boolean;
  id?: string;
}) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={`${inputCls} w-full`}>
      {allowInherit && <option value="">— use default —</option>}
      {MODEL_OPTIONS.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label} · {m.tier}{m.metered ? ' · metered $' : ''}
        </option>
      ))}
    </select>
  );
}

const STATUS_STYLE: Record<string, { bar: string; badge: string; label: string }> = {
  ok: { bar: 'bg-emerald-500', badge: 'bg-emerald-500/10 text-emerald-400', label: 'WITHIN BUDGET' },
  soft: { bar: 'bg-orange-500', badge: 'bg-orange-500/10 text-orange-400', label: 'SOFT LIMIT — DOWNGRADING' },
  hard: { bar: 'bg-red-500', badge: 'bg-red-500/10 text-red-400', label: 'HARD LIMIT — CLOUD BLOCKED' },
};

export default function RoutingPolicyForm({
  initialPolicy,
  spentUsd,
}: {
  initialPolicy: RoutingPolicy;
  spentUsd: number;
}) {
  const [policy, setPolicy] = useState<RoutingPolicy>(initialPolicy);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = useMemo(() => budgetState(spentUsd, policy), [spentUsd, policy]);
  const style = STATUS_STYLE[state.status];

  // Which lanes this policy actually routes to (default + each priority's
  // effective model). If any is metered, warn — those spend real API dollars
  // (DeepSeek/GPT) unlike the flat Claude subscription lanes.
  const meteredModels = useMemo(() => {
    const ids = new Set<string>([policy.defaultModel]);
    for (const pr of PRIORITIES) ids.add(policy.priorityOverrides[pr] || policy.defaultModel);
    return MODEL_OPTIONS.filter((m) => ids.has(m.id) && m.metered).map((m) => m.label);
  }, [policy]);

  function patch(p: Partial<RoutingPolicy>) {
    setPolicy((prev) => ({ ...prev, ...p }));
    setSaved(false);
  }

  function setOverride(pr: Priority, model: string) {
    setPolicy((prev) => {
      const next = { ...prev.priorityOverrides };
      if (model) next[pr] = model;
      else delete next[pr];
      return { ...prev, priorityOverrides: next };
    });
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/routing-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'could not save policy');
      setPolicy(json.policy as RoutingPolicy);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not save policy');
    } finally {
      setSaving(false);
    }
  }

  const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

  return (
    <div className="space-y-6">
      {/* ── Enable toggle ─────────────────────────────────────── */}
      <div className="bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded-lg p-5 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-[rgb(var(--text-primary))]">Per-tenant routing policy</h2>
          <p className="text-xs text-[rgb(var(--text-muted))] mt-1">
            When enabled, this tenant&apos;s tasks route per the rules below instead of the global gateway config.
          </p>
        </div>
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={policy.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
            className="h-4 w-4 accent-teal-600"
          />
          <span className={`text-xs font-mono ${policy.enabled ? 'text-emerald-400' : 'text-[rgb(var(--text-muted))]'}`}>
            {policy.enabled ? 'ENABLED' : 'DISABLED'}
          </span>
        </label>
      </div>

      {/* ── Model routing rules ───────────────────────────────── */}
      <div className="bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded-lg p-5 space-y-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-[rgb(var(--text-primary))]">Model routing</h2>
          <span className="text-xs text-[rgb(var(--text-muted))]">
            <span className="text-amber-400 font-mono">metered $</span> = bills real API dollars (DeepSeek, GPT)
          </span>
        </div>
        <div>
          <label htmlFor="default-model" className="block text-xs text-[rgb(var(--text-secondary))] mb-1">
            Default model
            {isMeteredModel(policy.defaultModel) && (
              <span className="ml-2 text-amber-400 font-mono">metered $</span>
            )}
          </label>
          <ModelSelect id="default-model" value={policy.defaultModel} onChange={(v) => patch({ defaultModel: v })} />
          <p className="text-xs text-zinc-600 mt-1">Used for any priority without an explicit override.</p>
        </div>

        {meteredModels.length > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            This policy routes to metered {meteredModels.length === 1 ? 'provider' : 'providers'}{' '}
            <span className="font-mono">{meteredModels.join(', ')}</span> — these spend real per-token
            API dollars, unlike the flat-rate Claude subscription lanes. Keep the monthly cap below in mind.
          </div>
        )}

        <div>
          <div className="text-xs text-[rgb(var(--text-secondary))] mb-2">Per-priority overrides</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {PRIORITIES.map((pr) => {
              const val = policy.priorityOverrides[pr] ?? '';
              const effective = val || policy.defaultModel;
              const tier = modelOption(effective)?.tier ?? '';
              return (
                <div key={pr}>
                  <label htmlFor={`ov-${pr}`} className="flex items-center justify-between text-xs mb-1">
                    <span className="font-mono text-[rgb(var(--text-primary))]">{pr}</span>
                    <span className="flex items-center gap-1">
                      {isMeteredModel(effective) && <span className="text-amber-400 font-mono">$</span>}
                      <span className={TIER_STYLE[tier] ?? 'text-[rgb(var(--text-muted))]'}>{tier || '—'}</span>
                    </span>
                  </label>
                  <ModelSelect id={`ov-${pr}`} value={val} onChange={(v) => setOverride(pr, v)} allowInherit />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Budget cap ────────────────────────────────────────── */}
      <div className="bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded-lg p-5 space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-[rgb(var(--text-primary))]">Monthly budget cap</h2>
          <span className={`text-xs font-mono px-2 py-0.5 rounded ${style.badge}`}>{style.label}</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label htmlFor="budget" className="block text-xs text-[rgb(var(--text-secondary))] mb-1">Cap (USD / month)</label>
            <input
              id="budget"
              type="number"
              min={0}
              step={1}
              value={policy.monthlyBudgetUsd}
              onChange={(e) => patch({ monthlyBudgetUsd: Number(e.target.value) })}
              className={`${inputCls} w-full`}
            />
            <p className="text-xs text-zinc-600 mt-1">0 = unlimited.</p>
          </div>
          <div>
            <label htmlFor="soft" className="block text-xs text-[rgb(var(--text-secondary))] mb-1">
              Soft limit — {(policy.softLimitPct * 100).toFixed(0)}%
            </label>
            <input
              id="soft"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={policy.softLimitPct}
              onChange={(e) => patch({ softLimitPct: Number(e.target.value) })}
              className="w-full accent-orange-500"
            />
            <p className="text-xs text-zinc-600 mt-1">Token guard downgrades premium/ultra above this.</p>
          </div>
          <div>
            <label htmlFor="hard" className="block text-xs text-[rgb(var(--text-secondary))] mb-1">
              Hard limit — {(policy.hardLimitPct * 100).toFixed(0)}%
            </label>
            <input
              id="hard"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={policy.hardLimitPct}
              onChange={(e) => patch({ hardLimitPct: Number(e.target.value) })}
              className="w-full accent-red-500"
            />
            <p className="text-xs text-zinc-600 mt-1">Cloud calls blocked (local CLI only) above this.</p>
          </div>
        </div>

        {/* Live budget meter */}
        <div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-[rgb(var(--text-secondary))]">Month-to-date spend</span>
            <span className="font-mono text-[rgb(var(--text-primary))]">
              {fmtUsd(state.spentUsd)}
              {state.capUsd > 0 && <span className="text-[rgb(var(--text-muted))]"> / {fmtUsd(state.capUsd)} ({state.pct.toFixed(0)}%)</span>}
            </span>
          </div>
          <div className="relative h-2 bg-[rgb(var(--bg-hover))] rounded-full overflow-hidden">
            <div className={`absolute left-0 top-0 h-full ${style.bar}`} style={{ width: `${Math.min(100, state.pct)}%` }} />
            {state.capUsd > 0 && (
              <>
                <div className="absolute top-0 h-full w-px bg-orange-300/60" style={{ left: `${policy.softLimitPct * 100}%` }} title="soft limit" />
                <div className="absolute top-0 h-full w-px bg-red-300/70" style={{ left: `${policy.hardLimitPct * 100}%` }} title="hard limit" />
              </>
            )}
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            {state.capUsd > 0
              ? `${fmtUsd(state.remainingUsd)} left before the hard block.`
              : 'No cap set — spend is unlimited.'}
          </p>
        </div>
      </div>

      {/* ── Save ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-sm font-medium text-white transition-colors"
        >
          {saving ? 'Saving…' : 'Save policy'}
        </button>
        {saved && <span role="status" className="text-xs text-emerald-400">Saved.</span>}
        {error && <span role="alert" className="text-xs text-rose-400">{error}</span>}
      </div>
    </div>
  );
}
