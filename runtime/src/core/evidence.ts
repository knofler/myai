/**
 * evidence.ts — the SOC2 evidence-export report (ADR-013 §5).
 *
 * A single, auditor-ready bundle that a tenant owner/admin downloads at review
 * time. It stitches together the two governance surfaces an assessor asks for:
 *
 *   1. Access review  — who has access, at what privilege, last-active + stale
 *      flags (CC6.1–CC6.3, periodic access certification).
 *   2. Audit coverage — the privileged-action trail for the period, summarised
 *      by verb, with the full tracked-verb list so the assessor sees WHICH
 *      privileged actions the system commits to logging (CC7.2 monitoring).
 *
 * Pure + dependency-light: it takes the already-fetched member list and audit
 * events as inputs (the route fetches them), so it unit-tests without Mongo or a
 * live gateway — the same hermetic discipline as audit-log.ts / access-review.ts.
 */

import { buildAccessReview, type AccessReview, type BuildAccessReviewOptions } from './access-review.js';
import { AUDIT_ACTIONS, type AuditAction, type AuditEvent } from './audit-log.js';
import type { MemberView } from './invites.js';

/** Coverage summary of the privileged-action trail over the evidence period. */
export interface AuditCoverage {
  /** Every privileged-action verb the system commits to recording. */
  trackedActions: readonly AuditAction[];
  /** Events observed in the period, per verb (only verbs with ≥1 event). */
  byAction: Record<string, number>;
  /** Tracked verbs with ZERO events in the period — expected for a quiet quarter,
   *  but surfaced so an assessor can confirm coverage vs. simply "no activity". */
  actionsWithNoActivity: AuditAction[];
  totalEvents: number;
  earliestEventAt: string | null;
  latestEventAt: string | null;
}

export interface EvidenceReport {
  reportType: 'soc2-evidence';
  tenantId: string;
  generatedAt: string;
  period: { since: string | null; until: string | null };
  accessReview: AccessReview;
  auditCoverage: AuditCoverage;
  /** The raw events backing the coverage summary (newest-first as supplied). */
  auditEvents: AuditEvent[];
}

export interface BuildEvidenceReportInput {
  tenantId: string;
  members: MemberView[];
  /** Tenant-scoped, period-filtered audit events (the route supplies these). */
  events: AuditEvent[];
  /** Period bounds echoed into the report for the assessor's records. */
  since?: string;
  until?: string;
  now?: string;
  staleAfterDays?: number;
}

function summariseCoverage(events: AuditEvent[]): AuditCoverage {
  const byAction: Record<string, number> = {};
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const e of events) {
    byAction[e.action] = (byAction[e.action] ?? 0) + 1;
    if (earliest === null || e.createdAt < earliest) earliest = e.createdAt;
    if (latest === null || e.createdAt > latest) latest = e.createdAt;
  }
  const actionsWithNoActivity = AUDIT_ACTIONS.filter((a) => !byAction[a]);
  return {
    trackedActions: AUDIT_ACTIONS,
    byAction,
    actionsWithNoActivity,
    totalEvents: events.length,
    earliestEventAt: earliest,
    latestEventAt: latest,
  };
}

/**
 * Assemble the SOC2 evidence bundle. Pure: same inputs → same output. The
 * caller is responsible for tenant-scoping `members` and `events` (both are
 * already tenant-filtered by the route's gateway calls).
 */
export function buildEvidenceReport(input: BuildEvidenceReportInput): EvidenceReport {
  const generatedAt = input.now || new Date().toISOString();
  const reviewOpts: BuildAccessReviewOptions = { now: generatedAt };
  if (input.staleAfterDays !== undefined) reviewOpts.staleAfterDays = input.staleAfterDays;

  return {
    reportType: 'soc2-evidence',
    tenantId: input.tenantId,
    generatedAt,
    period: { since: input.since ?? null, until: input.until ?? null },
    accessReview: buildAccessReview(input.tenantId, input.members, reviewOpts),
    auditCoverage: summariseCoverage(input.events),
    auditEvents: input.events,
  };
}

/** JSON download envelope for the evidence report REST route. */
export function evidenceReportToDownload(report: EvidenceReport): {
  body: string;
  contentType: string;
  filename: string;
} {
  const stamp = (report.period.until || report.generatedAt).slice(0, 10);
  return {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json; charset=utf-8',
    filename: `soc2-evidence-${report.tenantId}-${stamp}.json`,
  };
}
