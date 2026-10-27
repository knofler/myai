// Swarm data straight from Atlas — the CLOUD path for /swarm.
//
// The local dashboard reads swarms through the gateway's MCP tools; the Vercel
// deployment cannot reach a gateway (it runs on the operator's Mac), but the
// gateway's store IS Atlas: `swarms`, `tasks` (children carry swarmId) and
// `mailbox_messages` in the `myai` database. This module reads and writes those
// collections with the SAME rules as runtime/src/tasks/swarm-store.ts
// (approveSwarm / stopSwarm / getSwarm's done-on-read) so a swarm behaves
// identically whichever dashboard drives it. Server-side only (API routes).
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { tenantFilter } from '@/lib/tenant';
import {
  mailAddresses,
  rowsToExpand,
  type ChildDisplayStatus,
  type MailMessage,
  type SwarmChild,
  type SwarmRow,
  type SwarmSnapshot,
  type SwarmWithChildren,
} from '@/lib/swarm-live';

const SWARM_LIMIT = 20;
const MAIL_LIMIT = 40;

/** Same mapping as swarm-store.ts childDisplayStatus. */
export function childDisplayStatus(status: string): ChildDisplayStatus {
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

type Doc = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : undefined);

function toRow(d: Doc): SwarmRow {
  return {
    swarmId: String(d.swarmId), repo: String(d.repo), goal: String(d.goal),
    status: d.status as SwarmRow['status'], childCap: Number(d.childCap ?? 5), childCount: Number(d.childCount ?? 0),
    createdBy: String(d.createdBy ?? ''), tokenBudget: d.tokenBudget as number | undefined, tokenSpent: Number(d.tokenSpent ?? 0),
    notes: d.notes as string | undefined, approvedAt: iso(d.approvedAt), approvedBy: d.approvedBy as string | undefined,
    stoppedAt: iso(d.stoppedAt), stoppedBy: d.stoppedBy as string | undefined, completedAt: iso(d.completedAt),
    createdAt: iso(d.createdAt) ?? '', updatedAt: iso(d.updatedAt) ?? '',
  };
}

function toChild(d: Doc): SwarmChild {
  return {
    taskId: String(d.taskId), title: String(d.title), status: String(d.status),
    displayStatus: childDisplayStatus(String(d.status)), assignedAgent: d.assignedAgent as string | undefined,
    priority: d.priority as string | undefined, dependsOn: (d.dependsOn as string[] | undefined)?.length ? (d.dependsOn as string[]) : undefined,
    claimedBy: d.claimedBy as string | undefined, prUrl: d.prUrl as string | undefined,
    createdAt: iso(d.createdAt) ?? '', updatedAt: iso(d.updatedAt) ?? '',
  };
}

function toMail(d: Doc): MailMessage {
  return {
    messageId: String(d.messageId), to: String(d.to), from: String(d.from), kind: d.kind as string | undefined,
    subject: String(d.subject), body: d.body as string | undefined, swarmId: d.swarmId as string | undefined,
    acked: Boolean(d.acked), createdAt: iso(d.createdAt) ?? '',
  };
}

async function cols() {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error('database not connected');
  return { swarms: db.collection('swarms'), tasks: db.collection('tasks'), mail: db.collection('mailbox_messages') };
}

async function childrenOf(tenantId: string, swarmId: string): Promise<SwarmChild[]> {
  const { tasks } = await cols();
  const docs = await tasks.find({ ...tenantFilter(tenantId), swarmId }).sort({ createdAt: 1 }).toArray();
  return docs.map((d) => toChild(d as Doc));
}

/** One swarm + children; an active swarm whose children are all finished is marked done (getSwarm parity). */
export async function getSwarmAtlas(tenantId: string, swarmId: string): Promise<SwarmWithChildren | null> {
  const { swarms } = await cols();
  const doc = await swarms.findOne({ ...tenantFilter(tenantId), swarmId });
  if (!doc) return null;
  let row = toRow(doc as Doc);
  const children = await childrenOf(tenantId, swarmId);
  if (row.status === 'active' && children.length > 0 && children.every((c) => c.displayStatus === 'done')) {
    const now = new Date();
    await swarms.updateOne({ ...tenantFilter(tenantId), swarmId, status: 'active' }, { $set: { status: 'done', completedAt: now, updatedAt: now } });
    row = { ...row, status: 'done', completedAt: now.toISOString() };
  }
  return { swarm: row, children };
}

