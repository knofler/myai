import type { Connection } from 'mongoose';
import type { TaskPriority, TaskSource, TaskStatus } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { createTask, updateTask, TaskDependencyError } from './task-store.js';
import type { TaskView } from './task-store.js';
import { BulkBlockGuardError } from './bulk-block-guard.js';

const log = createChildLogger({ module: 'bulk-task-operations' });

// ── Bulk task operations (multi-repo board backend) ──────────────────────
// One call carrying N task mutations so the multi-repo orchestration UI and
// CLI can act on many tasks at once (multi-select cancel, batch reprioritize,
// fan-out create) without N round-trips. Every mutation goes through the
// EXISTING tenant-scoped single-task write paths (createTask/updateTask) so
// bulk inherits all of their invariants for free: tenant row-scoping, the
// bulk-block guard, dependency-graph validation, status-transition stamps,
// notify events, and the usage meter. Nothing here touches TaskModel directly.
//
// Failure semantics are PARTIAL by default: ops apply sequentially in array
// order, each op succeeds or fails independently, and the response reports a
// per-op verdict (ok / error+code) plus batch counters — the board renders
// exactly which rows went through. `stopOnError: true` opts into halting at
// the first failure; the remaining ops are reported as SKIPPED, never
// half-guessed. There is deliberately no all-or-nothing rollback mode: task
// writes emit side effects (notifications, usage events, preemption) that
// cannot be un-emitted, so pretending atomicity would lie to the caller.

/** Hard cap on ops per call — bounds worst-case write amplification. */
export const MAX_BULK_OPS = 100;

export type BulkTaskAction = 'create' | 'update' | 'cancel' | 'reprioritize';

const VALID_ACTIONS: ReadonlySet<string> = new Set(['create', 'update', 'cancel', 'reprioritize']);

/**
 * One mutation in the batch. Flat shape (action + fields) so the MCP tool
 * schema stays a single object type; which fields matter depends on `action`:
 * - create:       repo + title required; other create fields optional.
 * - update:       taskId required; any tasks_update field.
 * - cancel:       taskId required; blocked + reason note in one step.
 * - reprioritize: taskId + priority required; touches nothing else.
 *
 * Batch-internal references: anywhere a taskId is accepted (`taskId`,
 * `supersededBy`, `dependsOn` entries), the placeholder `$N` (e.g. `$0`)
 * resolves to the taskId created by op index N earlier in the SAME batch —
 * server-generated IDs would otherwise make a one-shot dependent chain
 * (create migrate-DB, create build-UI dependsOn it) impossible.
 */
export interface BulkTaskOperation {
  action: BulkTaskAction;
  /** Target task for update/cancel/reprioritize. Accepts a `$N` batch ref. */
  taskId?: string;
  // create fields (repo doubles as update's re-point field)
  repo?: string;
  title?: string;
  description?: string;
  priority?: TaskPriority;
  assignedAgent?: string;
  recommendedModel?: string;
  source?: TaskSource;
  sourceId?: string;
  notes?: string;
  dependsOn?: string[];
  // update fields
  status?: TaskStatus;
  prUrl?: string;
  supersededBy?: string;
  operatorAuthorized?: boolean;
  /** cancel only — recorded in the task's notes alongside the cancel stamp. */
  reason?: string;
}

export interface BulkTaskOperationsInput {
  operations: BulkTaskOperation[];
  /** Halt at the first failed op; remaining ops report code SKIPPED. Default false (partial application). */
  stopOnError?: boolean;
  /** Member attribution applied to every create in the batch (REST JWT path). */
  defaultRequestedByUserId?: string;
}

export type BulkOpErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'REF_UNRESOLVED'
  | 'BULK_BLOCK_GUARD'
  | 'TASK_DEPENDENCY'
  | 'SKIPPED'
  | 'INTERNAL';

export interface BulkTaskOpResult {
  index: number;
  action: BulkTaskAction;
  ok: boolean;
  /** Resolved target/created taskId when known. */
  taskId?: string;
  task?: TaskView;
  error?: string;
  code?: BulkOpErrorCode;
}

export interface BulkTaskOperationsResult {
  total: number;
  succeeded: number;
  failed: number;
  /** Set when stopOnError halted the batch — the index of the failing op. */
  stoppedAt?: number;
  results: BulkTaskOpResult[];
}

/** Batch-level (whole-request) rejection — nothing was applied. */
export class BulkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkValidationError';
  }
}

const BATCH_REF_RE = /^\$(\d+)$/;

/**
 * Resolve a possibly-`$N` batch reference against taskIds created earlier in
 * this batch. Throws (as a per-op failure) on a ref to an op that isn't an
 * earlier successful create — later/failed refs are always caller bugs.
 */
function resolveRef(value: string, created: Map<number, string>, opIndex: number): string {
  const m = BATCH_REF_RE.exec(value);
  if (!m) return value;
  const refIndex = Number(m[1]);
  const resolved = created.get(refIndex);
  if (resolved === undefined) {
    throw new RefError(
      `op[${opIndex}]: batch ref "${value}" does not resolve — op ${refIndex} is not an earlier successful create in this batch`,
    );
  }
  return resolved;
}

class RefError extends Error {}

