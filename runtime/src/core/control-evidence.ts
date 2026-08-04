/**
 * control-evidence.ts — continuous evidence capture for a SOC2 **Type II**
 * observation period (distinct from the Type I-style, point-in-time surfaces
 * in access-review.ts / evidence.ts / audit-log.ts, PR #343 `8907c60`).
 *
 * Type I proves controls are DESIGNED correctly at one moment (what
 * evidence.ts exports today). Type II additionally requires proving those
 * controls OPERATED EFFECTIVELY across a sustained window (typically
 * 3–12 months). That needs three things the existing surfaces don't capture,
 * because they only compute state on demand when someone calls the export
 * endpoint:
 *
 *   1. Periodic **snapshots** — proof a control was actually re-evaluated on
 *      a cadence (e.g. quarterly access review), not just exportable at
 *      audit time. `recordSnapshot` + `buildObservationWindowReport`'s gap
 *      analysis is what lets an assessor see "this ran every ~90 days for
 *      the whole window" instead of trusting a single end-of-period export.
 *   2. **Control-exception** logging — controls fail sometimes; Type II asks
 *      for evidence that failures were CAUGHT and remediated, not that
 *      nothing ever went wrong. `recordException` / `resolveException`.
 *   3. A **change-log of access-review actions** — who acted on a stale/
 *      privileged row, when, and why (approve / revoke / role-change).
 *      access-review.ts only computes the flag; it never recorded the
 *      human decision made in response. `recordReviewAction`.
 *
 * Same hermetic discipline as audit-log.ts (node builtins only, env-injectable
 * dir, no Mongo/gateway coupling) and the same per-tenant SHA-256 hash chain
 * for tamper-evidence, deliberately duplicated rather than imported — this is
 * a separate evidence store with its own retention/verify story, and Type II
 * evidence must not silently share a chain (and therefore a single point of
 * failure) with the privileged-action audit trail it complements.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AuditActor } from './audit-log.js';
import { getLogger } from '../shared/logger.js';

export type ControlEvidenceKind = 'snapshot' | 'exception' | 'review-action';

export type ControlExceptionSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ControlExceptionStatus = 'open' | 'resolved';
export type AccessReviewDecision = 'confirmed' | 'revoked' | 'role-changed' | 'no-action';

/** A periodic point-in-time capture of a control's state (proves cadence). */
export interface ControlSnapshotDetail {
  kind: 'snapshot';
  /** e.g. 'access-review', 'audit-chain-integrity', 'backup-verification'. */
  controlId: string;
  /** ISO — when the underlying control state was evaluated (may lag `createdAt` slightly). */
  capturedAt: string;
  source: 'scheduled' | 'manual';
  /** Freeform control-specific summary, e.g. an AccessReviewSummary or AuditChainVerifyResult. */
  summary: Record<string, unknown>;
}

/** A detected deviation from a control's expected operation. */
export interface ControlExceptionDetail {
  kind: 'exception';
  controlId: string;
  severity: ControlExceptionSeverity;
  description: string;
  status: ControlExceptionStatus;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionReason?: string;
  /** Set only on a 'resolved' record: the eventId of the original 'open' record it closes. */
  resolvesEventId?: string;
}

/** The who/when/why behind a decision taken on an access-review row. */
export interface AccessReviewActionDetail {
  kind: 'review-action';
  /** Ties this action back to the AccessReview.generatedAt it was taken against. */
  reviewGeneratedAt: string;
  targetUserId: string;
  decision: AccessReviewDecision;
  reason: string;
}

export type ControlEvidenceDetail = ControlSnapshotDetail | ControlExceptionDetail | AccessReviewActionDetail;

/** A stored, hash-chained control-evidence event. */
export interface ControlEvidenceEvent {
  tenantId: string;
  eventId: string;
  actor: AuditActor;
  detail: ControlEvidenceDetail;
  /** ISO-8601 UTC — when this evidence record was written. */
  createdAt: string;
  prevHash: string;
  hash: string;
}

