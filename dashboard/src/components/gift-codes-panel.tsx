'use client';

// Admin-only panel: mint/list/revoke platform-wide gift/redeemable
// subscription codes (core/gift-codes.ts). Reads/writes go through
// /api/gift-codes and /api/gift-codes/revoke, which proxy to the gateway's
// admin-gated REST routes — this panel never talks to Mongo directly.

import { useCallback, useEffect, useState } from 'react';

const inputCls =
  'px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-100 placeholder-zinc-600 focus:border-teal-600 outline-none transition-colors';

type GrantType = 'plan_months' | 'credits';
type GrantPlan = 'solo' | 'team' | 'scale';
type GiftCodeStatus = 'active' | 'disabled' | 'exhausted' | 'expired';

interface GiftCodeView {
  codeId: string;
  code: string;
  grantType: GrantType;
  grantPlan?: GrantPlan;
  grantMonths?: number;
  grantCredits?: number;
  maxRedemptions: number;
  redemptionCount: number;
  status: GiftCodeStatus;
  note?: string;
  createdBy: string;
  expiresAt?: string;
  createdAt?: string;
}

const STATUS_FILTERS: Array<{ id: GiftCodeStatus | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'exhausted', label: 'Redeemed' },
  { id: 'disabled', label: 'Revoked' },
  { id: 'expired', label: 'Expired' },
];

function statusBadgeCls(status: GiftCodeStatus): string {
  switch (status) {
    case 'active': return 'bg-emerald-500/10 text-emerald-400';
    case 'exhausted': return 'bg-teal-500/10 text-teal-400';
    case 'disabled': return 'bg-red-500/10 text-red-400';
    case 'expired': return 'bg-zinc-800 text-zinc-500';
    default: return 'bg-zinc-800 text-zinc-500';
  }
}

function grantSummary(c: Pick<GiftCodeView, 'grantType' | 'grantPlan' | 'grantMonths' | 'grantCredits'>): string {
  if (c.grantType === 'plan_months') return `${c.grantPlan ?? '?'} × ${c.grantMonths ?? '?'}mo`;
  return `${c.grantCredits ?? '?'} credits`;
}

