/**
 * audit-log.ts — the append-only privileged-action audit trail (ADR-013 §5) and
 * its query + export surface (the in-dashboard viewer's backend).
 *
 * Scope (ADR-013 §5, deliberately narrow): privileged actions + RBAC denials
 * ONLY — role changes, member removal, invite create/revoke, api-key rotation,
 * billing/connector/schedule changes, and `rbac.denied`. NOT a general activity
 * feed, so volume stays trivial and the trail is signal, not noise.
 *
 * Two additions (audit-anomaly-alerter, `monitoring/security-anomaly-alerter.ts`):
 * `session.login` and `data.export` are recorded ONE line per event (not a
 * per-request feed) specifically because the anomaly detector needs them —
 * impossible-travel needs a login's `ip`, mass-export detection needs a
 * record of who exported what. Still signal, not noise: one line per login,
 * one per bulk export, same order of magnitude as `session.revoke`.
 *
 * One more addition (`marketplace/artifact-integrity.ts`): `marketplace.
 * artifact_hash_mismatch` records a fetch-time SHA-256 recheck failure against
 * `ListingVersion.manifestHash` (ADR-029 §4/checklist #5, any consumption
 * point — review fetch, install flow, the ADR-027 sandboxed-execution
 * loader). A mismatch is either an infra fault or an active tampering
 * attempt, so it is logged the same way ADR-027's Repudiation row logs a
 * denied tool call — signal, one line per abort.
 *
 * Persistence: append-only JSONL under `auditDir()` (env `MYAI_AUDIT_DIR`,
 * default `<cwd>/data/audit`), one file per UTC day (`audit-YYYY-MM-DD.jsonl`).
 * Dependency-light (node builtins only) and env-injectable — the SAME hermetic
 * discipline as brain.ts / team-brain.ts, so it tests without Mongo or a live
 * gateway. Records are immutable once written; there is no update/delete path by
 * design (an audit trail you can edit is not an audit trail). ADR-013 §5's Mongo
 * `AuditEvent` collection + 400-day TTL is the hosted-scale persistence swap;
 * this module is the pluggable, self-contained implementation behind it.
 *
 * Tamper-evidence: every event carries `prevHash` (the `hash` of the prior
 * event IN THIS TENANT'S OWN CHAIN — genesis = 64 zeros) and `hash` (SHA-256
 * over its own fields + `prevHash`). The chain is per-tenant, not global,
 * because day files interleave every tenant sharing this store — chaining
 * globally would let a tenant's `verifyAuditChain` result leak the existence/
 * ordering of another tenant's events. `verifyAuditChain` walks a tenant's
 * events in file/line order recomputing the chain, flagging any edited
 * content (`hash-mismatch`) or deleted/reordered/replaced record
 * (`prevhash-mismatch`). Like any hash chain without an external anchor, an
 * attacker who rewrites a record AND every subsequent record's `prevHash`/
 * `hash` in this tenant's chain can still forge a consistent tail — the
 * mitigation is periodic export (SOC2 evidence binder) acting as that anchor.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CtxRole, ToolContext } from './tenant-context.js';
import { getLogger } from '../shared/logger.js';

/** How the acting credential was resolved (ADR-013 §5 `actor.via`). */
export type AuditVia = 'jwt' | 'api-key' | 'system' | 'operator' | 'local';

/**
 * The privileged-action verbs the trail records (ADR-013 §5 `action`).
 * `AUDIT_ACTIONS` is the single source of truth — the union type is derived from
 * it, and the SOC2 evidence report reads it to prove WHICH actions the system
 * commits to logging (coverage), so a verb can never be silently untracked.
 */
