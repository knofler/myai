'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RecommendationBadge } from '@/components/ui/badge';
import type { BudgetCapSuggestions, CapOverrideField, CapSuggestion } from '@/lib/budget-suggestions';
import { buildApplyPayload, canApplySuggestion, summarizeSuggestion } from '@/lib/budget-suggestions';

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

interface Row {
  label: string;
  field: CapOverrideField;
  s: CapSuggestion;
}

function ApplyCell({ field, s }: { field: CapOverrideField; s: CapSuggestion }) {
  const router = useRouter();
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canApplySuggestion(s.recommendation)) {
    return <span className="text-xs text-zinc-600">—</span>;
  }

  async function apply() {
    setApplying(true);
    setError(null);
    try {
      const payload = buildApplyPayload(field, s);
      const res = await fetch('/api/budget-caps', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'could not apply suggestion');
      setApplied(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not apply suggestion');
    } finally {
      setApplying(false);
    }
  }

  if (applied) {
    return <span className="text-xs text-emerald-400">Applied</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={() => void apply()}
        disabled={applying}
        className="px-2.5 py-1 rounded text-xs font-medium bg-teal-600/90 hover:bg-teal-500 disabled:opacity-50 text-white transition-colors whitespace-nowrap"
      >
        {applying ? 'Applying…' : 'Apply suggestion'}
      </button>
      {error && <span className="text-xs text-rose-400 max-w-[160px] text-right">{error}</span>}
    </div>
  );
}

function SuggestionRow({ row }: { row: Row }) {
  const { s, field } = row;
  const { deltaUsd } = summarizeSuggestion(s);
  return (
    <tr className="hover:bg-zinc-800/30 transition-colors">
      <td className="m-title px-4 py-2.5 text-zinc-200 font-medium">{row.label}</td>
      <td data-label="Current cap" className="px-4 py-2.5 text-right font-mono text-zinc-400">
        {fmtUsd(s.currentCapUsd)}
      </td>
      <td data-label="Suggested cap" className="px-4 py-2.5 text-right font-mono text-zinc-200">
        {fmtUsd(s.suggestedCapUsd)}
        {deltaUsd !== 0 && (
          <span className={`ml-1 text-xs ${deltaUsd > 0 ? 'text-orange-400' : 'text-blue-400'}`}>
            ({deltaUsd > 0 ? '+' : ''}{fmtUsd(deltaUsd)})
          </span>
        )}
      </td>
      <td data-label="Observed days" className="px-4 py-2.5 text-right text-xs text-zinc-500 font-mono">
        {s.observedDays}
      </td>
      <td data-label="Recommendation" className="px-4 py-2.5">
        <RecommendationBadge recommendation={s.recommendation} />
      </td>
      <td data-label="Rationale" className="px-4 py-2.5 text-xs text-zinc-500 max-w-[360px]">
        {s.rationale}
      </td>
      <td data-label="Apply" className="px-4 py-2.5 text-right">
        <ApplyCell field={field} s={s} />
      </td>
    </tr>
  );
}

export function BudgetSuggestionsPanel({ suggestions }: { suggestions: BudgetCapSuggestions }) {
  const rows: Row[] = [
    { label: 'Monthly hard cap', field: 'monthlyHardCapUsd', s: suggestions.monthlyHardCap },
    { label: 'Daily cap', field: 'dailyCapUsd', s: suggestions.dailyCap },
    ...suggestions.perChannel.map((c) => ({ label: `Channel: ${c.channelId}`, field: 'perChannelCapUsd' as const, s: c })),
  ];

  return (
    <div className="mb-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Adaptive cap suggestions</h2>
        <span className="text-xs text-zinc-500">
          {suggestions.lookbackDays}-day lookback
        </span>
      </div>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <table className="card-table w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
              <th className="px-4 py-3">Cap</th>
              <th className="px-4 py-3 text-right">Current</th>
              <th className="px-4 py-3 text-right">Suggested</th>
              <th className="px-4 py-3 text-right">Days observed</th>
              <th className="px-4 py-3">Recommendation</th>
              <th className="px-4 py-3">Rationale</th>
              <th className="px-4 py-3 text-right">Apply</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/50">
            {rows.map((row) => (
              <SuggestionRow key={row.label} row={row} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-zinc-600">
        Applying a suggestion persists the new cap as this tenant&apos;s budget-cap override (audit-logged as
        adaptive-suggested, distinct from a manually typed value) and takes effect in the dashboard immediately.
        The gateway&apos;s own budget-guard enforcement still reads the <code className="bg-zinc-800 px-1 rounded">BUDGET_*</code> env
        vars directly, so a gateway rebuild is separately required for enforcement to pick up an applied cap.
      </p>
    </div>
  );
}
