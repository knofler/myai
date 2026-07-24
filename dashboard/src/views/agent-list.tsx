'use client';

import { useState } from 'react';
import { SearchInput } from '@/components/search-input';
import { CategoryBadge } from '@/components/category-badge';
import { DetailPanel } from '@/components/detail-panel';
import { MdSourceEditor } from '@/components/md-source-editor';

interface AgentItem {
  _id: string;
  name: string;
  description: string;
  tools: string[];
  category: string;
  loadedAt: string;
}

export function AgentList({ agents, categories }: { agents: AgentItem[]; categories: string[] }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [selected, setSelected] = useState<AgentItem | null>(null);
  const [detail, setDetail] = useState<{ instructions: string } | null>(null);

  const filtered = agents.filter(a => {
    const matchSearch = !search || a.name.toLowerCase().includes(search.toLowerCase()) || a.description.toLowerCase().includes(search.toLowerCase());
    const matchCat = !category || a.category === category;
    return matchSearch && matchCat;
  });

  async function openDetail(agent: AgentItem) {
    setSelected(agent);
    try {
      const res = await fetch(`/api/agents/${agent.name}`);
      const data = await res.json();
      setDetail(data);
    } catch {
      setDetail({ instructions: 'Failed to load agent details.' });
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <SearchInput value={search} onChange={setSearch} placeholder="Search agents..." />
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setCategory(null)}
            className={`px-2.5 py-1 text-xs rounded-md transition-colors ${!category ? 'gel-badge bg-teal-500/20 text-teal-300' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'}`}
          >
            All
          </button>
          {categories.map(c => (
            <button
              key={c}
              onClick={() => setCategory(category === c ? null : c)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${category === c ? 'gel-badge bg-teal-500/20 text-teal-300' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-zinc-600 mb-3">{filtered.length} results</p>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {filtered.map(a => (
          <button
            key={a._id}
            onClick={() => openDetail(a)}
            className="gel-surface tap-press text-left bg-zinc-900 border border-zinc-800 rounded-lg p-4 hover:border-teal-500/40 active:border-teal-500/60"
          >
            <div className="flex items-start justify-between gap-2 mb-2">
              <p className="font-medium text-sm text-zinc-200">{a.name}</p>
              <CategoryBadge category={a.category} />
            </div>
            <p className="text-xs text-zinc-500 line-clamp-2">{a.description}</p>
            <div className="flex flex-wrap gap-1 mt-3">
              {a.tools.slice(0, 5).map(t => (
                <span key={t} className="text-[10px] font-mono px-1.5 py-0.5 bg-zinc-800 rounded text-zinc-400">{t}</span>
              ))}
              {a.tools.length > 5 && (
                <span className="text-[10px] text-zinc-600">+{a.tools.length - 5}</span>
              )}
            </div>
          </button>
        ))}
      </div>

      <DetailPanel
        open={!!selected}
        onClose={() => { setSelected(null); setDetail(null); }}
        title={selected?.name || ''}
      >
        {selected && (
          <div className="space-y-4">
            <div>
              <CategoryBadge category={selected.category} />
            </div>
            <div>
              <p className="text-xs text-zinc-500 uppercase mb-1">Description</p>
              <p className="text-sm text-zinc-300">{selected.description}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500 uppercase mb-1">Tools</p>
              <div className="flex flex-wrap gap-1.5">
                {selected.tools.map(t => (
                  <span key={t} className="text-xs font-mono px-2 py-0.5 bg-zinc-800 rounded text-zinc-300">{t}</span>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs text-zinc-500 uppercase mb-1">Instructions</p>
              <pre className="text-xs text-zinc-400 bg-zinc-950 border border-zinc-800 rounded-md p-4 overflow-x-auto whitespace-pre-wrap max-h-[60vh]">
                {detail?.instructions || 'Loading...'}
              </pre>
            </div>
            <MdSourceEditor kind="agent" name={selected.name} onSaved={() => openDetail(selected)} />
          </div>
        )}
      </DetailPanel>
    </>
  );
}
