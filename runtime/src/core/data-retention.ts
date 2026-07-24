/**
 * Data-retention purge — bounded lifetime for Task/PlanDay rows and audit-log
 * day-files (distinct from account-erasure.ts's tenant-initiated
 * right-to-erasure sweep, which wipes an ENTIRE tenant on request; this purge
 * runs on a recurring schedule against EVERY tenant, trimming rows that have
 * simply aged past their retention window — no request required).
 *
 * Per-collection windows (env-configurable, days):
 *   - Task      (terminal states only: done/dead_letter) — TASK_RETENTION_DAYS, default 90
 *   - PlanDay   (terminal state only: done)              — PLAN_RETENTION_DAYS, default 180
 *   - Audit log (day-files, audit-log.ts)                — AUDIT_RETENTION_DAYS, default 400
 *
 * Legal hold: a tenant flagged `Tenant.legalHold=true` (support/operator
 * toggle, see shared/db.ts) is excluded from every collection's purge —
 * Task/PlanDay rows are skipped via a `tenantId $nin` filter. The audit log is
 * file-backed and day-files interleave every tenant sharing the JSONL store
 * (audit-log.ts header), so a purge-candidate file isn't deleted outright if
 * it contains a held tenant's events — it's rewritten keeping ONLY that
 * tenant's lines. Pruning other tenants' lines never breaks a held tenant's
 * own hash chain: `verifyAuditChain` recomputes the chain from just that
 * tenant's lines in file order, so removing lines that aren't hers is
 * invisible to it.
 *
 * Not wired to an automatic in-process cron — same posture as
 * account-erasure.ts's `runErasureSweep`: an operator/cron invokes this daily
 * via the `data_retention_purge` MCP tool (kind=tool schedule), alongside the
 * morning/evening sweeps.
 */
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PlanDayModel, TaskModel, TenantModel } from '../shared/db.js';
import { auditDir } from './audit-log.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'data-retention' });

export const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS) || 90;
export const PLAN_RETENTION_DAYS = Number(process.env.PLAN_RETENTION_DAYS) || 180;
export const AUDIT_RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS) || 400;

const DAY_MS = 86_400_000;

export interface RetentionPurgeResult {
  ranAt: Date;
  tasksDeleted: number;
  planDaysDeleted: number;
  auditFilesDeleted: number;
  auditLinesRedacted: number;
  heldTenants: string[];
}

async function heldTenantIds(): Promise<string[]> {
  const held = await TenantModel.find({ legalHold: true }).select('tenantId').lean<{ tenantId: string }[]>();
  return held.map((t) => t.tenantId);
}

/**
 * Run the full purge across Task, PlanDay, and the audit log. Each collection
 * is handled independently and best-effort — see `purgeAuditLog` for the
 * file-level semantics. Safe to call repeatedly (idempotent: a row already
 * past its window and gone stays gone).
 */
export async function runRetentionPurge(
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<RetentionPurgeResult> {
  const held = await heldTenantIds();
  const exclude = held.length ? { tenantId: { $nin: held } } : {};

  const taskCutoff = new Date(now.getTime() - TASK_RETENTION_DAYS * DAY_MS);
  const taskRes = await TaskModel.deleteMany({
    ...exclude,
    status: { $in: ['done', 'dead_letter'] },
    updatedAt: { $lt: taskCutoff },
  });

  const planCutoff = new Date(now.getTime() - PLAN_RETENTION_DAYS * DAY_MS);
  const planRes = await PlanDayModel.deleteMany({
    ...exclude,
    status: 'done',
    updatedAt: { $lt: planCutoff },
  });

  const auditCutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * DAY_MS);
  const audit = purgeAuditLog(auditCutoff, held, env);

  const result: RetentionPurgeResult = {
    ranAt: now,
    tasksDeleted: taskRes.deletedCount ?? 0,
    planDaysDeleted: planRes.deletedCount ?? 0,
    auditFilesDeleted: audit.filesDeleted,
    auditLinesRedacted: audit.linesRedacted,
    heldTenants: held,
  };

  log.info(result, 'data retention purge complete');
  return result;
}

/**
 * Reap audit day-files (`audit-YYYY-MM-DD.jsonl`) dated before `cutoff`'s
 * calendar day. A candidate file with no held tenant's events is deleted
 * outright; one containing a held tenant's events is rewritten keeping ONLY
 * those tenants' lines (every other line removed counts toward
 * `linesRedacted`). Tolerates corrupt/partial lines the same way
 * audit-log.ts's readers do — a bad line is dropped, never thrown.
 */
function purgeAuditLog(
  cutoff: Date,
  heldTenants: string[],
  env: NodeJS.ProcessEnv,
): { filesDeleted: number; linesRedacted: number } {
  const dir = auditDir(env);
  let filesDeleted = 0;
  let linesRedacted = 0;
  if (!existsSync(dir)) return { filesDeleted, linesRedacted };

  const cutoffDay = cutoff.toISOString().slice(0, 10);
  const held = new Set(heldTenants);

  for (const name of readdirSync(dir)) {
    if (!name.startsWith('audit-') || !name.endsWith('.jsonl')) continue;
    const fileDay = name.slice('audit-'.length, name.length - '.jsonl'.length);
    if (fileDay >= cutoffDay) continue; // not yet past retention

    const path = join(dir, name);
    if (held.size === 0) {
      unlinkSync(path);
      filesDeleted++;
      continue;
    }

    const raw = readFileSync(path, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const kept: string[] = [];
    for (const line of lines) {
      let tenantId: string | undefined;
      try {
        tenantId = (JSON.parse(line) as { tenantId?: string }).tenantId;
      } catch {
        // corrupt line — drop it, same tolerance as audit-log.ts's readAllEvents
      }
      if (tenantId && held.has(tenantId)) {
        kept.push(line);
      } else {
        linesRedacted++;
      }
    }

    if (kept.length === 0) {
      unlinkSync(path);
      filesDeleted++;
    } else if (kept.length !== lines.length) {
      writeFileSync(path, `${kept.join('\n')}\n`, 'utf8');
    }
  }

  return { filesDeleted, linesRedacted };
}
