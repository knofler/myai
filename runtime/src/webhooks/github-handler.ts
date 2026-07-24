/**
 * GitHub Webhook Handler
 *
 * Receives GitHub webhook events and routes them to the appropriate
 * internal action: task creation, priority updates, Telegram notifications,
 * or audit logging.
 *
 * Signature verification uses HMAC-SHA256 with the GITHUB_WEBHOOK_SECRET
 * env var. If no secret is configured, verification is skipped with a warning.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createChildLogger } from '../shared/logger.js';
import { createTask, updateTask, listTasks } from '../tasks/task-store.js';
import { DEFAULT_TENANT_ID, type TaskPriority, type TaskStatus } from '../shared/db.js';
import { getAdapter } from '../channels/registry.js';

const log = createChildLogger({ module: 'github-webhook' });

// ── Public types ─────────────────────────────────────────────

export interface WebhookResult {
  handled: boolean;
  event: string;
  action?: string;
  summary: string;
  taskCreated?: string;
  notificationSent?: boolean;
  /** taskIds advanced by a `push` whose commit messages referenced them. */
  tasksAdvanced?: string[];
}

// ── Signature verification ───────────────────────────────────

/**
 * Verify a GitHub webhook payload signature (HMAC-SHA256).
 *
 * Returns `true` when the computed HMAC matches the provided `signature`
 * header value (format: `sha256=<hex>`). Uses timing-safe comparison to
 * prevent timing attacks.
 */
export function verifySignature(payload: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;

  const prefix = 'sha256=';
  if (!signature.startsWith(prefix)) return false;

  const sigHex = signature.slice(prefix.length);
  const expected = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

  // Both are hex strings of a SHA-256 digest, so same length if well-formed.
  if (sigHex.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(sigHex, 'hex'), Buffer.from(expected, 'hex'));
}

// ── Label-to-priority mapping ────────────────────────────────

const LABEL_PRIORITY_MAP: Record<string, TaskPriority> = {
  'p0': 'P0',
  'critical': 'P0',
  'p1': 'P1',
  'high': 'P1',
  'priority': 'P1',
  'p2': 'P2',
  'medium': 'P2',
  'p3': 'P3',
  'low': 'P3',
};

function priorityFromLabels(labels: Array<{ name: string }>): TaskPriority {
  // Scan labels in priority order (highest first)
  for (const label of labels) {
    const mapped = LABEL_PRIORITY_MAP[label.name.toLowerCase()];
    if (mapped) return mapped;
  }
  return 'P3';
}

// ── Telegram notification helper ─────────────────────────────

async function sendTelegramNotification(message: string): Promise<boolean> {
  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) {
    log.debug('TELEGRAM_DEFAULT_CHAT not set — skipping notification');
    return false;
  }

  const adapter = getAdapter('telegram');
  if (!adapter || !adapter.enabled) {
    log.debug('Telegram adapter not registered or not enabled — skipping notification');
    return false;
  }

  try {
    await adapter.send(chatId, message);
    return true;
  } catch (err) {
    log.error({ err }, 'Failed to send Telegram notification for GitHub webhook');
    return false;
  }
}

// ── Event handlers ───────────────────────────────────────────

