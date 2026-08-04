// Surfaces tasks currently stuck in a route_task_model exhaustion-defer
// streak (task-1a74f8c3). Commit 4c49ded added monitoring/task-defer-alerter.ts
// to fire Telegram + notify-bus alerts once the SAME task defers repeatedly —
// but until now that alert was the only operator-visible surface, so a
// starving task was invisible unless someone was watching Telegram at the
// moment it fired. Reads the same count task-store.ts's updateTaskImpl now
// mirrors onto Task.deferCount on every routeExhausted:true defer (reset to
// 0 on the next successful `working` re-stamp), so no round-trip to the
// gateway's in-process alerter state is needed.

import { Card } from '@/components/ui/card';
import { timeAgo } from '@/lib/format';

export interface TaskDeferRow {
  taskId: string;
  repo: string;
  title: string;
  deferCount: number;
  updatedAt?: Date;
}

export function TaskDeferPanel({ tasks }: { tasks: TaskDeferRow[] }) {
  if (tasks.length === 0) return null;
  const sorted = [...tasks].sort((a, b) => b.deferCount - a.deferCount);
  return (
    <Card
      accent="red"
      title="Starving on route exhaustion"
      meta={`${sorted.length} task(s) stuck re-deferring — route_task_model can't find pool headroom`}
    >
      <table className="card-table w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] text-zinc-500 border-b border-zinc-800 uppercase tracking-wider">
            <th className="px-4 py-2.5 font-medium">Repo</th>
            <th className="px-4 py-2.5 font-medium">Task</th>
            <th className="px-4 py-2.5 font-medium">Consecutive defers</th>
            <th className="px-4 py-2.5 font-medium">Last defer</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/50">
          {sorted.map((t) => (
            <tr key={t.taskId} className="hover:bg-zinc-800/30">
              <td data-label="Repo" className="px-4 py-2.5 text-zinc-500 font-mono text-xs">{t.repo}</td>
              <td data-label="Task" className="m-title px-4 py-2.5 text-zinc-200 max-w-sm truncate">{t.title}</td>
              <td data-label="Consecutive defers" className="px-4 py-2.5 text-xs font-mono text-red-400">{t.deferCount}×</td>
              <td data-label="Last defer" className="px-4 py-2.5 text-zinc-600 text-xs">{timeAgo(t.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
