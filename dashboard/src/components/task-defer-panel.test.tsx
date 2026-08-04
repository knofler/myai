// Component test for TaskDeferPanel (task-1a74f8c3 follow-up) — commit
// 4c49ded added monitoring/task-defer-alerter.ts to alert on consecutive
// route_task_model exhaustion defers, but the only consumer was Telegram +
// notify-bus: an operator only learned about starvation if watching Telegram
// at the moment it fired. task-store.ts's updateTaskImpl now mirrors the
// alerter's per-task counter onto Task.deferCount; this test proves the
// dashboard actually renders a task carrying a nonzero counter, not just
// that the field exists on the doc.
//
// No jsdom/Testing-Library dependency — same pattern as pool-capacity-panel.test.tsx:
// renders to a static HTML string via react-dom/server and asserts on markup.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskDeferPanel, type TaskDeferRow } from './task-defer-panel';

describe('TaskDeferPanel', () => {
  it('renders nothing when no tasks are currently deferring', () => {
    const html = renderToStaticMarkup(<TaskDeferPanel tasks={[]} />);
    expect(html).toBe('');
  });

  it('renders a task with a nonzero consecutive-defer counter', () => {
    const tasks: TaskDeferRow[] = [
      {
        taskId: 'task-abc123',
        repo: 'ai_management',
        title: 'Wire BudgetCapOverride into gateway enforcement path',
        deferCount: 5,
        updatedAt: new Date(),
      },
    ];
    const html = renderToStaticMarkup(<TaskDeferPanel tasks={tasks} />);
    expect(html).toContain('Starving on route exhaustion');
    expect(html).toContain('1 task(s) stuck re-deferring');
    expect(html).toContain('ai_management');
    expect(html).toContain('Wire BudgetCapOverride into gateway enforcement path');
    expect(html).toContain('5×');
  });

  it('sorts multiple starving tasks by consecutive-defer count, worst first', () => {
    const tasks: TaskDeferRow[] = [
      { taskId: 'task-low', repo: 'repo-a', title: 'low', deferCount: 3 },
      { taskId: 'task-high', repo: 'repo-b', title: 'high', deferCount: 9 },
    ];
    const html = renderToStaticMarkup(<TaskDeferPanel tasks={tasks} />);
    expect(html.indexOf('task-high')).toBeLessThan(0); // taskId isn't rendered directly
    expect(html.indexOf('9×')).toBeLessThan(html.indexOf('3×'));
  });
});