export type ControlEvidenceInput = {
  tenantId: string;
  actor: AuditActor;
  createdAt?: string;
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const GENESIS_HASH = '0'.repeat(64);

/** Resolve the control-evidence directory (env-injectable for hermetic tests). */
export function controlEvidenceDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MYAI_CONTROL_EVIDENCE_DIR || join(process.cwd(), 'data', 'control-evidence');
}

function dayFile(dir: string, iso: string): string {
  return join(dir, `evidence-${iso.slice(0, 10)}.jsonl`);
}

function isDayFile(name: string): boolean {
  return name.startsWith('evidence-') && name.endsWith('.jsonl');
}

type ChainableEvent = Omit<ControlEvidenceEvent, 'hash'>;

function computeChainHash(e: ChainableEvent): string {
  const canonical = {
    tenantId: e.tenantId,
    eventId: e.eventId,
    actor: e.actor,
    detail: e.detail,
    createdAt: e.createdAt,
    prevHash: e.prevHash,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Same newest-file/newest-line-first scan as audit-log.ts's `lastChainHash`. */
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
        const parsed = JSON.parse(t) as Partial<ControlEvidenceEvent>;
        if (parsed.tenantId === tenantId && typeof parsed.hash === 'string') return parsed.hash;
      } catch {
        /* skip a corrupt/partial line, same tolerance as readAllEvents */
      }
    }
  }
  return GENESIS_HASH;
}

let writeCounter = 0;
function mintEventId(tenantId: string, iso: string): string {
  writeCounter = (writeCounter + 1) % 1_000_000;
  const stamp = iso.replace(/[-:.TZ]/g, '');
  return `cev_${stamp}_${writeCounter.toString(36)}_${tenantId.slice(0, 8)}`;
}

/**
 * Append one immutable evidence event. Best-effort by contract, same as
 * `recordAuditEvent` — a write failure is logged but never thrown, so a
 * disk-full evidence store can't take down the control it's observing.
 */
