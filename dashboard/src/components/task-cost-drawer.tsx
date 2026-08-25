'use client';

import { useState } from 'react';
import { DetailPanel } from '@/components/detail-panel';
import { fmtTokens, fmtUsd } from '@/lib/format';

// Response contract of GET /api/tasks/[taskId]/cost — keep in sync with
// src/app/api/tasks/[taskId]/cost/route.ts.
export interface TaskCostData {
  task: {
    taskId: string;
    repo?: string;
    title?: string;
    status?: string;
    assignedAgent?: string;
    executionLane?: string;
    executionProvider?: string;
    routedModel?: string;
    routedProfile?: string;
    retryCount: number;
    maxRetries?: number;
  };
  run: {
    startedAt?: string;
    completedAt?: string;
    durationSec?: number;
    durationSource: 'meter' | 'timestamps' | 'unknown';
    offhoursMinutes?: number;
    premium: boolean;
    finalStatus?: string;
    meterEvents: number;
  };
  spend: {
    attribution: 'repo-window' | 'none';
    windowFrom?: string;
    windowTo?: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    costUsd: number;
    byModel: Array<{ model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }>;
  };
}

/** "1h 4m" / "12m 30s" / "45s" from a plain seconds count (the meter's unit). */
export function fmtDurationSec(secs?: number): string {
  if (secs === undefined || !Number.isFinite(secs) || secs < 0) return '—';
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  if (mins < 60) return `${mins}m ${s % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-[rgb(var(--bg-page))] border border-[rgb(var(--border-subtle))] rounded-md px-3 py-2.5">
      <p className="text-[11px] text-[rgb(var(--text-muted))] uppercase tracking-wider">{label}</p>
      <p className="text-lg font-semibold text-[rgb(var(--text-primary))] mt-0.5">{value}</p>
      {sub && <p className="text-xs text-[rgb(var(--text-muted))] mt-0.5">{sub}</p>}
    </div>
  );
}

/** Pure body of the cost drawer — separated from the stateful button so tests
 *  can renderToStaticMarkup it without jsdom. */
export function TaskCostDetails({ data }: { data: TaskCostData }) {
  const { task, run, spend } = data;
  const model = task.routedModel ?? (spend.byModel.length === 1 ? spend.byModel[0].model : undefined);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Token spend"
          value={`${fmtTokens(spend.outputTokens)} out`}
          sub={`${fmtTokens(spend.inputTokens)} in · ${fmtTokens(spend.cacheReadInputTokens)} cache-read`}
        />
        <Stat
          label="Metered cost"
          value={fmtUsd(spend.costUsd)}
          sub={`${spend.calls} metered call${spend.calls === 1 ? '' : 's'}`}
        />
        <Stat
          label="Wall-clock"
          value={fmtDurationSec(run.durationSec)}
          sub={run.durationSource === 'meter' ? 'from meter' : run.durationSource === 'timestamps' ? 'from task stamps' : undefined}
        />
        <Stat
          label="Retries"
          value={`${task.retryCount}${task.maxRetries !== undefined ? ` / ${task.maxRetries}` : ''}`}
          sub={task.retryCount === 0 ? 'clean first run' : undefined}
        />
      </div>

      <div>
        <p className="text-[11px] text-[rgb(var(--text-muted))] uppercase tracking-wider mb-2">Model</p>
        {model && (
          <p className="text-sm text-[rgb(var(--text-primary))] font-mono">
            {model}
            {task.routedProfile && <span className="text-xs text-[rgb(var(--text-muted))] font-sans ml-2">via {task.routedProfile}</span>}
          </p>
        )}
        {!model && spend.byModel.length === 0 && (
          <p className="text-sm text-[rgb(var(--text-muted))]">
            No model stamped on the task and no metered LLM calls in the run window
            {task.executionLane ? ` — the ${task.executionLane} lane bills outside the gateway meter` : ''}.
          </p>
        )}
        {spend.byModel.length > 1 && (
          <ul className="space-y-1 mt-1">
            {spend.byModel.map((m) => (
              <li key={m.model} className="flex items-center justify-between text-xs bg-[rgb(var(--bg-page))] border border-[rgb(var(--border-subtle))] rounded px-2.5 py-1.5">
                <span className="font-mono text-[rgb(var(--text-primary))]">{m.model}</span>
                <span className="text-[rgb(var(--text-muted))]">
                  {m.calls} call{m.calls === 1 ? '' : 's'} · {fmtTokens(m.inputTokens)} in / {fmtTokens(m.outputTokens)} out · {fmtUsd(m.costUsd)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-[11px] text-[rgb(var(--text-muted))] uppercase tracking-wider mb-2">Metering</p>
        <dl className="text-xs space-y-1.5">
          <div className="flex justify-between gap-3">
            <dt className="text-[rgb(var(--text-muted))]">Billable unit</dt>
            <dd className="text-[rgb(var(--text-primary))]">{run.premium ? 'premium (runner-claimed session)' : 'standard'}</dd>
          </div>
          {run.offhoursMinutes !== undefined && (
            <div className="flex justify-between gap-3">
              <dt className="text-[rgb(var(--text-muted))]">Off-hours minutes</dt>
              <dd className="text-[rgb(var(--text-primary))]">{run.offhoursMinutes} min</dd>
            </div>
          )}
          {run.finalStatus && (
            <div className="flex justify-between gap-3">
              <dt className="text-[rgb(var(--text-muted))]">Metered outcome</dt>
              <dd className="text-[rgb(var(--text-primary))]">{run.finalStatus}</dd>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <dt className="text-[rgb(var(--text-muted))]">Usage events</dt>
            <dd className="text-[rgb(var(--text-primary))]">{run.meterEvents}</dd>
          </div>
        </dl>
        <p className="text-[11px] text-[rgb(var(--text-muted))] mt-3 leading-relaxed">
          {spend.attribution === 'repo-window'
            ? <>Token spend is attributed by repo + run window (metered gateway calls on <span className="font-mono">{task.repo}</span> during this run) — the runner&apos;s own subscription-billed session tokens are not metered per call.</>
            : 'No run window recorded (task never started) — token spend cannot be attributed.'}
        </p>
      </div>
    </div>
  );
}

/** Cost/duration drill-in affordance for a completed task — click opens a
 *  drawer with token spend, wall-clock, model, and retries sourced from the
 *  metering events, so an operator sees per-task ROI without grepping Mongo. */
export function TaskCostButton({ taskId, title }: { taskId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<TaskCostData | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function openDrawer() {
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/cost`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json() as TaskCostData);
    } catch {
      setData(null);
      setError('Could not load cost details.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        onClick={openDrawer}
        className="tap-press text-xs text-[rgb(var(--text-secondary))] hover:text-emerald-400 underline decoration-zinc-700"
      >
        Cost
      </button>
      <DetailPanel open={open} onClose={() => setOpen(false)} title={title}>
        {loading && <p className="text-sm text-[rgb(var(--text-muted))]">Loading cost details…</p>}
        {!loading && error && <p className="text-sm text-[rgb(var(--text-muted))]">{error}</p>}
        {!loading && !error && data && <TaskCostDetails data={data} />}
      </DetailPanel>
    </>
  );
}
