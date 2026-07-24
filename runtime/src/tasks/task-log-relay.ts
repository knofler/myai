/**
 * Live task-output relay — streams a running task's incremental stdout/stderr
 * lines to dashboard subscribers over SSE while the task is in flight.
 *
 * Distinct from `notifications/sse-manager.ts`: that stream carries dotted
 * lifecycle events (task.created, dispatch.completed, …). THIS relay carries
 * the raw in-progress log *body* of one specific task, keyed by taskId rather
 * than tenant. Tenant scoping is enforced by the HTTP route (it resolves the
 * task via the tenant-scoped `getTask` before touching the relay), so this
 * module itself only ever deals in taskId + already-authorized chunks.
 *
 * Backpressure: a subscriber is a plain callback, not a raw socket, so the
 * relay itself never blocks on a slow client — but a slow client's callback
 * (typically `res.write`) can still fall behind a fast-writing runner. Rather
 * than letting per-client backlog grow unbounded, each subscriber gets a
 * small bounded queue (`MAX_QUEUE`); once full, the oldest queued chunk is
 * dropped and replaced with a synthetic `{ dropped: true }` marker so the
 * client can render a "N lines skipped" gap instead of silently losing data
 * or the relay silently OOMing on one stalled reader.
 *
 * A short in-memory backlog per task (`MAX_BACKLOG` chunks) lets a client
 * that opens the stream mid-task replay recent output instead of starting
 * blank. Buffers are evicted `EVICT_AFTER_MS` after the task is marked done
 * (via `endTaskLog`) and has no active subscribers, so memory doesn't grow
 * unboundedly across the life of the gateway process.
 */
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'task-log-relay' });

export type LogStream = 'stdout' | 'stderr';

export interface TaskLogChunk {
  /** Monotonic per-task sequence number, assigned by the relay. */
  seq: number;
  stream: LogStream;
  text: string;
  timestamp: Date;
  /** Set on the final chunk emitted for a task (see endTaskLog). */
  done?: boolean;
  /** Synthetic marker chunk standing in for lines dropped by backpressure. */
  dropped?: boolean;
}

/** Per-connection sender. Implementations must never throw. */
export type TaskLogSend = (chunk: TaskLogChunk) => void;

const MAX_BACKLOG = 500;
const MAX_QUEUE = 200;
const EVICT_AFTER_MS = 10 * 60_000; // 10 minutes after done + no subscribers

interface TaskLogState {
  backlog: TaskLogChunk[];
  subscribers: Set<TaskLogSend>;
  nextSeq: number;
  done: boolean;
  evictTimer?: ReturnType<typeof setTimeout>;
}

class TaskLogRelay {
  private tasks = new Map<string, TaskLogState>();

  private stateFor(taskId: string): TaskLogState {
    let state = this.tasks.get(taskId);
    if (!state) {
      state = { backlog: [], subscribers: new Set(), nextSeq: 0, done: false };
      this.tasks.set(taskId, state);
    }
    return state;
  }

  private clearEvictTimer(state: TaskLogState): void {
    if (state.evictTimer) {
      clearTimeout(state.evictTimer);
      state.evictTimer = undefined;
    }
  }

  private scheduleEvictIfIdle(taskId: string, state: TaskLogState): void {
    if (!state.done || state.subscribers.size > 0) return;
    this.clearEvictTimer(state);
    const timer = setTimeout(() => {
      const current = this.tasks.get(taskId);
      if (current && current.done && current.subscribers.size === 0) {
        this.tasks.delete(taskId);
        log.debug({ taskId }, 'Task log buffer evicted');
      }
    }, EVICT_AFTER_MS);
    timer.unref?.();
    state.evictTimer = timer;
  }

  /** Append a log chunk for a task and fan it out to live subscribers. */
  append(taskId: string, input: { stream?: LogStream; text: string }): TaskLogChunk {
    const state = this.stateFor(taskId);
    const chunk: TaskLogChunk = {
      seq: state.nextSeq++,
      stream: input.stream ?? 'stdout',
      text: input.text,
      timestamp: new Date(),
    };
    this.publish(taskId, state, chunk);
    return chunk;
  }

  /** Mark the task's log stream complete — final chunk subscribers can key a "task finished" UI state off. */
  end(taskId: string): void {
    const state = this.stateFor(taskId);
    if (state.done) return;
    state.done = true;
    const chunk: TaskLogChunk = { seq: state.nextSeq++, stream: 'stdout', text: '', timestamp: new Date(), done: true };
    this.publish(taskId, state, chunk);
    this.scheduleEvictIfIdle(taskId, state);
  }

