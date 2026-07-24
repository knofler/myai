'use client';

// Tenant switcher (MVP M2) — lives in the sidebar footer. Shows the active
// tenant + plan, and a pop-up menu to switch between every signed-in tenant,
// add another account, or sign out. Signed out → a "Sign in" link to /login.
//
// Team tier: the menu also lists the tenant's MEMBERS (from the session JWT via
// /api/auth/members) and, for owners/admins, an "Invite teammate" flow that
// creates an email-locked, expiring invite and hands back a copyable
// /login?invite=<token> link. Sessions connected only by API key (no JWT
// cookie) get no members section — the fetch 401s and the section hides.

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useTenant } from '@/lib/tenant-context';

const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  solo: 'Solo',
  team: 'Team',
  scale: 'Scale',
};

interface Member {
  userId: string;
  email: string;
  displayName?: string;
  role: string;
}

// Roles an owner may assign to a member (owner is non-transferable — ADR-013 §4).
const ASSIGNABLE_ROLES = ['admin', 'member', 'viewer'] as const;

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?'
  );
}

export function TenantSwitcher() {
  const { current, tenants, switchTenant, logout, loading } = useTenant();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Members + invite state (Team tier). null members → JWT session absent /
  // not yet loaded → section hidden.
  const [members, setMembers] = useState<Member[] | null>(null);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  // Role-change UI (owner only): which member's role is mid-flight, and any
  // per-member error surfaced after an optimistic update was reverted.
  const [roleBusyId, setRoleBusyId] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<{ userId: string; msg: string } | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Load members + own role whenever the menu opens (JWT cookie rides along).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [membersRes, meRes] = await Promise.all([
          fetch('/api/auth/members'),
          fetch('/api/auth/me'),
        ]);
        if (cancelled) return;
        if (membersRes.ok) {
          const json = await membersRes.json();
          setMembers(Array.isArray(json.members) ? json.members : []);
        } else {
          setMembers(null); // no JWT session — hide the section
        }
        if (meRes.ok) {
          const me = await meRes.json();
          setMyRole(typeof me.role === 'string' ? me.role : null);
          setMyUserId(typeof me.userId === 'string' ? me.userId : null);
        }
      } catch {
        if (!cancelled) setMembers(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, current?.tenantId]);

  async function createInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteBusy(true);
    setInviteErr(null);
    try {
      const res = await fetch('/api/auth/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || 'invite failed');
      setInviteLink(`${window.location.origin}/login?invite=${encodeURIComponent(json.token)}`);
      setInviteEmail('');
    } catch (err) {
      setInviteErr(err instanceof Error ? err.message : 'invite failed');
    } finally {
      setInviteBusy(false);
    }
  }

  // Change a member's role. Optimistic: flip the local role immediately, then
  // revert + surface the error if the gateway rejects (last-owner protection,
  // admin-can't-grant-admin, etc. — the server matrix is the real boundary).
  async function changeRole(userId: string, nextRole: string) {
    if (!members) return;
    const prev = members.find((m) => m.userId === userId)?.role;
    if (prev === undefined || prev === nextRole) return;

    setRoleError(null);
    setRoleBusyId(userId);
    setMembers((ms) => ms?.map((m) => (m.userId === userId ? { ...m, role: nextRole } : m)) ?? ms);
    try {
      const res = await fetch('/api/auth/members', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, role: nextRole }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || 'role change failed');
      // Reconcile with the server's authoritative view.
      const serverRole = typeof json?.member?.role === 'string' ? json.member.role : nextRole;
      setMembers((ms) => ms?.map((m) => (m.userId === userId ? { ...m, role: serverRole } : m)) ?? ms);
    } catch (err) {
      setMembers((ms) => ms?.map((m) => (m.userId === userId ? { ...m, role: prev } : m)) ?? ms);
      setRoleError({ userId, msg: err instanceof Error ? err.message : 'role change failed' });
    } finally {
      setRoleBusyId(null);
    }
  }

  async function copyInviteLink() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      /* clipboard blocked — the link stays selectable */
    }
  }

  if (loading) return null;

  if (!current) {
    return (
      <Link
        href="/login"
        className="gel-surface flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg border border-zinc-800 text-sm text-teal-300 hover:text-teal-200 transition-colors"
      >
        <span className="text-xs">→</span> Sign in
      </Link>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="gel-surface flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg border border-zinc-800 text-left hover:border-zinc-700 transition-colors"
      >
        <span className="gel-brand flex items-center justify-center w-7 h-7 rounded-md text-[11px] font-bold text-teal-200 shrink-0">
          {initials(current.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-zinc-200 truncate">{current.name}</span>
          <span className="block text-[10px] text-zinc-500">{PLAN_LABEL[current.plan] ?? current.plan} plan</span>
        </span>
        <span className="text-zinc-600 text-[10px]">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 right-0 mb-2 gel-surface bg-zinc-900 border border-zinc-800 rounded-lg p-1.5 shadow-xl z-50"
        >
          {tenants.length > 1 && (
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-600">Switch tenant</div>
          )}
          {tenants.map((t) => {
            const active = t.tenantId === current.tenantId;
            return (
              <button
                key={t.tenantId}
                role="menuitem"
                onClick={() => {
                  switchTenant(t.tenantId);
                  setOpen(false);
                }}
                className={`flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md text-left text-xs transition-colors ${
                  active ? 'gel-brand text-teal-200' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                <span className="flex items-center justify-center w-5 h-5 rounded text-[9px] font-bold bg-zinc-800 text-zinc-300 shrink-0">
                  {initials(t.name)}
                </span>
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                {active && <span className="text-teal-300 text-[10px]">✓</span>}
              </button>
            );
          })}
          {/* ── Members (Team tier) — visible whenever a JWT session exists ── */}
          {members !== null && (
            <>
              <div className="my-1 border-t border-zinc-800" />
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-600">
                Members ({members.length})
              </div>
              <div className="max-h-40 overflow-y-auto">
                {members.map((m) => {
                  // Owner-only role control (ADR-013 §4). The owner row and my
                  // own row are never editable — ownership is non-transferable
                  // and you can't demote yourself out of the tenant.
                  const editable =
                    myRole === 'owner' && m.role !== 'owner' && m.userId !== myUserId;
                  const errored = roleError?.userId === m.userId;
                  return (
                    <div key={m.userId} className="px-2 py-1 text-xs">
                      <div className="flex items-center gap-2.5">
                        <span className="flex items-center justify-center w-5 h-5 rounded text-[9px] font-bold bg-zinc-800 text-zinc-300 shrink-0">
                          {initials(m.displayName || m.email)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-zinc-400">
                          {m.displayName || m.email}
                          {m.userId === myUserId && <span className="text-zinc-600"> (you)</span>}
                        </span>
                        {editable ? (
                          <select
                            aria-label={`Role for ${m.displayName || m.email}`}
                            value={m.role}
                            disabled={roleBusyId === m.userId}
                            onChange={(e) => changeRole(m.userId, e.target.value)}
                            className="bg-zinc-950 border border-zinc-800 rounded px-1 py-0.5 text-[9px] uppercase tracking-wide text-zinc-300 focus:border-teal-600 outline-none disabled:opacity-40 transition-colors"
                          >
                            {ASSIGNABLE_ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span
                            className={`text-[9px] uppercase tracking-wide ${
                              m.role === 'owner' ? 'text-teal-400' : 'text-zinc-600'
                            }`}
                          >
                            {m.role}
                          </span>
                        )}
                      </div>
                      {errored && <p className="mt-0.5 ml-7 text-[9px] text-rose-400">{roleError!.msg}</p>}
                    </div>
                  );
                })}
              </div>

              {(myRole === 'owner' || myRole === 'admin') && (
                <div className="px-2 py-1.5">
                  {!inviteOpen ? (
                    <button
                      onClick={() => {
                        setInviteOpen(true);
                        setInviteLink(null);
                        setInviteErr(null);
                      }}
                      className="text-xs text-teal-300 hover:text-teal-200 transition-colors"
                    >
                      ✉ Invite teammate…
                    </button>
                  ) : inviteLink ? (
                    <div className="space-y-1.5">
                      <p className="text-[10px] text-zinc-500">
                        Share this link — it expires and only works for the invited email:
                      </p>
                      <code className="block px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-[10px] text-teal-300 break-all select-all">
                        {inviteLink}
                      </code>
                      <div className="flex gap-2">
                        <button
                          onClick={copyInviteLink}
                          className="flex-1 px-2 py-1 rounded gel-brand text-[11px] text-teal-100 hover:brightness-110 transition"
                        >
                          {linkCopied ? '✓ Copied' : 'Copy link'}
                        </button>
                        <button
                          onClick={() => {
                            setInviteOpen(false);
                            setInviteLink(null);
                          }}
                          className="px-2 py-1 rounded text-[11px] text-zinc-500 hover:text-zinc-300 transition"
                        >
                          Done
                        </button>
                      </div>
                    </div>
                  ) : (
                    <form onSubmit={createInvite} className="space-y-1.5">
                      <input
                        type="email"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        placeholder="teammate@acme.com"
                        className="w-full px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-[11px] text-zinc-100 placeholder-zinc-600 focus:border-teal-600 outline-none transition-colors"
                        required
                      />
                      {inviteErr && <p className="text-[10px] text-rose-400">{inviteErr}</p>}
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={inviteBusy || !inviteEmail.trim()}
                          className="flex-1 px-2 py-1 rounded gel-brand text-[11px] text-teal-100 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
                        >
                          {inviteBusy ? 'Creating…' : 'Create invite link'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setInviteOpen(false)}
                          className="px-2 py-1 rounded text-[11px] text-zinc-500 hover:text-zinc-300 transition"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )}
            </>
          )}

          <div className="my-1 border-t border-zinc-800" />
          <Link
            href="/login"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <span className="w-5 text-center text-zinc-600">+</span> Add account
          </Link>
          <button
            role="menuitem"
            onClick={() => {
              logout(current.tenantId);
              setOpen(false);
            }}
            className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left text-xs text-rose-400/80 hover:text-rose-300 hover:bg-zinc-800 transition-colors"
          >
            <span className="w-5 text-center">⏻</span> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