export const AUDIT_ACTIONS = [
  'role.change',
  'member.remove',
  'invite.create',
  'invite.revoke',
  'apikey.create',
  'apikey.rotate',
  'apikey.revoke',
  'tenantkey.rotate',
  'rbac.denied',
  'billing.update',
  'connector.change',
  'schedule.change',
  'hook.toggle',
  'account.erasure_request',
  'account.erasure_cancel',
  'account.erasure_purge',
  'giftcode.mint',
  'giftcode.redeem',
  'giftcode.revoke',
  'totp.enable',
  'totp.disable',
  'totp.policy_change',
  'session.revoke',
  'session.revoke_all',
  'session.login',
  'data.export',
  'marketplace.artifact_hash_mismatch',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditActor {
  userId?: string;
  role: CtxRole;
  via: AuditVia;
}

/** A stored audit event (ADR-013 §5 `IAuditEvent`, file-backed shape). */
export interface AuditEvent {
  tenantId: string;
  eventId: string;
  actor: AuditActor;
  action: AuditAction;
  /** userId / connector name / schedule id … the object of the action. */
  target?: string;
  /** Structured extra, e.g. `{ from: 'member', to: 'admin' }`. */
  detail?: Record<string, unknown>;
  /** ISO-8601 UTC. */
  createdAt: string;
  /** `hash` of the prior event in this tenant's chain (genesis = 64 zeros). */
  prevHash: string;
  /** SHA-256 hex over this event's own fields + `prevHash` (tamper-evidence). */
  hash: string;
}

/** The fields a caller supplies; eventId/createdAt/prevHash/hash are stamped on write. */
export type AuditEventInput = Omit<AuditEvent, 'eventId' | 'createdAt' | 'prevHash' | 'hash'> & {
  eventId?: string;
  createdAt?: string;
};

/** One changed field in a config-change diff, as stamped into `AuditEvent.detail.diff`. */
export type FieldDiff = Record<string, { from: unknown; to: unknown }>;

/**
 * Compare `before`/`after` on `keys` and return only the fields that actually
 * changed (deep-equal via JSON, so array/object fields like connector `env`
 * or `args` diff correctly). The control-plane config-change audit (routing /
 * budget / entitlement / connector settings) uses this to stamp a before/after
 * diff onto `detail.diff` instead of the full before+after blobs, keeping the
 * trail readable. `before`/`after` absent (created/deleted) treats every
 * present-side value as changed from/to `undefined`.
 */
export function diffFields<T extends object>(
  before: T | null | undefined,
  after: T | null | undefined,
  keys: readonly (keyof T & string)[],
): FieldDiff {
  const b = before as Record<string, unknown> | null | undefined;
  const a = after as Record<string, unknown> | null | undefined;
  const diff: FieldDiff = {};
  for (const key of keys) {
    const from = b?.[key];
    const to = a?.[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      diff[key] = { from, to };
    }
  }
  return diff;
}

/**
 * Derive the audit `actor` for a control-plane config change from the
 * server-resolved `ToolContext` (never from caller args — same trust rule as
 * RBAC). `via` mirrors how the credential was resolved: local-trust loopback,
 * a scoped tenant API key, a dashboard JWT (has a human `userId`), or the
 * system/internal execution context otherwise.
 */
export function auditActorFromCtx(ctx: ToolContext | undefined): AuditActor {
  const via: AuditVia = ctx?.local ? 'local' : ctx?.keyId ? 'api-key' : ctx?.userId ? 'jwt' : 'system';
  return { userId: ctx?.userId, role: ctx?.role ?? 'system', via };
}

export interface AuditQuery {
  tenantId: string;
  /** Filter to one action verb (or a set). */
  action?: AuditAction | AuditAction[];
  /** Filter to one actor userId. */
  actorUserId?: string;
  /** Only events at/after this ISO timestamp. */
  since?: string;
  /** Only events at/before this ISO timestamp. */
  until?: string;
  /** Cap the result (newest first). Default 100, hard max 1000. */
  limit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** Resolve the audit directory (env-injectable for hermetic tests). */
export function auditDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MYAI_AUDIT_DIR || join(process.cwd(), 'data', 'audit');
}

function dayFile(dir: string, iso: string): string {
  // audit-YYYY-MM-DD.jsonl — day bucket keyed off the event's own timestamp.
  return join(dir, `audit-${iso.slice(0, 10)}.jsonl`);
}

function isDayFile(name: string): boolean {
  return name.startsWith('audit-') && name.endsWith('.jsonl');
}

/** Chain genesis — the `prevHash` of a tenant's first-ever event. */
const GENESIS_HASH = '0'.repeat(64);

/** Deterministic content hashed for one event: every persisted field but `hash` itself. */
type ChainableEvent = Omit<AuditEvent, 'hash'>;

function computeChainHash(e: ChainableEvent): string {
  const canonical = {
    tenantId: e.tenantId,
    eventId: e.eventId,
    actor: e.actor,
    action: e.action,
    target: e.target,
    detail: e.detail,
    createdAt: e.createdAt,
    prevHash: e.prevHash,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Find the `hash` of the last recorded event for `tenantId`, scanning day
 * files newest-first (filenames sort chronologically) and lines
 * bottom-to-top within each. Returns `GENESIS_HASH` if the tenant has no
 * prior events. Tolerates corrupt/partial lines the same way `readAllEvents`
 * does — a bad line is skipped, never thrown.
 */
function lastChainHash(dir: string, tenantId: string): string {
  if (!existsSync(dir)) return GENESIS_HASH;
  const files = readdirSync(dir).filter(isDayFile).sort();
  for (let i = files.length - 1; i >= 0; i--) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, files[i]), 'utf8');
    } catch {
      continue;
    }
    const lines = raw.split('\n');
    for (let j = lines.length - 1; j >= 0; j--) {
      const t = lines[j].trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t) as Partial<AuditEvent>;
        if (parsed.tenantId === tenantId && typeof parsed.hash === 'string') return parsed.hash;
      } catch {
        /* skip a corrupt/partial line, same tolerance as readAllEvents */
      }
    }
  }
  return GENESIS_HASH;
}

