/**
 * Team-tier tenant invites (M2 gap close).
 *
 * An owner/admin generates an invite locked to an email address; the invitee's
 * signup presents the raw token and joins the inviter's tenant with the
 * invite's role (default `member`) — no new tenant, no new API key. Tokens are
 * CSPRNG, shown once, and only their sha256 is stored (same posture as the
 * per-tenant API keys in auth.ts). Invites expire (default 7 days) and can be
 * revoked; each is single-use.
 */
import crypto from 'node:crypto';
import { InviteModel, TenantModel, UserModel, type IInvite, type ITenant, type IUser, type UserRole } from '../shared/db.js';
import { AuthError } from './tenant-context.js';
import { createChildLogger } from '../shared/logger.js';
import { recordAuditEvent } from './audit-log.js';
import { checkEntitlement, EntitlementError } from './entitlements.js';

const log = createChildLogger({ module: 'invites' });

const INVITE_EXPIRES_DAYS = Number(process.env.INVITE_EXPIRES_DAYS) || 7;

/** Roles an invite may grant. Ownership is never transferable by invite. */
const INVITABLE_ROLES: ReadonlySet<UserRole> = new Set(['admin', 'member', 'viewer']);

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Public (non-secret) projection of an invite. */
export interface InviteView {
  inviteId: string;
  tenantId: string;
  email: string;
  role: UserRole;
  status: IInvite['status'];
  invitedBy: string;
  expiresAt: Date;
  createdAt?: Date;
  acceptedAt?: Date;
}

function toView(inv: IInvite): InviteView {
  return {
    inviteId: inv.inviteId,
    tenantId: inv.tenantId,
    email: inv.email,
    role: inv.role,
    status: inv.status,
    invitedBy: inv.invitedBy,
    expiresAt: inv.expiresAt,
    createdAt: inv.createdAt,
    acceptedAt: inv.acceptedAt,
  };
}

// ── Create ──

export interface CreateInviteInput {
  tenantId: string;
  invitedBy: string;        // userId of the inviter (already role-checked by the route)
  inviterRole: UserRole;
  email: string;
  role?: UserRole;
  expiresInDays?: number;
}

export interface CreateInviteResult {
  invite: InviteView;
  /** Show-once raw token — travels out-of-band as the invite link. */
  token: string;
}

