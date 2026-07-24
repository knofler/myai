'use client';

import { useState } from 'react';
import { SearchInput } from '@/components/search-input';
import { DetailPanel } from '@/components/detail-panel';
import { MdSourceEditor } from '@/components/md-source-editor';

interface SkillItem {
  _id: string;
  name: string;
  description: string;
  triggers: string[];
  loadedAt: string;
}

export function SkillList({ skills }: { skills: SkillItem[] }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<SkillItem | null>(null);
  const [detail, setDetail] = useState<{ playbook: string } | null>(null);

  const filtered = skills.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.triggers.some(t => t.includes(q));
  });

  async function openDetail(skill: SkillItem) {
    setSelected(skill);
    try {
      const res = await fetch(`/api/skills/${skill.name}`);
      const data = await res.json();
      setDetail(data);
    } catch {
      setDetail({ playbook: 'Failed to load skill details.' });
    }
  }

  return (
    <>
      <div className="mb-6">
        <SearchInput value={search} onChange={setSearch} placeholder="Search skills by name or trigger..." />
      </div>

      <p className="text-xs text-zinc-600 mb-3">{filtered.length} results</p>

      <div className="space-y-2">
        {filtered.map(s => (
          <button
            key={s._id}
            onClick={() => openDetail(s)}
            className="gel-surface tap-press w-full text-left bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 hover:border-teal-500/40 active:border-teal-500/60 flex items-start gap-3 sm:gap-4 overflow-hidden"
          >
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm text-zinc-200 truncate">{s.name}</p>
              <p className="text-xs text-zinc-500 line-clamp-2 sm:line-clamp-1 mt-0.5">{s.description}</p>
            </div>
            <div className="hidden sm:flex flex-wrap justify-end gap-1 shrink-0 max-w-[200px]">
              {s.triggers.slice(0, 3).map(t => (
                <span key={t} className="text-[10px] font-mono px-1.5 py-0.5 bg-zinc-800 rounded text-zinc-400 truncate max-w-[110px]">{t}</span>
              ))}
              {s.triggers.length > 3 && (
                <span className="text-[10px] text-zinc-600">+{s.triggers.length - 3}</span>
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
              <p className="text-xs text-zinc-500 uppercase mb-1">Description</p>
              <p className="text-sm text-zinc-300">{selected.description}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500 uppercase mb-1">Triggers</p>
              <div className="flex flex-wrap gap-1.5">
                {selected.triggers.map(t => (
                  <span key={t} className="text-xs font-mono px-2 py-0.5 bg-zinc-800 rounded text-zinc-300">{t}</span>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs text-zinc-500 uppercase mb-1">Playbook</p>
              <pre className="text-xs text-zinc-400 bg-zinc-950 border border-zinc-800 rounded-md p-4 overflow-x-auto whitespace-pre-wrap max-h-[60vh]">
                {detail?.playbook || 'Loading...'}
              </pre>
            </div>
            <MdSourceEditor kind="skill" name={selected.name} onSaved={() => openDetail(selected)} />
          </div>
        )}
      </DetailPanel>
    </>
  );
}
