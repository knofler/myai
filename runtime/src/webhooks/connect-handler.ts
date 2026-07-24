/**
 * Connect Hub Bridge Handler (S1 ticket→task bridge)
 *
 * Receives a *triaged* Connect Hub item — a bug report or feature request
 * emitted from a managed app's Connect Hub — and creates a corresponding
 * gateway task so the fleet runner can pick it up off the queue.
 *
 * This is the dormant-MVP S1: a triaged ticket becomes work. The connect-side
 * emit (the app POSTing here the moment an item flips to `triaged`) lives in a
 * companion connect task; this file is the gateway-side receiver + mapping.
 *
 * Signature verification reuses the same HMAC-SHA256 scheme as the GitHub
 * webhook (`verifySignature`), keyed on CONNECT_WEBHOOK_SECRET. If no secret is
 * configured, verification is skipped with a warning (single-operator default).
 */

import { createChildLogger } from '../shared/logger.js';
import { createTask, listTasks } from '../tasks/task-store.js';
import { DEFAULT_TENANT_ID, type TaskPriority } from '../shared/db.js';

const log = createChildLogger({ module: 'connect-bridge' });

// ── Public types ─────────────────────────────────────────────

export type ConnectItemType = 'bug' | 'feature';

/**
 * The payload the connect-side emit sends when an item is triaged. Only
 * `type`, `id`, `title` and `repo` are strictly required; the rest refine the
 * task mapping.
 */
export interface ConnectItem {
  type: ConnectItemType;
  /** The Connect Hub item's database id (used to build a stable sourceId). */
  id: string;
  title: string;
  description?: string;
  /** Connect Hub status. Only `triaged` items create a task. */
  status?: string;
  /** Bug severity: critical | high | medium | low. */
  severity?: string;
  /** Feature priority: must-have | should-have | nice-to-have. */
  priority?: string;
  /** Which managed app/repo the item belongs to → the task's repo. */
  repo: string;
  /** Deep link back to the item in the app's Connect Hub. */
  url?: string;
}

export interface ConnectIngestResult {
  handled: boolean;
  type?: ConnectItemType;
  summary: string;
  taskCreated?: string;
  /** Set when an item already had a task (idempotent re-emit). */
  taskExisting?: string;
  priority?: TaskPriority;
}

// ── Severity / priority → task priority mapping ──────────────

// Bug severity → task priority. A critical bug is P0; a low bug is P3.
const BUG_SEVERITY_PRIORITY: Record<string, TaskPriority> = {
  critical: 'P0',
  high: 'P1',
  medium: 'P2',
  low: 'P3',
};

// Feature priority → task priority. Features never jump to P0 (that lane is
// reserved for breakage); a must-have is P1.
const FEATURE_PRIORITY_PRIORITY: Record<string, TaskPriority> = {
  'must-have': 'P1',
  'should-have': 'P2',
  'nice-to-have': 'P3',
};

/**
 * Map a Connect Hub item to its task priority. Defaults to P2 when the
 * severity/priority field is missing or unrecognised — a triaged item is real
 * work, so it should never silently fall to the bottom of the queue.
 */
export function priorityForItem(item: Pick<ConnectItem, 'type' | 'severity' | 'priority'>): TaskPriority {
  if (item.type === 'bug') {
    return BUG_SEVERITY_PRIORITY[(item.severity ?? '').toLowerCase()] ?? 'P2';
  }
  return FEATURE_PRIORITY_PRIORITY[(item.priority ?? '').toLowerCase()] ?? 'P2';
}

/** Build the stable, dedupe-able sourceId for a Connect Hub item. */
export function sourceIdForItem(item: Pick<ConnectItem, 'type' | 'id'>): string {
  return `${item.type}-${item.id}`;
}

// ── CreateTask mapping ───────────────────────────────────────

/**
 * Pure mapping from a Connect Hub item to a `createTask` input — exported so
 * the mapping can be unit-tested without a DB. Bugs route to the qa-specialist,
 * features to the product-manager, matching the fleet's lane conventions.
 */
export function mapItemToTaskInput(item: ConnectItem) {
  const priority = priorityForItem(item);
  const label = item.type === 'bug' ? 'Bug' : 'Feature';
  const body = item.description ?? '';
  const description = body.length > 500 ? body.slice(0, 497) + '...' : body;
  return {
    repo: item.repo,
    title: `[${label}] ${item.title}`,
    description,
    priority,
    assignedAgent: item.type === 'bug' ? 'qa-specialist' : 'product-manager',
    source: 'connect-hub' as const,
    sourceId: sourceIdForItem(item),
    notes: item.url ? `Connect Hub ${item.type}: ${item.url}` : `Connect Hub ${item.type}`,
  };
}

// ── Main handler ─────────────────────────────────────────────

/**
 * Ingest a single triaged Connect Hub item and create a gateway task for it.
 *
 * Rules:
 * - Only items with `status === 'triaged'` create a task (the trigger). Any
 *   other status is acknowledged but produces no task.
 * - Idempotent: if a task already exists for this item's sourceId in the same
 *   repo, no duplicate is created — the existing task is returned instead. This
 *   makes the connect-side emit safe to retry / fire on every triage save.
 */
export async function handleConnectIngest(body: unknown): Promise<ConnectIngestResult> {
  const item = body as Partial<ConnectItem> | null | undefined;

  if (!item || (item.type !== 'bug' && item.type !== 'feature')) {
    return { handled: false, summary: 'Missing or invalid item type (expected "bug" or "feature")' };
  }
  if (!item.id || !item.title || !item.repo) {
    return { handled: false, type: item.type, summary: 'Missing required field: id, title, or repo' };
  }

  // Only triaged items become work. A reported/working/solved item is a no-op.
  if ((item.status ?? '').toLowerCase() !== 'triaged') {
    return {
      handled: false,
      type: item.type,
      summary: `Item status "${item.status ?? '(none)'}" is not "triaged" — no task created`,
    };
  }

  const full = item as ConnectItem;
  const sourceId = sourceIdForItem(full);

  try {
    // Idempotency: re-emitting a triaged item must not pile up duplicate tasks.
    const existing = (await listTasks(DEFAULT_TENANT_ID, { repo: full.repo })).find(
      (t) => t.source === 'connect-hub' && t.sourceId === sourceId,
    );
    if (existing) {
      return {
        handled: true,
        type: full.type,
        summary: `Task ${existing.taskId} already exists for ${sourceId} — skipped (idempotent)`,
        taskExisting: existing.taskId,
        priority: existing.priority,
      };
    }

    const input = mapItemToTaskInput(full);
    const task = await createTask(DEFAULT_TENANT_ID, input);
    log.info({ taskId: task.taskId, repo: full.repo, sourceId, priority: input.priority }, 'Task created from Connect Hub item');

    return {
      handled: true,
      type: full.type,
      summary: `Task ${task.taskId} created from ${full.type} "${full.title}" (${input.priority})`,
      taskCreated: task.taskId,
      priority: input.priority,
    };
  } catch (err) {
    log.error({ err, sourceId, repo: full.repo }, 'Failed to create task from Connect Hub item');
    return {
      handled: false,
      type: full.type,
      summary: `Failed to create task: ${(err as Error).message}`,
    };
  }
}
