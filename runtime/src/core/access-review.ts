/**
 * access-review.ts — the periodic (quarterly) SOC2 access review (ADR-013 §5).
 *
 * SOC2 CC6.1–CC6.3 requires an organisation to periodically re-certify WHO has
 * access, at WHAT privilege, and to revoke access that is no longer warranted.
 * This module is that certification's data surface: a pure projection over the
 * tenant's member list (the `MemberView[]` `listMembers` already returns) that
 * ranks members by privilege, computes recency-of-activity, and flags the rows
 * an approver must act on — stale (inactive past a threshold) and never-active
 * accounts, weighted toward privileged roles.
 *
 * Pure + dependency-light (no Mongo, no gateway, no clock coupling — `now` is
 * injected): the SAME hermetic discipline as audit-log.ts, so it unit-tests
 * without infrastructure. The REST route passes in the member list + a `now`.
 */

import type { MemberView } from './invites.js';
import type { CtxRole } from './tenant-context.js';

/** Roles that hold elevated (privileged) access — the focus of a review. */
const PRIVILEGED_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

/** Rank for review ordering — most-privileged first. */
const ROLE_RANK: Record<string, number> = { owner: 0, admin: 1, member: 2, viewer: 3 };

/** Default inactivity window after which an account is flagged stale (one quarter). */
export const DEFAULT_STALE_AFTER_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/** One certified member row in an access review. */
export interface AccessReviewRow {
  userId: string;
  email: string;
  displayName?: string;
  role: string;
  /** ISO-8601 of last login, or null if the member has never logged in. */
  lastActiveAt: string | null;
  /** Whole days since last activity; null when never active. */
  daysSinceActive: number | null;
  /** True when the member has never logged in. */
  neverActive: boolean;
  /** True for owner/admin — elevated access an approver scrutinises harder. */
  privileged: boolean;
  /** True when never-active OR inactive beyond the staleness window. */
  stale: boolean;
}

export interface AccessReviewSummary {
  totalMembers: number;
  byRole: Record<string, number>;
  privilegedCount: number;
  staleCount: number;
  neverActiveCount: number;
  /** Privileged accounts that are ALSO stale — the highest-risk rows. */
  stalePrivilegedCount: number;
}

export interface AccessReview {
  tenantId: string;
  generatedAt: string;
  staleAfterDays: number;
  summary: AccessReviewSummary;
  members: AccessReviewRow[];
}

export interface BuildAccessReviewOptions {
  /** ISO timestamp treated as "now" (injected for hermetic tests). */
  now?: string;
  /** Inactivity window in days before a member is flagged stale. */
  staleAfterDays?: number;
}

function toIso(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  return Number.isNaN(t) ? null : d.toISOString();
}

/**
 * Build the access-review snapshot for a tenant. Members are ranked
 * most-privileged first, then most-stale first within a role — so the rows an
 * approver most likely revokes surface at the top. Pure: same inputs → same
 * output.
 */
export function buildAccessReview(
  tenantId: string,
  members: MemberView[],
  opts: BuildAccessReviewOptions = {},
): AccessReview {
  const staleAfterDays = opts.staleAfterDays && opts.staleAfterDays > 0 ? Math.trunc(opts.staleAfterDays) : DEFAULT_STALE_AFTER_DAYS;
  const generatedAt = opts.now || new Date().toISOString();
  const nowMs = new Date(generatedAt).getTime();

  const rows: AccessReviewRow[] = (members || []).map((m) => {
    const lastActiveAt = toIso(m.lastLoginAt);
    const neverActive = lastActiveAt === null;
    const daysSinceActive = neverActive
      ? null
      : Math.max(0, Math.floor((nowMs - new Date(lastActiveAt as string).getTime()) / MS_PER_DAY));
    const stale = neverActive || (daysSinceActive !== null && daysSinceActive > staleAfterDays);
    return {
      userId: m.userId,
      email: m.email,
      ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
      role: m.role,
      lastActiveAt,
      daysSinceActive,
      neverActive,
      privileged: PRIVILEGED_ROLES.has(m.role),
      stale,
    };
  });

  rows.sort((a, b) => {
    const rank = (ROLE_RANK[a.role] ?? 99) - (ROLE_RANK[b.role] ?? 99);
    if (rank !== 0) return rank;
    // Within a role: never-active first, then longest-inactive first.
    const da = a.daysSinceActive === null ? Number.POSITIVE_INFINITY : a.daysSinceActive;
    const db = b.daysSinceActive === null ? Number.POSITIVE_INFINITY : b.daysSinceActive;
    if (db !== da) return db - da;
    return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
  });

  const byRole: Record<string, number> = {};
  for (const r of rows) byRole[r.role] = (byRole[r.role] ?? 0) + 1;

  const summary: AccessReviewSummary = {
    totalMembers: rows.length,
    byRole,
    privilegedCount: rows.filter((r) => r.privileged).length,
    staleCount: rows.filter((r) => r.stale).length,
    neverActiveCount: rows.filter((r) => r.neverActive).length,
    stalePrivilegedCount: rows.filter((r) => r.privileged && r.stale).length,
  };

  return { tenantId, generatedAt, staleAfterDays, summary, members: rows };
}

/** CSV export of an access review for the auditor's evidence binder. */
const REVIEW_CSV_COLUMNS = [
  'email',
  'userId',
  'role',
  'privileged',
  'lastActiveAt',
  'daysSinceActive',
  'neverActive',
  'stale',
] as const;

function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function accessReviewToCsv(review: AccessReview): string {
  const lines = [
    REVIEW_CSV_COLUMNS.join(','),
    ...review.members.map((r) =>
      [r.email, r.userId, r.role, r.privileged, r.lastActiveAt ?? '', r.daysSinceActive ?? '', r.neverActive, r.stale]
        .map(csvCell)
        .join(','),
    ),
  ];
  return `${lines.join('\n')}\n`;
}

/** Role a review row belongs to — exported for callers that need the rank order. */
export type AccessReviewRole = Extract<CtxRole, 'owner' | 'admin' | 'member' | 'viewer'>;
