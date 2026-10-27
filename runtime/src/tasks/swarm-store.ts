/**
 * Swarm store (SWARM_MESSAGING plan, P2 — swarm task model).
 *
 * A swarm is ONE goal split into ≤ childCap ordinary tasks behind ONE operator
 * approval. Nothing here runs work: children are plain task-store tasks
 * stamped with `swarmId`, created `paused` (unclaimable), and wired with
 * `dependsOn` edges. `approveSwarm` flips them to `pending`; from there the
 * existing runner + claimTask() take over, and claimTask() already defers any
 * child whose upstreams aren't `done` (task-cafdd778) — so ordering needs no
 * runner change.
 *
 *   planSwarm   → swarms row (planning) → children created PAUSED → row paused
 *   approveSwarm→ paused children → pending, row active  (also resumes a stopped swarm)
 *   stopSwarm   → open children (pending|working) → paused, row stopped, mail everyone
 *
 * Guardrails come from swarm/guardrails.ts (P5): consent (schedule_ignore.txt),
 * child cap, and the stop plan. A child may only depend on an EARLIER child
 * (dependsOnIndexes < own index), which makes a cycle impossible by
 * construction and lets every child be created after its upstreams exist.
 *
 * Every read and write is tenant-scoped (scoped-query helpers), same posture
 * as mailbox-store: a leaked swarmId from another tenant reads as not-found.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SwarmModel, TaskModel, isConnected } from '../shared/db.js';
import type { ISwarm, ITask, SwarmStatus, TaskPriority, TaskStatus } from '../shared/db.js';
import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';
import {
  scopedFind, scopedFindOne, scopedFindOneAndUpdate, tenantScope,
} from '../shared/scoped-query.js';
import { createTask, updateTask } from './task-store.js';
import { sendMail } from '../notifications/mailbox-store.js';
import {
  checkChildCap, checkSwarmConsent, checkTokenBudget, parseIgnoreList, planSwarmStop, resolveSwarmBudget,
  SWARM_DEFAULTS,
} from '../swarm/guardrails.js';

const log = createChildLogger({ module: 'swarm-store' });

const MAX_GOAL_CHARS = 2000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** Thrown for a refused plan (consent, cap, bad graph) — the caller's input, not an outage. */
export class SwarmPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwarmPlanError';
  }
}

export interface SwarmChildInput {
  title: string;
  description?: string;
  assignedAgent?: string;
  recommendedModel?: string;
  priority?: TaskPriority;
  /** Indexes (0-based) of EARLIER children in the same plan this one waits on. */
  dependsOnIndexes?: number[];
}

export interface PlanSwarmInput {
  repo: string;
  goal: string;
  createdBy: string;
  children: SwarmChildInput[];
  /** Lower the cap for this swarm; can never exceed the configured cap. */
  childCap?: number;
  /** Optional coordinator task every child is stamped with as parentTaskId. */
  parentTaskId?: string;
  /** Explicit, per-call consent for a repo on schedule_ignore.txt. */
  consent?: boolean;
  notes?: string;
}

/**
 * The 5-word child vocabulary /swarm (P3) renders. Task statuses map onto it:
 * working → running; review (work finished, awaiting a human ship) → done;
 * dead_letter → blocked.
 */
export type SwarmChildDisplayStatus = 'paused' | 'pending' | 'running' | 'done' | 'blocked';

export function childDisplayStatus(status: TaskStatus | string): SwarmChildDisplayStatus {
  switch (status) {
    case 'working': return 'running';
    case 'review':
    case 'done': return 'done';
    case 'blocked':
    case 'dead_letter': return 'blocked';
    case 'paused': return 'paused';
    default: return 'pending';
  }
}

