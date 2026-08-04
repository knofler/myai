'use client';

// Admin-only panel: view/edit a tenant's per-org MCP tool visibility override
// (core/rbac.ts OPERATOR_ONLY_TOOLS / ITenant.mcpToolAllowlist/mcpToolDenylist).
// Reads/writes go through /api/tenants/[id]/mcp-tools, which proxies to the
// gateway's admin-gated REST route — this panel never talks to Mongo directly.

import { useState } from 'react';

const inputCls =
  'px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-100 placeholder-zinc-600 focus:border-teal-600 outline-none transition-colors';

interface TenantOption {
  tenantId: string;
  name?: string;
  plan?: string;
}

interface McpToolsView {
  tenantId: string;
  mcpToolAllowlist: string[];
  mcpToolDenylist: string[];
  operatorOnlyTools: string[];
}

function parseList(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

export default function TenantMcpToolsPanel({ tenants }: { tenants: TenantOption[] }) {
  const [tenantId, setTenantId] = useState('');
  const [view, setView] = useState<McpToolsView | null>(null);
  const [allowText, setAllowText] = useState('');
  const [denyText, setDenyText] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadTenant(id: string) {
    setTenantId(id);
    setView(null);
    setSaved(false);
    setError(null);
    if (!id) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/tenants/${encodeURIComponent(id)}/mcp-tools`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
      setView(body);
      setAllowText((body.mcpToolAllowlist ?? []).join(', '));
      setDenyText((body.mcpToolDenylist ?? []).join(', '));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }

  function toggleAllow(tool: string, checked: boolean) {
    const current = new Set(parseList(allowText));
    if (checked) current.add(tool);
    else current.delete(tool);
    setAllowText(Array.from(current).join(', '));
    setSaved(false);
  }

  async function save() {
    if (!tenantId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/mcp-tools`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mcpToolAllowlist: parseList(allowText),
          mcpToolDenylist: parseList(denyText),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `save failed (${res.status})`);
      setView(body);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }

  const allowSet = new Set(parseList(allowText));

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 max-w-2xl">
      <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-2">Tenant</label>
      <select
        className={`${inputCls} w-full mb-4`}
        value={tenantId}
        onChange={(e) => loadTenant(e.target.value)}
      >
        <option value="">— select a tenant —</option>
        {tenants.map((t) => (
          <option key={t.tenantId} value={t.tenantId}>
            {t.name ? `${t.name} (${t.tenantId})` : t.tenantId}
            {t.plan ? ` · ${t.plan}` : ''}
          </option>
        ))}
      </select>

      {loading && <p className="text-xs text-zinc-500">Loading…</p>}

      {error && (
        <div className="mb-4 bg-red-950/30 border border-red-800/50 rounded-lg p-3 text-xs text-red-300">
          {error}
          {error.includes('ADMIN_DISABLED') || error.toLowerCase().includes('admin_disabled') ? (
            <> — set <code className="bg-zinc-800 px-1 rounded">ADMIN_API_TOKEN</code> on the dashboard and gateway to enable this panel.</>
          ) : null}
        </div>
      )}

      {view && (
        <>
          {view.operatorOnlyTools.length > 0 && (
            <div className="mb-4">
              <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-2">
                Operator-only tools — check to allow for this tenant
              </label>
              <div className="grid grid-cols-2 gap-1.5 max-h-56 overflow-y-auto pr-1">
                {view.operatorOnlyTools.map((tool) => (
                  <label key={tool} className="flex items-center gap-2 text-xs text-zinc-300 font-mono">
                    <input
                      type="checkbox"
                      checked={allowSet.has(tool)}
                      onChange={(e) => toggleAllow(tool, e.target.checked)}
                      className="accent-teal-600"
                    />
                    {tool}
                  </label>
                ))}
              </div>
            </div>
          )}

          <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-2">
            Allowlist (comma-separated tool names)
          </label>
          <input
            className={`${inputCls} w-full mb-4`}
            value={allowText}
            onChange={(e) => { setAllowText(e.target.value); setSaved(false); }}
            placeholder="fleet_run_start, brain_host_provision"
          />

          <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-2">
            Denylist (comma-separated tool names — additionally hides an otherwise-visible tool)
          </label>
          <input
            className={`${inputCls} w-full mb-4`}
            value={denyText}
            onChange={(e) => { setDenyText(e.target.value); setSaved(false); }}
            placeholder="tasks_create"
          />

          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving}
              className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-sm font-medium text-white transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {saved && <span className="text-xs text-emerald-400">Saved.</span>}
          </div>
        </>
      )}
    </div>
  );
}
