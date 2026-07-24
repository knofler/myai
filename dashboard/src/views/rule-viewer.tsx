'use client';

import { useState } from 'react';
import { CategoryBadge } from '@/components/category-badge';
import { DetailPanel } from '@/components/detail-panel';

interface RuleItem {
  _id: string;
  name: string;
  description: string;
  category: string;
  content: string;
}

function RuleContent({ rule, bare = false }: { rule: RuleItem; bare?: boolean }) {
  return (
    <div className={bare ? '' : 'bg-zinc-900 border border-zinc-800 rounded-lg'}>
      <div className={bare ? 'pb-4 border-b border-zinc-800' : 'px-6 py-4 border-b border-zinc-800'}>
        <div className="flex items-center gap-2 mb-1">
          <CategoryBadge category={rule.category} />
        </div>
        {!bare && <h2 className="text-lg font-semibold text-zinc-100">{rule.name}</h2>}
        <p className="text-xs text-zinc-500">{rule.description}</p>
      </div>
      <pre
        className={`text-xs text-zinc-400 overflow-x-auto whitespace-pre-wrap break-words ${
          bare ? 'pt-4' : 'p-6 max-h-[70vh] overflow-y-auto'
        }`}
      >
        {rule.content}
      </pre>
    </div>
  );
}

export function RuleViewer({ rules }: { rules: RuleItem[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const active = rules.find(r => r._id === selected);

  return (
    <div className="flex flex-col md:flex-row gap-4">
      {/* List: full-width on phones, fixed rail on md+. */}
      <div className="w-full md:w-72 shrink-0 space-y-2">
        {rules.map(r => (
          <button
            key={r._id}
            onClick={() => setSelected(r._id)}
            className={`tap-press w-full text-left p-3 rounded-lg border ${
              selected === r._id
                ? 'bg-emerald-500/10 border-emerald-500/30'
                : 'bg-zinc-900 border-zinc-800 hover:border-zinc-700 active:border-emerald-500/40'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <CategoryBadge category={r.category} />
            </div>
            <p className="font-medium text-sm text-zinc-200">{r.name}</p>
            <p className="text-xs text-zinc-500 line-clamp-2 mt-0.5">{r.description}</p>
          </button>
        ))}
      </div>

      {/* md+: inline reading pane (the classic two-column view). */}
      <div className="hidden md:block flex-1 min-w-0">
        {active ? (
          <RuleContent rule={active} />
        ) : (
          <div className="flex items-center justify-center h-64 text-zinc-600 text-sm">
            Select a rule to view its content
          </div>
        )}
      </div>

      {/* Phones: the two-column squeeze left the reading pane ~90px wide —
          unreadable. Selection opens the full-width DetailPanel sheet instead. */}
      <div className="md:hidden">
        <DetailPanel open={!!active} onClose={() => setSelected(null)} title={active?.name ?? ''}>
          {active && <RuleContent rule={active} bare />}
        </DetailPanel>
      </div>
    </div>
  );
}