export async function snapshotAtlas(tenantId: string): Promise<SwarmSnapshot> {
  const { swarms, mail } = await cols();
  const rows = (await swarms.find(tenantFilter(tenantId)).sort({ createdAt: -1 }).limit(SWARM_LIMIT).toArray()).map((d) => toRow(d as Doc));
  const expand = rowsToExpand(rows);
  const detailed = await Promise.all(rows.map(async (row): Promise<SwarmWithChildren> => {
    if (!expand.has(row.swarmId)) return { swarm: row, children: [], detail: 'omitted' };
    return (await getSwarmAtlas(tenantId, row.swarmId)) ?? { swarm: row, children: [], detail: 'error' };
  }));
  const to = mailAddresses(detailed).map((a) => a.toLowerCase());
  const messages = to.length
    ? (await mail.find({ ...tenantFilter(tenantId), to: { $in: to } }).sort({ createdAt: -1 }).limit(MAIL_LIMIT).toArray()).map((d) => toMail(d as Doc))
    : [];
  return { swarms: detailed, mail: messages, gatewayOk: true, fetchedAt: new Date().toISOString() };
}

export class SwarmActionError extends Error {}

/** approveSwarm parity: paused|stopped → active (atomic claim), every paused child → pending. */
export async function approveSwarmAtlas(tenantId: string, swarmId: string, approvedBy: string) {
  const { swarms, tasks } = await cols();
  const existing = await swarms.findOne({ ...tenantFilter(tenantId), swarmId });
  if (!existing) return null;
  if (existing.status !== 'paused' && existing.status !== 'stopped') {
    throw new SwarmActionError(`swarm ${swarmId} is ${existing.status} — only a paused or stopped swarm can be approved`);
  }
  const now = new Date();
  const claimed = await swarms.findOneAndUpdate(
    { ...tenantFilter(tenantId), swarmId, status: existing.status },
    { $set: { status: 'active', approvedAt: now, approvedBy, updatedAt: now } },
    { returnDocument: 'after' },
  );
  if (!claimed) throw new SwarmActionError(`swarm ${swarmId} changed state concurrently — re-read and retry`);
  const res = await tasks.updateMany({ ...tenantFilter(tenantId), swarmId, status: 'paused' }, { $set: { status: 'pending', updatedAt: now } });
  return { ...(await getSwarmAtlas(tenantId, swarmId)), approved: res.modifiedCount };
}

/** stopSwarm parity: swarm → stopped, open children (pending|working) → paused, mail creator + every child agent. */
export async function stopSwarmAtlas(tenantId: string, swarmId: string, stoppedBy: string, reason?: string) {
  const { swarms, tasks, mail } = await cols();
  const existing = await swarms.findOne({ ...tenantFilter(tenantId), swarmId });
  if (!existing) return null;
  if (existing.status === 'stopped' || existing.status === 'done') return { ...(await getSwarmAtlas(tenantId, swarmId)), paused: 0, mailed: [] };
  const now = new Date();
  await swarms.updateOne({ ...tenantFilter(tenantId), swarmId }, { $set: { status: 'stopped', stoppedAt: now, stoppedBy, updatedAt: now } });
  const children = await tasks.find({ ...tenantFilter(tenantId), swarmId }).toArray();
  const res = await tasks.updateMany(
    { ...tenantFilter(tenantId), swarmId, status: { $in: ['pending', 'working'] } },
    { $set: { status: 'paused', updatedAt: now, notes: `swarm ${swarmId} stopped by ${stoppedBy}` } },
  );
  const recipients = [...new Set([existing.createdBy, ...children.map((c) => c.assignedAgent)]
    .map((a) => String(a ?? '').trim().toLowerCase()).filter(Boolean))];
  const mailed: string[] = [];
  for (const to of recipients) {
    try { // a mail failure must not undo the stop — the pause is the safety action
      await mail.insertOne({
        tenantId, messageId: `mail-${randomUUID()}`, to, from: 'swarm-guard', kind: 'swarm', swarmId,
        subject: `Swarm ${swarmId} stopped by ${stoppedBy}`,
        body: `${existing.goal}\n\n${res.modifiedCount} open child(ren) paused.${reason ? ` Reason: ${reason}` : ''} Re-approve the swarm (swarm_approve) to resume.`,
        acked: false, createdAt: now, updatedAt: now,
      });
      mailed.push(to);
    } catch { /* keep stopping */ }
  }
  return { ...(await getSwarmAtlas(tenantId, swarmId)), paused: res.modifiedCount, mailed };
}

export async function ackMailAtlas(tenantId: string, messageId: string, ackedBy: string) {
  const { mail } = await cols();
  const now = new Date();
  const doc = await mail.findOneAndUpdate(
    { ...tenantFilter(tenantId), messageId },
    { $set: { acked: true, ackedAt: now, ackedBy, updatedAt: now } },
    { returnDocument: 'after' },
  );
  return doc ? toMail(doc as Doc) : null;
}