/**
 * A collision-resistant, sortable event id WITHOUT Math.random/Date.now coupling
 * concerns — derived from the timestamp plus a per-write counter and the tenant.
 * Uniqueness only needs to hold within a tenant's trail; the createdAt+counter
 * guarantees that for same-millisecond writes in one process.
 */
let writeCounter = 0;
function mintEventId(tenantId: string, iso: string): string {
  writeCounter = (writeCounter + 1) % 1_000_000;
  const stamp = iso.replace(/[-:.TZ]/g, '');
  return `evt_${stamp}_${writeCounter.toString(36)}_${tenantId.slice(0, 8)}`;
}

/**
 * Append one immutable event to the trail. Best-effort by contract: audit is a
 * side-record, so a write failure is LOGGED but never throws into the caller's
 * privileged action (we do not want role-change to fail because the disk is
 * full). Returns the stored event, or null if the write failed.
 */
export function recordAuditEvent(
  input: AuditEventInput,
  env: NodeJS.ProcessEnv = process.env,
): AuditEvent | null {
  try {
    const createdAt = input.createdAt || new Date().toISOString();
    const dir = auditDir(env);
    const prevHash = lastChainHash(dir, input.tenantId);
    const chainable: ChainableEvent = {
      tenantId: input.tenantId,
      eventId: input.eventId || mintEventId(input.tenantId, createdAt),
      actor: input.actor,
      action: input.action,
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      createdAt,
      prevHash,
    };
    const event: AuditEvent = { ...chainable, hash: computeChainHash(chainable) };
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(dayFile(dir, createdAt), `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  } catch (err) {
    getLogger().error({ err, action: input.action, tenantId: input.tenantId }, 'audit.write-failed');
    return null;
  }
}

/** Read every event across all day-files (unsorted). Robust to partial lines. */
function readAllEvents(dir: string): AuditEvent[] {
  if (!existsSync(dir)) return [];
  const events: AuditEvent[] = [];
  for (const name of readdirSync(dir)) {
    if (!isDayFile(name)) continue;
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        events.push(JSON.parse(t) as AuditEvent);
      } catch {
        /* skip a corrupt/partial line — never let one bad row break the viewer */
      }
    }
  }
  return events;
}

/**
 * Query the trail (the viewer's backend). Tenant-scoped ALWAYS (fail-closed on a
 * missing tenantId — a cross-tenant audit read would be a leak). Newest first,
 * capped at `limit`.
 */
export function queryAuditEvents(query: AuditQuery, env: NodeJS.ProcessEnv = process.env): AuditEvent[] {
  if (!query?.tenantId) return [];
  const actions = query.action
    ? new Set(Array.isArray(query.action) ? query.action : [query.action])
    : undefined;
  const limit = Math.min(Math.max(Math.trunc(query.limit || DEFAULT_LIMIT), 1), MAX_LIMIT);

  return readAllEvents(auditDir(env))
    .filter((e) => e.tenantId === query.tenantId)
    .filter((e) => (actions ? actions.has(e.action) : true))
    .filter((e) => (query.actorUserId ? e.actor?.userId === query.actorUserId : true))
    .filter((e) => (query.since ? e.createdAt >= query.since : true))
    .filter((e) => (query.until ? e.createdAt <= query.until : true))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, limit);
}

/** One detected break in a tenant's hash chain. */
export interface AuditChainIssue {
  file: string;
  /** 1-indexed line within `file`. */
  line: number;
  eventId?: string;
  /**
   * `hash-mismatch` — event content doesn't match its own stored `hash` (edited in place).
   * `prevhash-mismatch` — event's `prevHash` doesn't match the prior event's `hash`
   *   (a record was deleted, reordered, or replaced).
   * `unchained` — event predates this feature (no `hash`/`prevHash` stamped); flagged for
   *   visibility but doesn't fail `ok`, and the chain resumes trusting this event's neighbor.
   */
  reason: 'hash-mismatch' | 'prevhash-mismatch' | 'unchained';
}

export interface AuditChainVerifyResult {
  ok: boolean;
  tenantId: string;
  /** Day files scanned (regardless of whether they contained this tenant's events). */
  filesChecked: number;
  /** This tenant's events found across those files. */
  eventsChecked: number;
  /** Lines that failed to parse as JSON at all — cannot be attributed to a tenant. */
  corruptLines: number;
  issues: AuditChainIssue[];
}

/**
 * Verify one tenant's hash chain end-to-end (the SOC2 tamper-evidence check).
 * Walks day files oldest-first (filenames sort chronologically) and, within
 * each, lines top-to-bottom, recomputing the chain over just this tenant's
 * events (see the file-header note on why the chain is per-tenant). Fail-closed
 * on a missing tenantId, same discipline as `queryAuditEvents`/`exportAuditEvents`.
 */
export function verifyAuditChain(tenantId: string, env: NodeJS.ProcessEnv = process.env): AuditChainVerifyResult {
  if (!tenantId) {
    return { ok: false, tenantId: '', filesChecked: 0, eventsChecked: 0, corruptLines: 0, issues: [] };
  }

  const dir = auditDir(env);
  const issues: AuditChainIssue[] = [];
  let filesChecked = 0;
  let eventsChecked = 0;
  let corruptLines = 0;
  // null = "unknown baseline" (right after an unchained legacy event) — the next
  // event's prevHash is trusted rather than checked, so migration doesn't cascade.
  let expected: string | null = GENESIS_HASH;

  if (existsSync(dir)) {
    const files = readdirSync(dir).filter(isDayFile).sort();
    for (const name of files) {
      let raw: string;
      try {
        raw = readFileSync(join(dir, name), 'utf8');
      } catch {
        continue;
      }
      filesChecked++;
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t) continue;
        let parsed: Partial<AuditEvent>;
        try {
          parsed = JSON.parse(t) as Partial<AuditEvent>;
        } catch {
          corruptLines++;
          continue;
        }
        if (parsed.tenantId !== tenantId) continue;
        eventsChecked++;
        const line = i + 1;

        if (typeof parsed.hash !== 'string' || typeof parsed.prevHash !== 'string') {
          issues.push({ file: name, line, eventId: parsed.eventId, reason: 'unchained' });
          expected = null;
          continue;
        }
        if (expected !== null && parsed.prevHash !== expected) {
          issues.push({ file: name, line, eventId: parsed.eventId, reason: 'prevhash-mismatch' });
        }
        const recomputed = computeChainHash({
          tenantId: parsed.tenantId,
          eventId: parsed.eventId!,
          actor: parsed.actor!,
          action: parsed.action!,
          target: parsed.target,
          detail: parsed.detail,
          createdAt: parsed.createdAt!,
          prevHash: parsed.prevHash,
        });
        if (recomputed !== parsed.hash) {
          issues.push({ file: name, line, eventId: parsed.eventId, reason: 'hash-mismatch' });
        }
        expected = parsed.hash;
      }
    }
  }

  const ok = issues.every((issue) => issue.reason === 'unchained');
  return { ok, tenantId, filesChecked, eventsChecked, corruptLines, issues };
}

const CSV_COLUMNS = ['createdAt', 'action', 'actorUserId', 'actorRole', 'actorVia', 'target', 'detail'] as const;

/** RFC-4180 field escaping. */
function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsvRow(e: AuditEvent): string {
  return [
    e.createdAt,
    e.action,
    e.actor?.userId ?? '',
    e.actor?.role ?? '',
    e.actor?.via ?? '',
    e.target ?? '',
    e.detail ?? '',
  ].map(csvCell).join(',');
}

export type AuditExportFormat = 'json' | 'csv';

/**
 * Export a tenant's trail for download / SOC2 evidence (ADR-013 §5 export). Same
 * tenant-scoped filter as `queryAuditEvents`, but uncapped by default (pass a
 * `limit` to bound). Returns a `{ body, contentType, filename }` triple the REST
 * route streams straight to the browser's download.
 */
export function exportAuditEvents(
  query: AuditQuery,
  format: AuditExportFormat = 'json',
  env: NodeJS.ProcessEnv = process.env,
): { body: string; contentType: string; filename: string } {
  const events = queryAuditEvents({ ...query, limit: query.limit ?? MAX_LIMIT }, env);
  const stamp = (query.until || new Date().toISOString()).slice(0, 10);
  if (format === 'csv') {
    const lines = [CSV_COLUMNS.join(','), ...events.map(toCsvRow)];
    return {
      body: `${lines.join('\n')}\n`,
      contentType: 'text/csv; charset=utf-8',
      filename: `audit-${query.tenantId}-${stamp}.csv`,
    };
  }
  return {
    body: JSON.stringify({ tenantId: query.tenantId, exportedAt: new Date().toISOString(), count: events.length, events }, null, 2),
    contentType: 'application/json; charset=utf-8',
    filename: `audit-${query.tenantId}-${stamp}.json`,
  };
}