async function handleIssuesOpened(payload: Record<string, unknown>, tenantId: string): Promise<WebhookResult> {
  const issue = payload.issue as Record<string, unknown> | undefined;
  const repo = payload.repository as Record<string, unknown> | undefined;

  if (!issue || !repo) {
    return { handled: false, event: 'issues', action: 'opened', summary: 'Missing issue or repository data' };
  }

  const issueNumber = issue.number as number;
  const issueTitle = issue.title as string;
  const issueBody = (issue.body as string) || '';
  const repoFullName = repo.full_name as string;
  const issueUrl = issue.html_url as string;
  const labels = (issue.labels as Array<{ name: string }>) || [];

  const priority = priorityFromLabels(labels);
  const description = issueBody.length > 500 ? issueBody.slice(0, 497) + '...' : issueBody;

  try {
    const task = await createTask(tenantId, {
      repo: repoFullName,
      title: issueTitle,
      description,
      priority,
      source: 'github',
      sourceId: `issue-${issueNumber}`,
      notes: `GitHub issue: ${issueUrl}`,
    });

    log.info({ taskId: task.taskId, repo: repoFullName, issueNumber }, 'Task created from GitHub issue');

    return {
      handled: true,
      event: 'issues',
      action: 'opened',
      summary: `Task ${task.taskId} created from issue #${issueNumber} "${issueTitle}" (${priority})`,
      taskCreated: task.taskId,
    };
  } catch (err) {
    log.error({ err, issueNumber, repoFullName }, 'Failed to create task from GitHub issue');
    return {
      handled: false,
      event: 'issues',
      action: 'opened',
      summary: `Failed to create task: ${(err as Error).message}`,
    };
  }
}

async function handleIssuesLabeled(payload: Record<string, unknown>, tenantId: string): Promise<WebhookResult> {
  const issue = payload.issue as Record<string, unknown> | undefined;
  const label = payload.label as Record<string, unknown> | undefined;

  if (!issue || !label) {
    return { handled: false, event: 'issues', action: 'labeled', summary: 'Missing issue or label data' };
  }

  const labelName = (label.name as string).toLowerCase();
  const issueNumber = issue.number as number;

  // Only process bug/priority labels
  if (!LABEL_PRIORITY_MAP[labelName] && labelName !== 'bug') {
    return {
      handled: false,
      event: 'issues',
      action: 'labeled',
      summary: `Label "${label.name}" is not a priority/bug label — skipped`,
    };
  }

  const labels = (issue.labels as Array<{ name: string }>) || [];
  const newPriority = priorityFromLabels(labels);
  const sourceId = `issue-${issueNumber}`;

  // Find existing task by sourceId
  try {
    const tasks = await listTasks(tenantId, { repo: (payload.repository as Record<string, unknown>)?.full_name as string });
    const existing = tasks.find(t => t.sourceId === sourceId);

    if (!existing) {
      return {
        handled: false,
        event: 'issues',
        action: 'labeled',
        summary: `No task found for issue #${issueNumber} — cannot update priority`,
      };
    }

    await updateTask(tenantId, { taskId: existing.taskId, priority: newPriority });
    log.info({ taskId: existing.taskId, issueNumber, newPriority }, 'Task priority updated from issue label');

    return {
      handled: true,
      event: 'issues',
      action: 'labeled',
      summary: `Task ${existing.taskId} priority updated to ${newPriority} (label: "${label.name}")`,
    };
  } catch (err) {
    log.error({ err, issueNumber }, 'Failed to update task priority from label');
    return {
      handled: false,
      event: 'issues',
      action: 'labeled',
      summary: `Failed to update task priority: ${(err as Error).message}`,
    };
  }
}

async function handlePullRequestOpened(payload: Record<string, unknown>): Promise<WebhookResult> {
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const repo = payload.repository as Record<string, unknown> | undefined;

  if (!pr || !repo) {
    return { handled: false, event: 'pull_request', action: 'opened', summary: 'Missing pull_request or repository data' };
  }

  const prNumber = pr.number as number;
  const prTitle = pr.title as string;
  const prUrl = pr.html_url as string;
  const repoName = repo.full_name as string;
  const author = (pr.user as Record<string, unknown>)?.login as string || 'unknown';

  const message =
    `New PR opened on ${repoName}\n` +
    `#${prNumber}: ${prTitle}\n` +
    `Author: ${author}\n` +
    `${prUrl}`;

  const sent = await sendTelegramNotification(message);

  return {
    handled: true,
    event: 'pull_request',
    action: 'opened',
    summary: `PR #${prNumber} "${prTitle}" opened on ${repoName}`,
    notificationSent: sent,
  };
}