function append(
  input: ControlEvidenceInput & { detail: ControlEvidenceDetail },
  env: NodeJS.ProcessEnv,
): ControlEvidenceEvent | null {
  try {
    const createdAt = input.createdAt || new Date().toISOString();
    const dir = controlEvidenceDir(env);
    const prevHash = lastChainHash(dir, input.tenantId);
    const chainable: ChainableEvent = {
      tenantId: input.tenantId,
      eventId: mintEventId(input.tenantId, createdAt),
      actor: input.actor,
      detail: input.detail,
      createdAt,
      prevHash,
    };
    const event: ControlEvidenceEvent = { ...chainable, hash: computeChainHash(chainable) };
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(dayFile(dir, createdAt), `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  } catch (err) {
    getLogger().error({ err, tenantId: input.tenantId, kind: input.detail.kind }, 'control-evidence.write-failed');
    return null;
  }
}

/** Record a periodic snapshot of a control's state (cadence evidence). */
export function recordSnapshot(
  input: ControlEvidenceInput & Omit<ControlSnapshotDetail, 'kind'>,
  env: NodeJS.ProcessEnv = process.env,
): ControlEvidenceEvent | null {
  const { tenantId, actor, createdAt, controlId, capturedAt, source, summary } = input;
  return append({ tenantId, actor, createdAt, detail: { kind: 'snapshot', controlId, capturedAt, source, summary } }, env);
}

/** Record a newly-detected control exception. Always opens as `status: 'open'`. */
export function recordException(
  input: ControlEvidenceInput & { controlId: string; severity: ControlExceptionSeverity; description: string },
  env: NodeJS.ProcessEnv = process.env,
): ControlEvidenceEvent | null {
  const { tenantId, actor, createdAt, controlId, severity, description } = input;
  return append(
    { tenantId, actor, createdAt, detail: { kind: 'exception', controlId, severity, description, status: 'open' } },
    env,
  );
}

/**
 * Close an open exception with who/when/why. Appends a NEW 'resolved' record
 * (the store is append-only — nothing is edited in place) pointing back at
 * the original via `resolvesEventId`. Returns null if the referenced
 * exception can't be found for this tenant, or is not currently open
 * (already resolved, or not an exception at all).
 */
export function resolveException(
  input: ControlEvidenceInput & { exceptionEventId: string; resolutionReason: string },
  env: NodeJS.ProcessEnv = process.env,
): ControlEvidenceEvent | null {
  const { tenantId, actor, createdAt, exceptionEventId, resolutionReason } = input;
  const events = readAllEvents(controlEvidenceDir(env)).filter((e) => e.tenantId === tenantId);

  const original = events.find(
    (e): e is ControlEvidenceEvent & { detail: ControlExceptionDetail } =>
      e.eventId === exceptionEventId && e.detail.kind === 'exception',
  );
  if (!original) return null;

  const alreadyResolved = events.some(
    (e) => e.detail.kind === 'exception' && e.detail.status === 'resolved' && e.detail.resolvesEventId === exceptionEventId,
  );
  if (alreadyResolved || original.detail.status !== 'open') return null;

  return append(
    {
      tenantId,
      actor,
      createdAt,
      detail: {
        kind: 'exception',
        controlId: original.detail.controlId,
        severity: original.detail.severity,
        description: original.detail.description,
        status: 'resolved',
        resolvedAt: createdAt || new Date().toISOString(),
        resolvedBy: actor.userId,
        resolutionReason,
        resolvesEventId: exceptionEventId,
      },
    },
    env,
  );
}

/** Record the human decision taken on one access-review row (the who/when/why gap). */
export function recordReviewAction(
  input: ControlEvidenceInput & Omit<AccessReviewActionDetail, 'kind'>,
  env: NodeJS.ProcessEnv = process.env,
): ControlEvidenceEvent | null {
  const { tenantId, actor, createdAt, reviewGeneratedAt, targetUserId, decision, reason } = input;
  return append(
    { tenantId, actor, createdAt, detail: { kind: 'review-action', reviewGeneratedAt, targetUserId, decision, reason } },
    env,
  );
}

function readAllEvents(dir: string): ControlEvidenceEvent[] {
  if (!existsSync(dir)) return [];
  const events: ControlEvidenceEvent[] = [];
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
        events.push(JSON.parse(t) as ControlEvidenceEvent);
      } catch {
        /* skip a corrupt/partial line — never let one bad row break a query */
      }
    }
  }
  return events;
}

export interface ControlEvidenceQuery {
  tenantId: string;
  kind?: ControlEvidenceKind | ControlEvidenceKind[];
  controlId?: string;
  since?: string;
  until?: string;
  limit?: number;
}

/** Query the evidence store, tenant-scoped always (fail-closed on missing tenantId). */
export function queryControlEvidence(
  query: ControlEvidenceQuery,
  env: NodeJS.ProcessEnv = process.env,
): ControlEvidenceEvent[] {
  if (!query?.tenantId) return [];
  const kinds = query.kind ? new Set(Array.isArray(query.kind) ? query.kind : [query.kind]) : undefined;
  const limit = Math.min(Math.max(Math.trunc(query.limit || DEFAULT_LIMIT), 1), MAX_LIMIT);

  return readAllEvents(controlEvidenceDir(env))
    .filter((e) => e.tenantId === query.tenantId)
    .filter((e) => (kinds ? kinds.has(e.detail.kind) : true))
    .filter((e) => (query.controlId ? 'controlId' in e.detail && e.detail.controlId === query.controlId : true))
    .filter((e) => (query.since ? e.createdAt >= query.since : true))
    .filter((e) => (query.until ? e.createdAt <= query.until : true))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, limit);
}

/** One detected break in a tenant's control-evidence hash chain (mirrors AuditChainIssue). */
export interface ControlEvidenceChainIssue {
  file: string;
  line: number;
  eventId?: string;
  reason: 'hash-mismatch' | 'prevhash-mismatch';
}

export interface ControlEvidenceChainVerifyResult {
  ok: boolean;
  tenantId: string;
  filesChecked: number;
  eventsChecked: number;
  corruptLines: number;
  issues: ControlEvidenceChainIssue[];
}

/** Verify one tenant's control-evidence hash chain end-to-end (same design as verifyAuditChain). */
export function verifyControlEvidenceChain(
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): ControlEvidenceChainVerifyResult {
  if (!tenantId) {
    return { ok: false, tenantId: '', filesChecked: 0, eventsChecked: 0, corruptLines: 0, issues: [] };
  }
  const dir = controlEvidenceDir(env);
  const issues: ControlEvidenceChainIssue[] = [];
  let filesChecked = 0;
  let eventsChecked = 0;
  let corruptLines = 0;
  let expected: string = GENESIS_HASH;

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
        let parsed: Partial<ControlEvidenceEvent>;
        try {
          parsed = JSON.parse(t) as Partial<ControlEvidenceEvent>;
        } catch {
          corruptLines++;
          continue;
        }
        if (parsed.tenantId !== tenantId) continue;
        eventsChecked++;
        const line = i + 1;

        if (parsed.prevHash !== expected) {
          issues.push({ file: name, line, eventId: parsed.eventId, reason: 'prevhash-mismatch' });
        }
        const recomputed = computeChainHash({
          tenantId: parsed.tenantId,
          eventId: parsed.eventId!,
          actor: parsed.actor!,
          detail: parsed.detail!,
          createdAt: parsed.createdAt!,
          prevHash: parsed.prevHash!,
        });
        if (recomputed !== parsed.hash) {
          issues.push({ file: name, line, eventId: parsed.eventId, reason: 'hash-mismatch' });
        }
        expected = parsed.hash as string;
      }
    }
  }

  return { ok: issues.length === 0, tenantId, filesChecked, eventsChecked, corruptLines, issues };
}

/** Default expected re-evaluation cadence for a continuously-observed control (~quarterly + slack). */
export const DEFAULT_EXPECTED_CADENCE_DAYS = 100;

const MS_PER_DAY = 86_400_000;

/** One gap between consecutive snapshots that exceeded the expected cadence. */
export interface CadenceGap {
  fromCapturedAt: string;
  toCapturedAt: string;
  gapDays: number;
}

export interface ObservationCadence {
  controlId: string;
  expectedCadenceDays: number;
  snapshotCount: number;
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
  gaps: CadenceGap[];
  /** True when the control was captured at least once and no gap exceeded `expectedCadenceDays`. */
  continuous: boolean;
}

export interface ObservationExceptions {
  opened: number;
  resolvedWithinWindow: number;
  /** Exceptions opened in-or-before the window that remain open at `until` (no resolving record found by then). */
  stillOpenAtEnd: number;
  /** Mean days from open to resolution, for exceptions resolved within the window. Null if none resolved. */
  meanResolutionDays: number | null;
}

export interface ObservationReviewActions {
  total: number;
  byDecision: Record<string, number>;
}

/**
 * The Type II observation-window report: proves a control operated
 * continuously over `[since, until]`, not just that it was correctly
 * configured at one moment. Combines cadence-gap analysis over snapshots,
 * an exception open/resolve summary, a review-action decision tally, and
 * the hash-chain integrity check — the four things an assessor asks for
 * beyond the existing point-in-time evidence.ts bundle.
 */
export interface ObservationWindowReport {
  reportType: 'soc2-type2-observation-window';
  tenantId: string;
  generatedAt: string;
  window: { since: string; until: string };
  cadence: ObservationCadence;
  exceptions: ObservationExceptions;
  reviewActions: ObservationReviewActions;
  chain: ControlEvidenceChainVerifyResult;
}

export interface BuildObservationWindowReportOptions {
  controlId?: string;
  expectedCadenceDays?: number;
  now?: string;
}

/**
 * Build the Type II observation-window report for `tenantId` over
 * `[since, until]`. Reads the full evidence store for the tenant (not just
 * the window) for exceptions/chain-verify, because "opened before the window,
 * still open at window end" and chain integrity both need context outside
 * the window to answer correctly.
 */
export function buildObservationWindowReport(
  tenantId: string,
  since: string,
  until: string,
  opts: BuildObservationWindowReportOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ObservationWindowReport {
  const controlId = opts.controlId || 'access-review';
  const expectedCadenceDays = opts.expectedCadenceDays && opts.expectedCadenceDays > 0 ? opts.expectedCadenceDays : DEFAULT_EXPECTED_CADENCE_DAYS;
  const generatedAt = opts.now || new Date().toISOString();

  const allEvents = queryControlEvidence({ tenantId, limit: MAX_LIMIT }, env).slice().reverse(); // oldest-first for scans below

  // ── Cadence: snapshots for this control within the window, oldest-first ──
  const snapshots = allEvents.filter(
    (e): e is ControlEvidenceEvent & { detail: ControlSnapshotDetail } =>
      e.detail.kind === 'snapshot' && e.detail.controlId === controlId && e.createdAt >= since && e.createdAt <= until,
  );
  const gaps: CadenceGap[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1].detail.capturedAt;
    const curr = snapshots[i].detail.capturedAt;
    const gapDays = Math.round((new Date(curr).getTime() - new Date(prev).getTime()) / MS_PER_DAY);
    if (gapDays > expectedCadenceDays) gaps.push({ fromCapturedAt: prev, toCapturedAt: curr, gapDays });
  }
  const cadence: ObservationCadence = {
    controlId,
    expectedCadenceDays,
    snapshotCount: snapshots.length,
    firstCapturedAt: snapshots[0]?.detail.capturedAt ?? null,
    lastCapturedAt: snapshots[snapshots.length - 1]?.detail.capturedAt ?? null,
    gaps,
    continuous: snapshots.length > 0 && gaps.length === 0,
  };

  // ── Exceptions: opened-in-window count, resolved-in-window count + MTTR, still-open-at-end ──
  const exceptionEvents = allEvents.filter(
    (e): e is ControlEvidenceEvent & { detail: ControlExceptionDetail } => e.detail.kind === 'exception',
  );
  const openedInWindow = exceptionEvents.filter(
    (e) => e.detail.status === 'open' && e.createdAt >= since && e.createdAt <= until,
  );
  const resolvedEvents = exceptionEvents.filter((e) => e.detail.status === 'resolved');
  const resolvedInWindow = resolvedEvents.filter((e) => e.createdAt >= since && e.createdAt <= until);

  const resolutionDays: number[] = [];
  for (const r of resolvedInWindow) {
    const openEvent = exceptionEvents.find((e) => e.eventId === r.detail.resolvesEventId && e.detail.status === 'open');
    if (openEvent) {
      resolutionDays.push((new Date(r.createdAt).getTime() - new Date(openEvent.createdAt).getTime()) / MS_PER_DAY);
    }
  }

  const openedAtOrBeforeEnd = exceptionEvents.filter((e) => e.detail.status === 'open' && e.createdAt <= until);
  const resolvedEventIds = new Set(resolvedEvents.map((e) => e.detail.resolvesEventId));
  const stillOpenAtEnd = openedAtOrBeforeEnd.filter((e) => !resolvedEventIds.has(e.eventId)).length;

  const exceptions: ObservationExceptions = {
    opened: openedInWindow.length,
    resolvedWithinWindow: resolvedInWindow.length,
    stillOpenAtEnd,
    meanResolutionDays: resolutionDays.length
      ? Math.round((resolutionDays.reduce((a, b) => a + b, 0) / resolutionDays.length) * 10) / 10
      : null,
  };

  // ── Review actions: decision tally within the window ──
  const reviewActionEvents = allEvents.filter(
    (e): e is ControlEvidenceEvent & { detail: AccessReviewActionDetail } =>
      e.detail.kind === 'review-action' && e.createdAt >= since && e.createdAt <= until,
  );
  const byDecision: Record<string, number> = {};
  for (const e of reviewActionEvents) byDecision[e.detail.decision] = (byDecision[e.detail.decision] ?? 0) + 1;

  return {
    reportType: 'soc2-type2-observation-window',
    tenantId,
    generatedAt,
    window: { since, until },
    cadence,
    exceptions,
    reviewActions: { total: reviewActionEvents.length, byDecision },
    chain: verifyControlEvidenceChain(tenantId, env),
  };
}