  private publish(taskId: string, state: TaskLogState, chunk: TaskLogChunk): void {
    state.backlog.push(chunk);
    if (state.backlog.length > MAX_BACKLOG) state.backlog.splice(0, state.backlog.length - MAX_BACKLOG);

    for (const send of state.subscribers) {
      try {
        send(chunk);
      } catch (err) {
        log.warn({ err, taskId }, 'Task log send failed — removing subscriber');
        state.subscribers.delete(send);
      }
    }
  }

  /**
   * Subscribe to live chunks for a task. Returns the current backlog (for
   * immediate replay) plus an unsubscribe function. `send` must be
   * non-blocking from the relay's point of view — callers that wrap a raw
   * socket (e.g. HTTP SSE) should use `wrapBackpressureSafe` below so a slow
   * reader can't stall or OOM the relay.
   */
  subscribe(taskId: string, send: TaskLogSend): { backlog: TaskLogChunk[]; unsubscribe: () => void } {
    const state = this.stateFor(taskId);
    this.clearEvictTimer(state);
    state.subscribers.add(send);
    log.debug({ taskId, subscribers: state.subscribers.size }, 'Task log subscriber added');
    const backlog = state.backlog.slice();
    return {
      backlog,
      unsubscribe: () => {
        state.subscribers.delete(send);
        log.debug({ taskId, subscribers: state.subscribers.size }, 'Task log subscriber removed');
        this.scheduleEvictIfIdle(taskId, state);
      },
    };
  }

  /** True when the task has a live backlog/subscriber entry. */
  hasState(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  subscriberCount(taskId: string): number {
    return this.tasks.get(taskId)?.subscribers.size ?? 0;
  }

  /** Test/process-shutdown helper — drops all state. */
  clear(): void {
    for (const state of this.tasks.values()) this.clearEvictTimer(state);
    this.tasks.clear();
  }
}

/** Process-wide singleton. */
export const taskLogRelay = new TaskLogRelay();

/**
 * Wrap a raw, potentially-blocking sender (e.g. `res.write` over a socket
 * that can apply TCP backpressure) into a `TaskLogSend` that is safe to hand
 * to `subscribe()`: chunks queue up to `MAX_QUEUE` while the underlying
 * writer reports itself busy, and the queue drops its oldest entry (replacing
 * it with a `dropped` marker) rather than growing without bound.
 *
 * `rawSend` returns `false` when the caller should pause (mirrors
 * `stream.write()`); `onDrain` lets the wrapper hook a resume signal (mirrors
 * the `'drain'` event). Both are optional — omit them for a sender that's
 * always ready (e.g. an in-process array collector in tests).
 */
export function wrapBackpressureSafe(
  rawSend: (chunk: TaskLogChunk) => boolean | void,
  onDrain?: (resume: () => void) => void,
): TaskLogSend {
  const queue: TaskLogChunk[] = [];
  let draining = false;
  // Chunks dropped from the front of the queue since the last time a `dropped`
  // marker was successfully flushed. Tracked separately from `queue` (rather
  // than spliced in as a fake queue entry) so the real, still-queued chunks
  // always keep their relative order and the most recent ones always survive.
  let pendingDropCount = 0;
  let pendingDropFrom: TaskLogChunk | undefined;

  const flushOne = (): boolean => {
    if (pendingDropCount > 0) {
      const marker: TaskLogChunk = {
        seq: pendingDropFrom!.seq,
        stream: pendingDropFrom!.stream,
        text: `${pendingDropCount} line(s) dropped`,
        timestamp: new Date(),
        dropped: true,
      };
      const ok = rawSend(marker);
      if (ok === false) return false;
      pendingDropCount = 0;
      pendingDropFrom = undefined;
      return true;
    }
    const next = queue.shift();
    if (!next) return true;
    return rawSend(next) !== false;
  };

  const flush = (): void => {
    while (queue.length > 0 || pendingDropCount > 0) {
      if (!flushOne()) {
        draining = true;
        onDrain?.(() => {
          draining = false;
          flush();
        });
        return;
      }
    }
  };

  return (chunk: TaskLogChunk): void => {
    if (!draining && queue.length === 0 && pendingDropCount === 0) {
      const ok = rawSend(chunk);
      if (ok === false) {
        draining = true;
        onDrain?.(() => {
          draining = false;
          flush();
        });
      }
      return;
    }

    queue.push(chunk);
    if (queue.length > MAX_QUEUE) {
      // Drop the oldest queued chunks (not the newest) so the reader keeps
      // seeing the freshest tail; the drop is surfaced as a single collapsed
      // marker rather than growing the queue (or memory) without bound.
      const overflow = queue.splice(0, queue.length - MAX_QUEUE);
      if (pendingDropCount === 0) pendingDropFrom = overflow[0];
      pendingDropCount += overflow.length;
    }
    if (!draining) flush();
  };
}