async function handlePullRequestReviewSubmitted(payload: Record<string, unknown>): Promise<WebhookResult> {
  const review = payload.review as Record<string, unknown> | undefined;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const repo = payload.repository as Record<string, unknown> | undefined;

  if (!review || !pr || !repo) {
    return { handled: false, event: 'pull_request_review', action: 'submitted', summary: 'Missing review, PR, or repository data' };
  }

  const state = (review.state as string || '').toLowerCase();
  if (state !== 'approved' && state !== 'changes_requested') {
    return {
      handled: false,
      event: 'pull_request_review',
      action: 'submitted',
      summary: `Review state "${state}" — not actionable`,
    };
  }

  const prNumber = pr.number as number;
  const prTitle = pr.title as string;
  const prUrl = pr.html_url as string;
  const repoName = repo.full_name as string;
  const reviewer = (review.user as Record<string, unknown>)?.login as string || 'unknown';
  const emoji = state === 'approved' ? 'APPROVED' : 'CHANGES REQUESTED';

  const message =
    `PR Review: ${emoji}\n` +
    `${repoName} #${prNumber}: ${prTitle}\n` +
    `Reviewer: ${reviewer}\n` +
    `${prUrl}`;

  const sent = await sendTelegramNotification(message);

  return {
    handled: true,
    event: 'pull_request_review',
    action: 'submitted',
    summary: `Review ${state} by ${reviewer} on PR #${prNumber}`,
    notificationSent: sent,
  };
}

async function handleCheckSuiteCompleted(payload: Record<string, unknown>): Promise<WebhookResult> {
  const checkSuite = payload.check_suite as Record<string, unknown> | undefined;
  const repo = payload.repository as Record<string, unknown> | undefined;

  if (!checkSuite || !repo) {
    return { handled: false, event: 'check_suite', action: 'completed', summary: 'Missing check_suite or repository data' };
  }

  const conclusion = (checkSuite.conclusion as string || '').toLowerCase();
  if (conclusion !== 'failure') {
    return {
      handled: false,
      event: 'check_suite',
      action: 'completed',
      summary: `Check suite conclusion "${conclusion}" — not a failure, skipped`,
    };
  }

  const repoName = repo.full_name as string;
  const branch = (checkSuite.head_branch as string) || 'unknown';
  const sha = ((checkSuite.head_sha as string) || '').slice(0, 7);
  const repoUrl = repo.html_url as string;

  const message =
    `CI FAILURE on ${repoName}\n` +
    `Branch: ${branch} (${sha})\n` +
    `${repoUrl}/actions`;

  const sent = await sendTelegramNotification(message);

  return {
    handled: true,
    event: 'check_suite',
    action: 'completed',
    summary: `CI failure on ${repoName}/${branch} (${sha})`,
    notificationSent: sent,
  };
}

// Matches this repo's task id format ("task-<uuid>", see tasks/task-store.ts
// createTask) inside a commit message, e.g. "fixes task-1a2b3c4d-... login bug".
const TASK_ID_IN_COMMIT = /task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Unique, lower-cased task ids referenced across a push's commit messages. */
function extractTaskIds(commits: Array<Record<string, unknown>>): string[] {
  const ids = new Set<string>();
  for (const commit of commits) {
    const message = (commit.message as string) || '';
    for (const match of message.matchAll(TASK_ID_IN_COMMIT)) {
      ids.add(match[0].toLowerCase());
    }
  }
  return [...ids];
}