/** Reject a malformed request outright (batch-level) before touching any task. */
function validateBatch(input: BulkTaskOperationsInput): void {
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    throw new BulkValidationError('operations must be a non-empty array');
  }
  if (input.operations.length > MAX_BULK_OPS) {
    throw new BulkValidationError(`operations exceeds the per-call cap of ${MAX_BULK_OPS} (got ${input.operations.length})`);
  }
  input.operations.forEach((op, i) => {
    if (!op || typeof op !== 'object' || typeof op.action !== 'string' || !VALID_ACTIONS.has(op.action)) {
      throw new BulkValidationError(`op[${i}]: action must be one of create|update|cancel|reprioritize`);
    }
  });
}

/** Per-op field validation — a failure here fails ONLY this op, not the batch. */
function validateOp(op: BulkTaskOperation, i: number): string | null {
  if (op.action === 'create') {
    if (!op.repo || typeof op.repo !== 'string' || !op.repo.trim()) return `op[${i}]: create requires repo`;
    if (!op.title || typeof op.title !== 'string' || !op.title.trim()) return `op[${i}]: create requires title`;
    return null;
  }
  if (!op.taskId || typeof op.taskId !== 'string') return `op[${i}]: ${op.action} requires taskId`;
  if (op.action === 'reprioritize' && !op.priority) return `op[${i}]: reprioritize requires priority`;
  return null;
}

function errCode(err: unknown): BulkOpErrorCode {
  if (err instanceof RefError) return 'REF_UNRESOLVED';
  if (err instanceof BulkBlockGuardError) return 'BULK_BLOCK_GUARD';
  if (err instanceof TaskDependencyError) return 'TASK_DEPENDENCY';
  return 'INTERNAL';
}

/**
 * Apply a batch of task mutations for one tenant, sequentially, in order.
 * Row-scoped per tenant end-to-end: every op delegates to createTask/updateTask,
 * whose scoped queries make a leaked cross-tenant taskId read as NOT_FOUND —
 * a bulk call can never mutate another tenant's rows.
 */
export async function bulkTaskOperations(
  tenantId: string,
  input: BulkTaskOperationsInput,
  connection?: Connection,
): Promise<BulkTaskOperationsResult> {
  validateBatch(input);

  const results: BulkTaskOpResult[] = [];
  // op index → created taskId, for `$N` batch refs in later ops.
  const created = new Map<number, string>();
  let stoppedAt: number | undefined;

  for (let i = 0; i < input.operations.length; i++) {
    const op = input.operations[i];

    if (stoppedAt !== undefined) {
      results.push({ index: i, action: op.action, ok: false, code: 'SKIPPED', error: `skipped — stopOnError halted the batch at op ${stoppedAt}` });
      continue;
    }

    const fieldError = validateOp(op, i);
    if (fieldError) {
      results.push({ index: i, action: op.action, ok: false, code: 'VALIDATION', error: fieldError });
      if (input.stopOnError) stoppedAt = i;
      continue;
    }

    try {
      const result = await applyOp(tenantId, op, i, created, input, connection);
      results.push(result);
      if (!result.ok && input.stopOnError) stoppedAt = i;
    } catch (err) {
      results.push({
        index: i,
        action: op.action,
        ok: false,
        taskId: op.taskId && !BATCH_REF_RE.test(op.taskId) ? op.taskId : undefined,
        code: errCode(err),
        error: err instanceof Error ? err.message : String(err),
      });
      if (input.stopOnError) stoppedAt = i;
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  const summary: BulkTaskOperationsResult = {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    results,
  };
  log.info({ tenantId, total: summary.total, succeeded, failed: summary.failed }, 'Bulk task operations applied');
  return summary;
}

async function applyOp(
  tenantId: string,
  op: BulkTaskOperation,
  i: number,
  created: Map<number, string>,
  input: BulkTaskOperationsInput,
  connection?: Connection,
): Promise<BulkTaskOpResult> {
  if (op.action === 'create') {
    const dependsOn = op.dependsOn?.map((d) => resolveRef(d, created, i));
    const task = await createTask(tenantId, {
      repo: op.repo!.trim(),
      title: op.title!,
      description: op.description,
      priority: op.priority,
      assignedAgent: op.assignedAgent,
      recommendedModel: op.recommendedModel,
      source: op.source,
      sourceId: op.sourceId,
      notes: op.notes,
      requestedByUserId: input.defaultRequestedByUserId,
      dependsOn,
    }, connection);
    created.set(i, task.taskId);
    return { index: i, action: op.action, ok: true, taskId: task.taskId, task };
  }

  const taskId = resolveRef(op.taskId!, created, i);
  const supersededBy = op.supersededBy ? resolveRef(op.supersededBy, created, i) : undefined;

  const updateInput =
    op.action === 'cancel'
      ? {
          taskId,
          status: 'blocked' as TaskStatus,
          notes: `Cancelled via bulk operation${op.reason ? `: ${op.reason}` : ''}`,
          supersededBy,
          operatorAuthorized: op.operatorAuthorized,
        }
      : op.action === 'reprioritize'
        ? { taskId, priority: op.priority, ...(op.notes !== undefined ? { notes: op.notes } : {}) }
        : {
            taskId,
            repo: op.repo,
            status: op.status,
            priority: op.priority,
            assignedAgent: op.assignedAgent,
            recommendedModel: op.recommendedModel,
            prUrl: op.prUrl,
            notes: op.notes,
            supersededBy,
            operatorAuthorized: op.operatorAuthorized,
            dependsOn: op.dependsOn?.map((d) => resolveRef(d, created, i)),
          };

  const task = await updateTask(tenantId, updateInput, connection);
  if (!task) {
    return { index: i, action: op.action, ok: false, taskId, code: 'NOT_FOUND', error: `Task not found: ${taskId}` };
  }
  return { index: i, action: op.action, ok: true, taskId, task };
}