export default function GiftCodesPanel() {
  const [codes, setCodes] = useState<GiftCodeView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<GiftCodeStatus | 'all'>('all');
  const [search, setSearch] = useState('');

  const [grantType, setGrantType] = useState<GrantType>('plan_months');
  const [grantPlan, setGrantPlan] = useState<GrantPlan>('solo');
  const [grantMonths, setGrantMonths] = useState('1');
  const [grantCredits, setGrantCredits] = useState('100');
  const [maxRedemptions, setMaxRedemptions] = useState('1');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [note, setNote] = useState('');
  const [customCode, setCustomCode] = useState('');
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [minted, setMinted] = useState<GiftCodeView | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/gift-codes', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
      setCodes(body.codes ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function mint(e: React.FormEvent) {
    e.preventDefault();
    setMinting(true);
    setMintError(null);
    setMinted(null);
    try {
      const res = await fetch('/api/gift-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grantType,
          grantPlan: grantType === 'plan_months' ? grantPlan : undefined,
          grantMonths: grantType === 'plan_months' ? Number(grantMonths) : undefined,
          grantCredits: grantType === 'credits' ? Number(grantCredits) : undefined,
          maxRedemptions: maxRedemptions ? Number(maxRedemptions) : undefined,
          expiresInDays: expiresInDays ? Number(expiresInDays) : undefined,
          note: note || undefined,
          code: customCode || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `mint failed (${res.status})`);
      setMinted(body);
      setNote('');
      setCustomCode('');
      await load();
    } catch (err) {
      setMintError(err instanceof Error ? err.message : 'mint failed');
    } finally {
      setMinting(false);
    }
  }

  async function revoke(codeId: string) {
    setRevokingId(codeId);
    try {
      const res = await fetch('/api/gift-codes/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codeId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `revoke failed (${res.status})`);
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'revoke failed');
    } finally {
      setRevokingId(null);
    }
  }

  const filtered = codes.filter((c) => {
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    if (search && !c.code.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="max-w-4xl space-y-6">
      <form onSubmit={mint} className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
        <h3 className="text-sm font-semibold text-zinc-200 mb-4">Mint a gift code</h3>

        {mintError && (
          <div className="mb-4 bg-red-950/30 border border-red-800/50 rounded-lg p-3 text-xs text-red-300">
            {mintError}
            {mintError.toLowerCase().includes('admin_disabled') ? (
              <> — set <code className="bg-zinc-800 px-1 rounded">ADMIN_API_TOKEN</code> on the dashboard and gateway to enable this panel.</>
            ) : null}
          </div>
        )}

        {minted && (
          <div className="mb-4 bg-emerald-950/30 border border-emerald-800/50 rounded-lg p-3 text-xs text-emerald-300">
            Minted <span className="font-mono">{minted.code}</span> ({grantSummary(minted)})
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-2">Grant type</label>
            <select
              className={`${inputCls} w-full`}
              value={grantType}
              onChange={(e) => setGrantType(e.target.value as GrantType)}
            >
              <option value="plan_months">Plan months</option>
              <option value="credits">Credits</option>
            </select>
          </div>

          {grantType === 'plan_months' ? (
            <>
              <div>
                <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-2">Plan</label>
                <select
                  className={`${inputCls} w-full`}
                  value={grantPlan}
                  onChange={(e) => setGrantPlan(e.target.value as GrantPlan)}
                >
                  <option value="solo">Solo</option>
                  <option value="team">Team</option>
                  <option value="scale">Scale</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-2">Months</label>
                <input
                  type="number"
                  min={1}
                  className={`${inputCls} w-full`}
                  value={grantMonths}
                  onChange={(e) => setGrantMonths(e.target.value)}
                  required
                />
              </div>
            </>
          ) : (
            <div>
              <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-2">Credits</label>
              <input
                type="number"
                min={1}
                className={`${inputCls} w-full`}
                value={grantCredits}
                onChange={(e) => setGrantCredits(e.target.value)}
                required
              />
            </div>
          )}

          <div>
            <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-2">Max redemptions</label>
            <input
              type="number"
              min={1}
              className={`${inputCls} w-full`}
              value={maxRedemptions}
              onChange={(e) => setMaxRedemptions(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-2">Expires in (days, optional)</label>
            <input
              type="number"
              min={1}
              className={`${inputCls} w-full`}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              placeholder="never"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-2">Custom code (optional)</label>
            <input
              className={`${inputCls} w-full font-mono`}
              value={customCode}
              onChange={(e) => setCustomCode(e.target.value)}
              placeholder="DESIGNPARTNER2026"
            />
          </div>
        </div>

        <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-2">Note (optional)</label>
        <input
          className={`${inputCls} w-full mb-4`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Q3 partnership promo"
        />

        <button
          type="submit"
          disabled={minting}
          className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-sm font-medium text-white transition-colors"
        >
          {minting ? 'Minting…' : 'Mint code'}
        </button>
      </form>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-zinc-200">Gift codes</h3>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${inputCls} text-xs py-1.5`}
              placeholder="search code…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="flex gap-1">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setStatusFilter(f.id)}
                  className={`px-2.5 py-1 rounded text-xs transition-colors ${
                    statusFilter === f.id
                      ? 'bg-teal-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loadError && (
          <div className="p-3 text-xs text-red-300 bg-red-950/30 border-b border-red-800/50">
            {loadError}
          </div>
        )}

        {loading ? (
          <div className="p-6 text-center text-xs text-zinc-500">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-center text-xs text-zinc-500">No gift codes match.</div>
        ) : (
          <table className="card-table w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Grant</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Redemptions</th>
                <th className="px-4 py-3">Expires</th>
                <th className="px-4 py-3">Note</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {filtered.map((c) => (
                <tr key={c.codeId} className="hover:bg-zinc-800/30 transition-colors">
                  <td data-label="Code" className="px-4 py-2 font-mono text-zinc-200">{c.code}</td>
                  <td data-label="Grant" className="px-4 py-2 text-xs text-zinc-400">{grantSummary(c)}</td>
                  <td data-label="Status" className="px-4 py-2">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${statusBadgeCls(c.status)}`}>{c.status}</span>
                  </td>
                  <td data-label="Redemptions" className="px-4 py-2 text-right text-xs text-zinc-400 font-mono">
                    {c.redemptionCount} / {c.maxRedemptions}
                  </td>
                  <td data-label="Expires" className="px-4 py-2 text-xs text-zinc-500">
                    {c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : 'never'}
                  </td>
                  <td data-label="Note" className="px-4 py-2 text-xs text-zinc-500 truncate max-w-[160px]">{c.note ?? '-'}</td>
                  <td data-label="" className="px-4 py-2 text-right">
                    {c.status !== 'disabled' && (
                      <button
                        onClick={() => revoke(c.codeId)}
                        disabled={revokingId === c.codeId}
                        className="px-2.5 py-1 rounded text-xs bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-50 transition-colors"
                      >
                        {revokingId === c.codeId ? 'Revoking…' : 'Revoke'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