async function handlePush(payload: Record<string, unknown>, tenantId: string): Promise<WebhookResult> {
  const ref = payload.ref as string | undefined;
  const repo = payload.repository as Record<string, unknown> | undefined;

  if (!ref || !repo) {
    return { handled: false, event: 'push', summary: 'Missing ref or repository data' };
  }

  const repoName = repo.full_name as string;
  const pusher = (payload.pusher as Record<string, unknown>)?.name as string || 'unknown';
  const commits = (payload.commits as Array<Record<string, unknown>>) || [];
  const commitCount = commits.length;
  const headSha = ((payload.after as string) || '').slice(0, 7);
  const isMain = ref === 'refs/heads/main';

  // A commit message referencing a task id advances that task: main lands it
  // (done), any other branch marks it ready for review — regardless of
  // whether the push itself is to main (that part stays log-only otherwise).
  const referencedTaskIds = extractTaskIds(commits);
  const tasksAdvanced: string[] = [];
  if (referencedTaskIds.length > 0) {
    const newStatus: TaskStatus = isMain ? 'done' : 'review';
    for (const taskId of referencedTaskIds) {
      try {
        const updated = await updateTask(tenantId, { taskId, status: newStatus });
        if (updated) tasksAdvanced.push(updated.taskId);
      } catch (err) {
        log.warn({ err, taskId, repoName }, 'Failed to advance task referenced in push commit message');
      }
    }
  }

  if (!isMain && tasksAdvanced.length === 0) {
    return { handled: false, event: 'push', summary: `Push to ${ref} — not main, skipped` };
  }

  if (isMain) {
    log.info(
      { repo: repoName, pusher, commitCount, headSha },
      `Push to main: ${commitCount} commit(s) by ${pusher}`,
    );
  }

  const branch = ref.replace('refs/heads/', '');
  let summary = `Push to ${repoName}/${branch}: ${commitCount} commit(s) by ${pusher} (${headSha})`;
  if (tasksAdvanced.length > 0) {
    summary += ` — advanced ${tasksAdvanced.length} task(s) to ${isMain ? 'done' : 'review'}: ${tasksAdvanced.join(', ')}`;
  }

  return {
    handled: true,
    event: 'push',
    summary,
    tasksAdvanced: tasksAdvanced.length > 0 ? tasksAdvanced : undefined,
  };
}

// ── Main handler ─────────────────────────────────────────────

/**
 * Process a GitHub webhook event.
 *
 * @param headers - Request headers (lowercase keys). Must include `x-github-event`.
 *   An optional `x-myai-tenant-id` (set by the server route from the
 *   `/api/webhooks/github/:tenantId` path param) scopes task create/advance
 *   to that tenant; absent it falls back to the default (self-host) tenant —
 *   the legacy `/api/webhooks/github` route's behaviour, unchanged.
 * @param body - Parsed JSON payload from GitHub.
 */
export async function handleGitHubWebhook(
  headers: Record<string, string>,
  body: unknown,
): Promise<WebhookResult> {
  const event = headers['x-github-event'];
  const delivery = headers['x-github-delivery'];
  const tenantId = headers['x-myai-tenant-id'] || DEFAULT_TENANT_ID;

  if (!event) {
    return { handled: false, event: 'unknown', summary: 'Missing x-github-event header' };
  }

  const payload = body as Record<string, unknown>;
  const action = (payload?.action as string) || undefined;

  log.info({ event, action, delivery, tenantId }, 'GitHub webhook received');

  // Route to specific handler based on event + action
  switch (event) {
    case 'issues': {
      if (action === 'opened') return handleIssuesOpened(payload, tenantId);
      if (action === 'labeled') return handleIssuesLabeled(payload, tenantId);
      return { handled: false, event, action, summary: `Unhandled issues action: ${action}` };
    }

    case 'pull_request': {
      if (action === 'opened') return handlePullRequestOpened(payload);
      return { handled: false, event, action, summary: `Unhandled pull_request action: ${action}` };
    }

    case 'pull_request_review': {
      if (action === 'submitted') return handlePullRequestReviewSubmitted(payload);
      return { handled: false, event, action, summary: `Unhandled pull_request_review action: ${action}` };
    }

    case 'check_suite': {
      if (action === 'completed') return handleCheckSuiteCompleted(payload);
      return { handled: false, event, action, summary: `Unhandled check_suite action: ${action}` };
    }

    case 'push':
      return handlePush(payload, tenantId);

    default:
      return { handled: false, event, action, summary: `Unhandled event: ${event}` };
  }
}