export async function createInvite(input: CreateInviteInput): Promise<CreateInviteResult> {
  if (input.inviterRole !== 'owner' && input.inviterRole !== 'admin') {
    throw new AuthError('only an owner or admin can invite members', 403, 'FORBIDDEN');
  }
  const email = input.email?.toLowerCase().trim();
  if (!email || !email.includes('@')) throw new AuthError('invalid email', 400, 'BAD_REQUEST');

  const role = (input.role ?? 'member') as UserRole;
  if (!INVITABLE_ROLES.has(role)) {
    throw new AuthError(`role must be one of: admin, member, viewer`, 400, 'BAD_REQUEST');
  }

  const existingMember = await UserModel.findOne({ email, tenantId: input.tenantId }).lean<IUser>();
  if (existingMember) {
    throw new AuthError('that email is already a member of this tenant', 409, 'CONFLICT');
  }

  // Plan-tier seat cap (hard cap — blocks the invite before it can ever be
  // accepted, not just at acceptance time). Local/default tenant lookups that
  // miss (shouldn't happen for a real tenantId) fall back to 'free' so an
  // unresolved plan fails CLOSED rather than silently granting scale limits.
  const tenant = await TenantModel.findOne({ tenantId: input.tenantId }).lean<ITenant>();
  // Pending, unexpired invites for OTHER addresses each RESERVE a seat. Count
  // them alongside the +1 for this invite, otherwise N invites issued before any
  // is accepted all see only the materialized member count and every one passes
  // — the seat cap is then bypassed at acceptance. This email's own pending
  // invite is superseded just below, so exclude it to avoid over-counting.
  const pendingReserved = await InviteModel.countDocuments({
    tenantId: input.tenantId,
    status: 'pending',
    email: { $ne: email },
    expiresAt: { $gt: new Date() },
  });
  const verdict = await checkEntitlement('seats', input.tenantId, tenant?.plan ?? 'free', { extra: 1 + pendingReserved });
  if (!verdict.allowed) {
    throw new EntitlementError(verdict);
  }

  // Re-inviting an address supersedes the previous pending invite (its token dies).
  await InviteModel.updateMany(
    { tenantId: input.tenantId, email, status: 'pending' },
    { $set: { status: 'revoked' } },
  );

  const token = `myai_inv_${crypto.randomBytes(24).toString('base64url')}`;
  const days = input.expiresInDays && input.expiresInDays > 0
    ? Math.min(input.expiresInDays, 90)
    : INVITE_EXPIRES_DAYS;

  const invite = await InviteModel.create({
    inviteId: `inv_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    tenantId: input.tenantId,
    email,
    role,
    tokenHash: sha256Hex(token),
    invitedBy: input.invitedBy,
    status: 'pending',
    expiresAt: new Date(Date.now() + days * 86_400_000),
  });

  log.info({ tenantId: input.tenantId, email, role, inviteId: invite.inviteId }, 'invite created');
  // Append-only audit trail (ADR-013 §5) — privileged access-grant action.
  recordAuditEvent({
    tenantId: input.tenantId,
    actor: { userId: input.invitedBy, role: input.inviterRole, via: 'jwt' },
    action: 'invite.create',
    target: email,
    detail: { role, inviteId: invite.inviteId },
  });
  return { invite: toView(invite as IInvite), token };
}

// ── List / revoke (tenant-scoped) ──

export async function listInvites(tenantId: string): Promise<InviteView[]> {
  const invites = await InviteModel.find({ tenantId }).sort({ createdAt: -1 }).limit(100).lean<IInvite[]>();
  return invites.map(toView);
}

/** Who performed the revoke — threaded through for the audit trail. */
export interface RevokeActor {
  userId?: string;
  role: UserRole;
}

export async function revokeInvite(tenantId: string, inviteId: string, actor?: RevokeActor): Promise<InviteView> {
  const invite = await InviteModel.findOne({ tenantId, inviteId });
  if (!invite) throw new AuthError('invite not found', 404, 'NOT_FOUND');
  if (invite.status === 'accepted') {
    throw new AuthError('invite already accepted — remove the member instead', 409, 'CONFLICT');
  }
  invite.status = 'revoked';
  await invite.save();
  log.info({ tenantId, inviteId }, 'invite revoked');
  // Append-only audit trail (ADR-013 §5) — privileged access-grant reversal.
  recordAuditEvent({
    tenantId,
    actor: { userId: actor?.userId, role: actor?.role ?? 'admin', via: 'jwt' },
    action: 'invite.revoke',
    target: invite.email,
    detail: { inviteId },
  });
  return toView(invite);
}

// ── Lookup (public — powers the signup page's join banner) ──

export interface InviteLookup {
  valid: boolean;
  reason?: string;
  tenantName?: string;
  email?: string;
  role?: UserRole;
  expiresAt?: Date;
}

export async function lookupInvite(token: string): Promise<InviteLookup> {
  const invite = await InviteModel.findOne({ tokenHash: sha256Hex(token) }).lean<IInvite>();
  if (!invite) return { valid: false, reason: 'invite not found' };
  if (invite.status === 'revoked') return { valid: false, reason: 'invite was revoked' };
  if (invite.status === 'accepted') return { valid: false, reason: 'invite already used' };
  if (invite.expiresAt.getTime() < Date.now()) return { valid: false, reason: 'invite expired' };

  const tenant = await TenantModel.findOne({ tenantId: invite.tenantId }).lean();
  return {
    valid: true,
    tenantName: tenant?.name,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt,
  };
}

// ── Redeem (called by signup) ──

/**
 * Validate a raw token for redemption by `email`. Throws AuthError on any
 * mismatch; returns the pending invite. The caller creates the user and then
 * finalizes with `markInviteAccepted` — split so a failed user-create never
 * burns the invite.
 */
export async function redeemInvite(token: string, email: string): Promise<IInvite> {
  const invite = await InviteModel.findOne({ tokenHash: sha256Hex(token) });
  if (!invite) throw new AuthError('invalid invite', 400, 'BAD_REQUEST');
  if (invite.status !== 'pending') throw new AuthError('invite is no longer valid', 400, 'BAD_REQUEST');
  if (invite.expiresAt.getTime() < Date.now()) throw new AuthError('invite expired', 400, 'BAD_REQUEST');
  if (invite.email !== email.toLowerCase().trim()) {
    throw new AuthError('invite was issued to a different email address', 403, 'FORBIDDEN');
  }
  return invite;
}

export async function markInviteAccepted(inviteId: string, userId: string): Promise<void> {
  await InviteModel.updateOne(
    { inviteId, status: 'pending' },
    { $set: { status: 'accepted', acceptedBy: userId, acceptedAt: new Date() } },
  );
}

// ── Members (tenant switcher) ──

export interface MemberView {
  userId: string;
  email: string;
  displayName?: string;
  role: UserRole;
  lastLoginAt?: Date;
  createdAt?: Date;
}

export async function listMembers(tenantId: string): Promise<MemberView[]> {
  const users = await UserModel.find({ tenantId }).sort({ createdAt: 1 }).limit(200).lean<IUser[]>();
  return users.map(memberView);
}

function memberView(
  u: Pick<IUser, 'userId' | 'email' | 'displayName' | 'role' | 'lastLoginAt' | 'createdAt'>,
): MemberView {
  return {
    userId: u.userId,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}

// ── Change member role (ADR-013 §4 — RBAC v1 slice 3) ──
//
// The single write path behind `PATCH`/`POST /api/auth/members/role`. All the
// spec rules live here (not just in the UI) — the server-side matrix is the
// real boundary; UI gating is only UX (ADR-013 §4).
//
// Rules:
//   - actor must hold the `members` capability → owner or admin (route also
//     gates; enforced here too for defense in depth);
//   - `owner` is never an assignable target role — ownership is non-transferable
//     in v1, so this route can never MINT or REMOVE an owner. That structurally
//     guarantees the ADR's "last-owner protection": the owner count is fixed at
//     the signup owner and can't be demoted away;
//   - an `admin` cannot grant `admin` (or higher) — only an `owner` may promote
//     to admin;
//   - the `owner`'s own role can never be changed.

/** Roles a member may be reassigned TO. `owner` is intentionally excluded. */
const ASSIGNABLE_ROLES: ReadonlySet<UserRole> = new Set(['admin', 'member', 'viewer']);

export interface ChangeMemberRoleInput {
  tenantId: string;
  actorUserId: string;      // the caller (from the verified JWT)
  actorRole: UserRole;
  targetUserId: string;
  newRole: UserRole;
}

export async function changeMemberRole(input: ChangeMemberRoleInput): Promise<MemberView> {
  if (input.actorRole !== 'owner' && input.actorRole !== 'admin') {
    throw new AuthError('only an owner or admin can change member roles', 403, 'FORBIDDEN');
  }
  if (!ASSIGNABLE_ROLES.has(input.newRole)) {
    throw new AuthError('role must be one of: admin, member, viewer', 400, 'BAD_REQUEST');
  }
  // Admin may grant member/viewer but not admin+ — only an owner promotes to admin.
  if (input.actorRole === 'admin' && input.newRole === 'admin') {
    throw new AuthError('only an owner can grant the admin role', 403, 'FORBIDDEN');
  }

  const target = await UserModel.findOne({
    userId: input.targetUserId,
    tenantId: input.tenantId,
  }).lean<IUser>();
  if (!target) throw new AuthError('member not found', 404, 'NOT_FOUND');

  // Never touch an owner — non-transferable ownership + last-owner protection.
  if (target.role === 'owner') {
    throw new AuthError("the owner's role cannot be changed", 409, 'CONFLICT');
  }

  // No-op: already at the requested role — return the current view unchanged.
  if (target.role === input.newRole) return memberView(target);

  await UserModel.updateOne(
    { userId: input.targetUserId, tenantId: input.tenantId },
    { $set: { role: input.newRole } },
  );

  log.info(
    { tenantId: input.tenantId, actor: input.actorUserId, target: input.targetUserId, from: target.role, to: input.newRole },
    'member role changed',
  );
  // Append-only audit trail (ADR-013 §5) — best-effort, never blocks the write.
  recordAuditEvent({
    tenantId: input.tenantId,
    actor: { userId: input.actorUserId, role: input.actorRole, via: 'jwt' },
    action: 'role.change',
    target: input.targetUserId,
    detail: { from: target.role, to: input.newRole },
  });
  return memberView({ ...target, role: input.newRole });
}
