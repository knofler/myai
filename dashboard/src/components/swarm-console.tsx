'use client';

// SwarmConsole — the product-facing surface for the swarm-coordinator.
// Two panes: (1) a topology PICKER that recommends a default from the task
// description and lets the operator override, and (2) a live LANE view that
// ticks a decomposed task pending → running → done under the chosen topology's
// dispatch rules. All the logic is in @/lib/swarm; this is the renderer.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  TOPOLOGIES,
  getTopology,
  recommendTopology,
  newRun,
  advanceRun,
  runProgress,
  groupByLane,
  type TopologyId,
  type SwarmRun,
  type StepStatus,
} from '@/lib/swarm';
import { Card } from '@/components/ui/card';

const TICK_MS = 900;

const ACCENT_RING: Record<string, string> = {
  purple: 'border-purple-500/60 ring-purple-500/30',
  blue: 'border-blue-500/60 ring-blue-500/30',
  emerald: 'border-emerald-500/60 ring-emerald-500/30',
  amber: 'border-amber-500/60 ring-amber-500/30',
};

function StatusDot({ status }: { status: StepStatus }) {
  const cls =
    status === 'done'
      ? 'bg-emerald-400'
      : status === 'running'
        ? 'bg-amber-400 animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.7)]'
        : 'bg-zinc-700';
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${cls}`} aria-hidden="true" />;
}

function statusLabel(status: StepStatus): string {
  return status === 'done' ? 'done' : status === 'running' ? 'running' : 'queued';
}

export function SwarmConsole() {
  const [task, setTask] = useState('');
  const recommended = useMemo(() => recommendTopology(task), [task]);
  const [selected, setSelected] = useState<TopologyId>('hierarchical');
  const [run, setRun] = useState<SwarmRun>(() => newRun('hierarchical'));
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const progress = runProgress(run.steps);
  const lanes = groupByLane(run.steps);
  const topology = getTopology(selected);

  // Drive the live view while "playing". Stops itself once the run completes.
  useEffect(() => {
    if (!playing) return;
    timer.current = setInterval(() => {
      setRun((prev) => {
        const next = advanceRun(prev);
        if (runProgress(next.steps).complete) setPlaying(false);
        return next;
      });
    }, TICK_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing]);

  function choose(id: TopologyId) {
    setSelected(id);
    setRun(newRun(id));
    setPlaying(false);
  }

  function dispatch() {
    setRun(newRun(selected));
    setPlaying(true);
  }

  function stepOnce() {
    setPlaying(false);
    setRun((prev) => advanceRun(prev));
  }

  function reset() {
    setPlaying(false);
    setRun(newRun(selected));
  }

  return (
    <div className="space-y-6">
      {/* ── Task + recommendation ─────────────────────────── */}
      <Card title="Dispatch a multi-agent task" accent="purple">
        <div className="p-4 space-y-3">
          <label htmlFor="swarm-task" className="block text-xs text-zinc-500 uppercase tracking-wider">
            What should the swarm build?
          </label>
          <textarea
            id="swarm-task"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={2}
            placeholder="e.g. Add user authentication with JWT — schema, middleware, login page, tests"
            className="w-full rounded-lg bg-zinc-950/60 border border-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-teal-500/50"
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-zinc-500">Recommended topology:</span>
            <button
              type="button"
              onClick={() => choose(recommended.id)}
              className="gel-surface rounded-full border border-teal-500/40 px-2.5 py-1 text-teal-200 hover:border-teal-400 transition"
            >
              {getTopology(recommended.id).icon} {getTopology(recommended.id).name}
            </button>
            <span className="text-zinc-600">— {recommended.reason}</span>
          </div>
        </div>
      </Card>

      {/* ── Topology picker ───────────────────────────────── */}
      <div>
        <h2 className="text-sm font-semibold text-zinc-200 mb-3">Topology</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {TOPOLOGIES.map((t) => {
            const active = t.id === selected;
            const isRec = t.id === recommended.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => choose(t.id)}
                aria-pressed={active}
                className={`text-left gel-surface bg-zinc-900/70 border rounded-xl p-4 transition ${
                  active
                    ? `${ACCENT_RING[t.accent]} ring-1`
                    : 'border-zinc-800 hover:border-zinc-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-zinc-100">
                    <span className="font-mono opacity-70 mr-1.5">{t.icon}</span>
                    {t.name}
                  </span>
                  {isRec && (
                    <span className="text-[10px] rounded-full bg-teal-500/15 text-teal-300 px-1.5 py-0.5">
                      suggested
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-400 mt-1.5">{t.tagline}</p>
                <pre className="mt-3 text-[10px] leading-tight text-zinc-600 font-mono whitespace-pre overflow-hidden">
                  {t.diagram}
                </pre>
                <p className="text-[10px] text-zinc-500 mt-2">
                  <span className="text-zinc-400">Select when:</span> {t.selectWhen}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Live lane view ────────────────────────────────── */}
      <Card
        title={`Live lanes — ${topology.name}`}
        accent={topology.accent}
        meta={
          <span className="font-mono">
            {progress.done}/{progress.total} done · {progress.pct}%
            {progress.complete ? ' · ✓ merged' : playing ? ' · running…' : ''}
          </span>
        }
      >
        <div className="p-4 space-y-4">
          {/* controls */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={dispatch}
              disabled={playing}
              className="rounded-lg bg-teal-500/15 border border-teal-500/40 text-teal-200 px-3 py-1.5 text-xs font-medium hover:border-teal-400 disabled:opacity-40 transition"
            >
              ▶ Dispatch
            </button>
            <button
              type="button"
              onClick={stepOnce}
              disabled={progress.complete}
              className="rounded-lg border border-zinc-700 text-zinc-300 px-3 py-1.5 text-xs hover:border-zinc-500 disabled:opacity-40 transition"
            >
              Step
            </button>
            <button
              type="button"
              onClick={() => setPlaying(false)}
              disabled={!playing}
              className="rounded-lg border border-zinc-700 text-zinc-300 px-3 py-1.5 text-xs hover:border-zinc-500 disabled:opacity-40 transition"
            >
              Pause
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-lg border border-zinc-700 text-zinc-300 px-3 py-1.5 text-xs hover:border-zinc-500 transition"
            >
              Reset
            </button>
          </div>

          {/* progress bar */}
          <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-teal-400 transition-[width] duration-500 ease-out"
              style={{ width: `${progress.pct}%` }}
              role="progressbar"
              aria-valuenow={progress.pct}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>

          {/* lanes */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            {lanes.map(({ lane, steps }) => (
              <div key={lane.id} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                <div className="flex items-baseline justify-between mb-2">
                  <span className="text-xs font-semibold text-zinc-300">
                    Lane {lane.id} · {lane.name}
                  </span>
                  <span className="text-[10px] text-zinc-600">
                    {steps.filter((s) => s.status === 'done').length}/{steps.length}
                  </span>
                </div>
                <ul className="space-y-2">
                  {steps.map((s) => (
                    <li key={s.id} className="flex items-start gap-2">
                      <span className="mt-1">
                        <StatusDot status={s.status} />
                      </span>
                      <span className="min-w-0">
                        <span
                          className={`block text-xs ${
                            s.status === 'done' ? 'text-zinc-500 line-through' : 'text-zinc-200'
                          }`}
                        >
                          {s.title}
                        </span>
                        <span className="block text-[10px] text-zinc-600 font-mono">
                          {s.agent} · {statusLabel(s.status)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-zinc-600">
            Demo decomposition (JWT auth) dispatched under <span className="text-zinc-400">{topology.name}</span> rules —
            {topology.id === 'ring'
              ? ' strictly sequential, one stage at a time.'
              : topology.id === 'star'
                ? ' all sub-tasks fan out in parallel.'
                : ' dependency-gated parallelism across lanes.'}
          </p>
        </div>
      </Card>
    </div>
  );
}
