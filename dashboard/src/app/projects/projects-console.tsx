'use client';

// Cross-repo orchestration console (ADR-015) — the interactive half of the
// /projects board: pick repos (or a whole project) + one task description →
// fan out N queue tasks; and reprioritize a repo's pending queue, including
// drag-and-drop between the four priority lanes. All mutations POST to
// /api/projects which writes tenant-scoped tasks; on success we refresh().

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PriorityBadge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  PRIORITIES,
  OFFERED_TOPOLOGIES,
  type Priority,
  type Topology,
} from '@/lib/projects';

export interface ConsoleRepo {
  repo: string;
  group: string;
  open: number; // pending + working
}

export interface PendingTask {
  taskId: string;
  repo: string;
  title: string;
  priority: Priority;
}

async function postAction(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; count?: number; modified?: number }> {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
  return { ok: true, ...json };
}

/* ── Fan-out composer ─────────────────────────────────────────── */

function FanoutComposer({ repos }: { repos: ConsoleRepo[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Priority>('P2');
  const [topology, setTopology] = useState<Topology | ''>('');
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const groups = Array.from(new Set(repos.map((r) => r.group)));

  function toggle(repo: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  }
  function selectGroup(group: string) {
    const inGroup = repos.filter((r) => r.group === group).map((r) => r.repo);
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = inGroup.every((r) => next.has(r));
      for (const r of inGroup) allOn ? next.delete(r) : next.add(r);
      return next;
    });
  }

  function submit() {
    setMsg(null);
    start(async () => {
      const res = await postAction({
        action: 'fanout',
        repos: [...selected],
        title,
        priority,
        topology: topology || undefined,
      });
      if (!res.ok) {
        setMsg(`✗ ${res.error}`);
        return;
      }
      setMsg(`✓ Dispatched ${res.count} task${res.count === 1 ? '' : 's'} across ${selected.size} repo${selected.size === 1 ? '' : 's'}.`);
      setTitle('');
      setSelected(new Set());
      router.refresh();
    });
  }

  const canSubmit = selected.size > 0 && title.trim().length > 0 && !pending;

  return (
    <Card accent="blue" title="Bulk dispatch — fan out one task across repos" meta={`${selected.size} selected`}>
      <div className="p-4 space-y-4">
        <div>
          <label className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1.5">Task description</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={300}
            placeholder="e.g. Bump Next.js to 15.4 and run the test suite"
            className="w-full bg-zinc-950/60 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500/50 focus:outline-none"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-[11px] uppercase tracking-wider text-zinc-500">Repos</label>
            <div className="flex flex-wrap gap-1.5">
              {groups.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => selectGroup(g)}
                  className="text-[10px] px-2 py-0.5 rounded-full border border-zinc-800 text-zinc-400 hover:text-teal-300 hover:border-teal-500/40 transition-colors"
                >
                  + {g}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
            {repos.map((r) => {
              const on = selected.has(r.repo);
              return (
                <button
                  key={r.repo}
                  type="button"
                  onClick={() => toggle(r.repo)}
                  aria-pressed={on}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border transition-colors ${
                    on
                      ? 'bg-blue-500/15 border-blue-500/40 text-blue-300 font-medium'
                      : 'bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                  }`}
                >
                  <span className="font-mono">{r.repo}</span>
                  {r.open > 0 && <span className="text-[10px] px-1 rounded-full bg-zinc-800 text-zinc-500">{r.open}</span>}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1.5">Priority</label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              className="bg-zinc-950/60 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:border-blue-500/50 focus:outline-none"
            >
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1.5">Strategy hint</label>
            <select
              value={topology}
              onChange={(e) => setTopology(e.target.value as Topology | '')}
              className="bg-zinc-950/60 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:border-blue-500/50 focus:outline-none"
              title="A strategy hint stamped on each task — independent lanes, not guaranteed ordering."
            >
              <option value="">none</option>
              {OFFERED_TOPOLOGIES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="ml-auto px-4 py-2 rounded-lg bg-blue-500/15 border border-blue-500/40 text-sm font-medium text-blue-300 hover:bg-blue-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {pending ? 'Dispatching…' : `Dispatch to ${selected.size || 0} repo${selected.size === 1 ? '' : 's'}`}
          </button>
        </div>

        <p className="text-[11px] text-zinc-600">
          Each repo gets one independent queue task. The strategy hint is an execution note for the agents — not a synchronization guarantee.
        </p>
        {msg && <p className={`text-xs ${msg.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}`}>{msg}</p>}
      </div>
    </Card>
  );
}

/* ── Reprioritize board — drag pending tasks between priority lanes ── */

function ReprioritizeBoard({ tasks }: { tasks: PendingTask[] }) {
  const router = useRouter();
  const [local, setLocal] = useState<PendingTask[]>(tasks);
  const [dragId, setDragId] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function move(taskId: string, priority: Priority) {
    const task = local.find((t) => t.taskId === taskId);
    if (!task || task.priority === priority) return;
    // Optimistic — snap the card into the new lane, then persist.
    setLocal((prev) => prev.map((t) => (t.taskId === taskId ? { ...t, priority } : t)));
    setMsg(null);
    start(async () => {
      const res = await postAction({ action: 'reprioritize', taskIds: [taskId], priority });
      if (!res.ok) {
        setLocal(tasks); // revert to server truth
        setMsg(`✗ ${res.error}`);
        return;
      }
      router.refresh();
    });
  }

  const byPriority = (p: Priority) => local.filter((t) => t.priority === p);

  return (
    <Card title="Reprioritize — drag pending tasks between lanes" meta={`${local.length} pending`}>
      <div className="p-4">
        {local.length === 0 ? (
          <p className="text-sm text-zinc-600 text-center py-6">No pending tasks to reprioritize.</p>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {PRIORITIES.map((p) => (
              <div
                key={p}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => { if (dragId) move(dragId, p); setDragId(null); }}
                className="rounded-lg border border-zinc-800 bg-zinc-950/40 min-h-32 p-2 space-y-2"
              >
                <div className="flex items-center justify-between px-1 pb-1 border-b border-zinc-800/60">
                  <PriorityBadge priority={p} />
                  <span className="text-[10px] text-zinc-600">{byPriority(p).length}</span>
                </div>
                {byPriority(p).map((t) => (
                  <div
                    key={t.taskId}
                    draggable
                    onDragStart={() => setDragId(t.taskId)}
                    onDragEnd={() => setDragId(null)}
                    title={`${t.repo}: ${t.title}`}
                    className={`rounded-md border border-zinc-800 bg-zinc-900/70 px-2 py-1.5 cursor-grab active:cursor-grabbing hover:border-zinc-700 transition-colors ${
                      dragId === t.taskId ? 'opacity-50' : ''
                    }`}
                  >
                    <p className="text-xs text-zinc-200 truncate">{t.title}</p>
                    <p className="text-[10px] text-zinc-500 font-mono truncate">{t.repo}</p>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-[11px] text-zinc-600">
          Drag a card to a new lane to change its priority{pending ? ' · saving…' : ''}.
        </p>
        {msg && <p className={`mt-1 text-xs ${msg.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}`}>{msg}</p>}
      </div>
    </Card>
  );
}

export function ProjectsConsole({ repos, pendingTasks }: { repos: ConsoleRepo[]; pendingTasks: PendingTask[] }) {
  return (
    <div className="space-y-6">
      <FanoutComposer repos={repos} />
      <ReprioritizeBoard tasks={pendingTasks} />
    </div>
  );
}