export interface SwarmChildView {
  taskId: string;
  title: string;
  status: TaskStatus;
  displayStatus: SwarmChildDisplayStatus;
  assignedAgent?: string;
  priority: TaskPriority;
  dependsOn?: string[];
  claimedBy?: string;
  prUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SwarmView {
  swarmId: string;
  repo: string;
  goal: string;
  status: SwarmStatus;
  childCap: number;
  childCount: number;
  createdBy: string;
  tokenBudget?: number;
  tokenSpent?: number;
  parentTaskId?: string;
  notes?: string;
  approvedAt?: Date;
  approvedBy?: string;
  stoppedAt?: Date;
  stoppedBy?: string;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface SwarmWithChildren {
  swarm: SwarmView;
  children: SwarmChildView[];
}

function requireDb(): void {
  if (!isConnected() || !SwarmModel || !TaskModel) {
    throw new Error('MongoDB not connected — swarms unavailable');
  }
}

function toSwarmView(doc: ISwarm): SwarmView {
  return {
    swarmId: doc.swarmId,
    repo: doc.repo,
    goal: doc.goal,
    status: doc.status,
    childCap: doc.childCap,
    childCount: doc.childCount,
    createdBy: doc.createdBy,
    tokenBudget: doc.tokenBudget,
    tokenSpent: doc.tokenSpent,
    parentTaskId: doc.parentTaskId,
    notes: doc.notes,
    approvedAt: doc.approvedAt,
    approvedBy: doc.approvedBy,
    stoppedAt: doc.stoppedAt,
    stoppedBy: doc.stoppedBy,
    completedAt: doc.completedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function toChildView(doc: Pick<ITask, 'taskId' | 'title' | 'status' | 'assignedAgent' | 'priority' | 'dependsOn' | 'claimedBy' | 'prUrl' | 'createdAt' | 'updatedAt'>): SwarmChildView {
  return {
    taskId: doc.taskId,
    title: doc.title,
    status: doc.status,
    displayStatus: childDisplayStatus(doc.status),
    assignedAgent: doc.assignedAgent,
    priority: doc.priority,
    dependsOn: doc.dependsOn && doc.dependsOn.length ? [...doc.dependsOn] : undefined,
    claimedBy: doc.claimedBy,
    prUrl: doc.prUrl,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * The no-autonomous-schedule list, read from the framework checkout the
 * gateway mounts (aiRoot). A missing file is an empty list — same as
 * schedule_task.sh, which only refuses repos it can see listed.
 */
export function readScheduleIgnoreList(aiRoot: string = getConfig().aiRoot): string[] {
  try {
    return parseIgnoreList(readFileSync(join(aiRoot, 'config', 'schedule_ignore.txt'), 'utf8'));
  } catch {
    return [];
  }
}

/** Validate the whole plan BEFORE any write, so a refusal leaves nothing behind. */
function validatePlan(input: PlanSwarmInput, cap: number): void {
  const consent = checkSwarmConsent(input.repo, readScheduleIgnoreList(), { consent: input.consent === true });
  if (!consent.allowed) throw new SwarmPlanError(consent.reason ?? 'swarm refused');

  if (typeof input.goal !== 'string' || !input.goal.trim()) throw new SwarmPlanError('goal is required');
  if (typeof input.createdBy !== 'string' || !input.createdBy.trim()) throw new SwarmPlanError('createdBy is required');
  if (!Array.isArray(input.children) || input.children.length === 0) {
    throw new SwarmPlanError('a swarm needs at least one child');
  }

  input.children.forEach((child, i) => {
    const room = checkChildCap(i, cap);
    if (!room.allowed) throw new SwarmPlanError(`${input.children.length} children requested — ${room.reason}`);
    if (!child || typeof child.title !== 'string' || !child.title.trim()) {
      throw new SwarmPlanError(`child ${i}: title is required`);
    }
    for (const dep of child.dependsOnIndexes ?? []) {
      if (!Number.isInteger(dep) || dep < 0 || dep >= i) {
        throw new SwarmPlanError(
          `child ${i}: dependsOnIndexes may only name earlier children (0..${i - 1}), got ${String(dep)}`,
        );
      }
    }
  });
}

/**
 * Plan a swarm: one `swarms` row plus its children, every child created
 * PAUSED. Nothing is claimable until {@link approveSwarm}. If a child create
 * fails mid-way, the swarm row is marked `stopped` with the error in notes —
 * the children made so far are paused, tagged with the swarmId, and therefore
 * visible and recoverable, never silently running.
 */
export async function planSwarm(tenantId: string, input: PlanSwarmInput): Promise<SwarmWithChildren> {
  requireDb();
  const budget = resolveSwarmBudget();
  const cap = typeof input.childCap === 'number' && input.childCap > 0
    ? Math.min(Math.floor(input.childCap), budget.childCap)
    : budget.childCap;
  validatePlan(input, cap);

  if (input.parentTaskId) {
    const parent = await scopedFindOne(TaskModel, tenantId, { taskId: input.parentTaskId }).exec();
    if (!parent) throw new SwarmPlanError(`Unknown parent task: ${input.parentTaskId}`);
  }

  const swarmId = `swarm-${randomUUID()}`;
  const repo = input.repo.trim();
  await SwarmModel.create({
    ...tenantScope(tenantId),
    swarmId,
    repo,
    goal: input.goal.trim().slice(0, MAX_GOAL_CHARS),
    status: 'planning',
    childCap: cap,
    childCount: 0,
    createdBy: input.createdBy.trim(),
    tokenBudget: budget.tokenBudget,
    parentTaskId: input.parentTaskId,
    notes: input.notes,
  });

  const createdIds: string[] = [];
  try {
    for (const child of input.children) {
      const dependsOn = (child.dependsOnIndexes ?? []).map((i) => createdIds[i]);
      const task = await createTask(tenantId, {
        repo,
        title: child.title.trim(),
        description: child.description,
        priority: child.priority,
        assignedAgent: child.assignedAgent,
        recommendedModel: child.recommendedModel,
        source: 'manual',
        notes: `swarm ${swarmId}`,
        dependsOn: dependsOn.length ? dependsOn : undefined,
        initialStatus: 'paused',
        swarmId,
        parentTaskId: input.parentTaskId,
      });
      createdIds.push(task.taskId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await scopedFindOneAndUpdate(SwarmModel, tenantId, { swarmId }, {
      $set: {
        status: 'stopped',
        childCount: createdIds.length,
        stoppedAt: new Date(),
        stoppedBy: 'swarm-store',
        notes: `plan failed after ${createdIds.length}/${input.children.length} children: ${message}`,
      },
    });
    log.error({ swarmId, created: createdIds.length, err: message }, 'Swarm plan failed part-way; swarm stopped');
    throw new Error(`swarm ${swarmId} plan failed after ${createdIds.length} child(ren) — swarm stopped, children paused: ${message}`);
  }

  await scopedFindOneAndUpdate(SwarmModel, tenantId, { swarmId }, {
    $set: { status: 'paused', childCount: createdIds.length },
  });
  log.info({ swarmId, repo, children: createdIds.length }, 'Swarm planned (children paused)');
  const planned = await getSwarm(tenantId, swarmId);
  if (!planned) throw new Error(`swarm ${swarmId} vanished after planning`);
  return planned;
}

/**
 * Approve a swarm: flip every PAUSED child to `pending` and mark the swarm
 * active. Children whose upstreams aren't done yet are still deferred by
 * claimTask(), so flipping all of them is safe. Also resumes a stopped swarm.
 * Returns null when the swarm doesn't exist for this tenant.
 */
export async function approveSwarm(
  tenantId: string,
  swarmId: string,
  opts: { approvedBy?: string } = {},
): Promise<(SwarmWithChildren & { approved: number }) | null> {
  requireDb();
  const existing = await scopedFindOne(SwarmModel, tenantId, { swarmId }).exec() as ISwarm | null;
  if (!existing) return null;
  if (existing.status !== 'paused' && existing.status !== 'stopped') {
    throw new SwarmPlanError(`swarm ${swarmId} is ${existing.status} — only a paused or stopped swarm can be approved`);
  }

  // Claim the transition atomically so a double approve flips children once.
  const claimed = await scopedFindOneAndUpdate(
    SwarmModel, tenantId,
    { swarmId, status: existing.status },
    { $set: { status: 'active', approvedAt: new Date(), ...(opts.approvedBy ? { approvedBy: opts.approvedBy } : {}) } },
    { new: true },
  ) as ISwarm | null;
  if (!claimed) throw new SwarmPlanError(`swarm ${swarmId} changed state concurrently — re-read and retry`);

  const paused = await scopedFind(TaskModel, tenantId, { swarmId, status: 'paused' }).exec() as unknown as ITask[];
  let approved = 0;
  for (const child of paused) {
    const updated = await updateTask(tenantId, { taskId: child.taskId, status: 'pending' });
    if (updated) approved++;
  }
  log.info({ swarmId, approved }, 'Swarm approved');
  const view = await getSwarm(tenantId, swarmId);
  return view ? { ...view, approved } : null;
}

/**
 * Stop a swarm (kill switch): every OPEN child (`pending` or `working`) goes
 * to `paused`. A working child's live session is NOT killed — it finishes its
 * current fire and then can't be re-claimed. Review/done/blocked children are
 * left alone. Every participant (each child's agent) plus the swarm's creator
 * is mailed. Returns null when the swarm doesn't exist for this tenant.
 */
export async function stopSwarm(
  tenantId: string,
  swarmId: string,
  opts: { stoppedBy?: string; reason?: string } = {},
): Promise<(SwarmWithChildren & { paused: number; mailed: string[] }) | null> {
  requireDb();
  const existing = await scopedFindOne(SwarmModel, tenantId, { swarmId }).exec() as ISwarm | null;
  if (!existing) return null;
  if (existing.status === 'stopped' || existing.status === 'done') {
    const view = await getSwarm(tenantId, swarmId);
    return view ? { ...view, paused: 0, mailed: [] } : null;
  }

  const stoppedBy = (opts.stoppedBy && opts.stoppedBy.trim()) || 'operator';
  await scopedFindOneAndUpdate(SwarmModel, tenantId, { swarmId }, {
    $set: { status: 'stopped', stoppedAt: new Date(), stoppedBy },
  });

  const children = await scopedFind(TaskModel, tenantId, { swarmId }).exec() as unknown as ITask[];
  const plan = planSwarmStop(children.map((c) => ({ taskId: c.taskId, status: c.status, assignedAgent: c.assignedAgent })));
  const open = new Set(children.filter((c) => c.status === 'pending' || c.status === 'working').map((c) => c.taskId));
  let paused = 0;
  for (const taskId of plan.toPause.filter((id) => open.has(id))) {
    const updated = await updateTask(tenantId, { taskId, status: 'paused', notes: `swarm ${swarmId} stopped by ${stoppedBy}` });
    if (updated) paused++;
  }

  const recipients = [...new Set([existing.createdBy, ...plan.participants].map((a) => a.trim().toLowerCase()).filter(Boolean))];
  const mailed: string[] = [];
  for (const to of recipients) {
    try {
      await sendMail(tenantId, {
        to,
        from: 'swarm-guard',
        kind: 'swarm',
        subject: `Swarm ${swarmId} stopped by ${stoppedBy}`,
        body: `${existing.goal}\n\n${paused} open child(ren) paused.${opts.reason ? ` Reason: ${opts.reason}` : ''} ` +
          'Re-approve the swarm (swarm_approve) to resume.',
        swarmId,
      });
      mailed.push(to);
    } catch (err) {
      // A mail failure must not undo the stop — the pause is the safety action.
      log.warn({ swarmId, to, err: err instanceof Error ? err.message : String(err) }, 'Swarm stop mail failed');
    }
  }
  log.info({ swarmId, paused, mailed: mailed.length }, 'Swarm stopped');
  const view = await getSwarm(tenantId, swarmId);
  return view ? { ...view, paused, mailed } : null;
}

export interface SwarmTokenSpendResult {
  verdict: ReturnType<typeof checkTokenBudget>;
  /** True when this call's spend tipped the swarm into pause_and_notify AND
   *  actually stopped it (false when already stopped/done — no double-stop). */
  stopped: boolean;
}

/**
 * Record `deltaTokens` more output-token spend against the swarm a child task
 * belongs to (atomic `$inc` on `tokenSpent` — concurrent children reporting
 * in parallel each contribute their own slice, never a lost update), then
 * enforce the P5 slow-burn guardrail: once cumulative spend meets the swarm's
 * token budget (`guardrails.checkTokenBudget`), the swarm is stopped (every
 * open child paused, same as `swarm stop`) and the guardrail's own
 * budget-reached mail goes out in addition to stopSwarm's participant mail.
 *
 * Called from task-store.ts's updateTaskImpl on every child update that
 * reports `outputTokens` (dynamic import — see that file for why). Never
 * throws: a metering bug must not break the runner's task-close flow that
 * triggers it.
 */
export async function recordSwarmChildTokens(
  tenantId: string,
  swarmId: string,
  deltaTokens: number,
): Promise<SwarmTokenSpendResult | null> {
  if (!Number.isFinite(deltaTokens) || deltaTokens <= 0) return null;
  try {
    requireDb();
    const updated = await scopedFindOneAndUpdate(
      SwarmModel, tenantId, { swarmId },
      { $inc: { tokenSpent: Math.floor(deltaTokens) } },
      { new: true },
    ) as ISwarm | null;
    if (!updated) return null;

    const budget = updated.tokenBudget ?? SWARM_DEFAULTS.tokenBudget;
    const verdict = checkTokenBudget(updated.tokenSpent ?? 0, budget, {
      swarmId, operator: updated.createdBy, from: 'swarm-guard',
    });

    // Only a still-active swarm can be paused by the guardrail — a swarm
    // already stopped/done/paused has nothing left to enforce (and re-firing
    // stopSwarm on every subsequent over-budget update would re-mail
    // everyone for no reason).
    if (verdict.action !== 'pause_and_notify' || updated.status !== 'active') {
      return { verdict, stopped: false };
    }

    await stopSwarm(tenantId, swarmId, {
      stoppedBy: 'token-budget-guard',
      reason: `token budget reached (${verdict.spent}/${verdict.budget})`,
    });
    if (verdict.mail) {
      try {
        await sendMail(tenantId, verdict.mail);
      } catch (err) {
        log.warn({ swarmId, err: err instanceof Error ? err.message : String(err) }, 'Swarm budget-reached mail failed');
      }
    }
    return { verdict, stopped: true };
  } catch (err) {
    log.warn({ swarmId, err: err instanceof Error ? err.message : String(err) }, 'recordSwarmChildTokens failed (suppressed)');
    return null;
  }
}

/**
 * Set a swarm's output-token budget to `tokenBudget` (the P5 slow-burn
 * guardrail ceiling that {@link recordSwarmChildTokens} enforces). The operator
 * calls this to RAISE a budget after a swarm was paused by the token-budget
 * guard — bump the ceiling, then `swarm_approve` to resume — or to tighten one
 * mid-flight. `by` is recorded in the audit log (same posture as the other
 * swarm mutations). Tenant-scoped: a leaked swarmId from another tenant reads
 * as not-found (returns null). Returns the updated {swarm, children}.
 */
export async function updateSwarmBudget(
  tenantId: string,
  swarmId: string,
  tokenBudget: number,
  opts: { by?: string } = {},
): Promise<SwarmWithChildren | null> {
  requireDb();
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    throw new SwarmPlanError('tokenBudget must be a positive number');
  }
  const by = (opts.by && opts.by.trim()) || 'operator';
  const updated = await scopedFindOneAndUpdate(
    SwarmModel, tenantId, { swarmId },
    { $set: { tokenBudget: Math.floor(tokenBudget) } },
    { new: true },
  ) as ISwarm | null;
  if (!updated) return null;
  log.info({ swarmId, tokenBudget: Math.floor(tokenBudget), by }, 'Swarm token budget updated');
  return getSwarm(tenantId, swarmId);
}

/** Tenant-scoped children of one swarm, oldest first (plan order). */
export async function listSwarmChildren(tenantId: string, swarmId: string): Promise<SwarmChildView[]> {
  requireDb();
  const docs = await scopedFind(TaskModel, tenantId, { swarmId }).sort({ createdAt: 1 }).exec() as unknown as ITask[];
  return docs.map(toChildView);
}

/**
 * One swarm with its children, or null. An active swarm whose children have
 * all finished is marked `done` here — the swarm's state is derived lazily on
 * read rather than by a hook on every task update.
 */
export async function getSwarm(tenantId: string, swarmId: string): Promise<SwarmWithChildren | null> {
  requireDb();
  let doc = await scopedFindOne(SwarmModel, tenantId, { swarmId }).exec() as ISwarm | null;
  if (!doc) return null;
  const children = await listSwarmChildren(tenantId, swarmId);
  if (doc.status === 'active' && children.length > 0 && children.every((c) => c.displayStatus === 'done')) {
    const finished = await scopedFindOneAndUpdate(
      SwarmModel, tenantId,
      { swarmId, status: 'active' },
      { $set: { status: 'done', completedAt: new Date() } },
      { new: true },
    ) as ISwarm | null;
    if (finished) doc = finished;
  }
  return { swarm: toSwarmView(doc), children };
}

/** A tenant's swarms, newest first (rows only — call getSwarm for children). */
export async function listSwarms(
  tenantId: string,
  filter: { status?: SwarmStatus; repo?: string; limit?: number } = {},
): Promise<SwarmView[]> {
  requireDb();
  const query: Record<string, unknown> = {};
  if (filter.status) query.status = filter.status;
  if (filter.repo) query.repo = filter.repo;
  const limit = Math.min(Math.max(1, filter.limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
  const docs = await scopedFind(SwarmModel, tenantId, query).sort({ createdAt: -1 }).limit(limit).exec() as ISwarm[];
  return docs.map(toSwarmView);
}
