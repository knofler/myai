'use client';

// Data-residency region picker (ADR-024 Phase 2b) — shared by every signup
// surface that provisions a fresh tenant (landing card, /welcome/start,
// /login signup tab). Defaults to 'us'. The pin is set once at provisioning
// and enforced at the gateway (core/region-guard.ts); there is no self-serve
// region change afterward (support-assisted, see ResidencyBadge / lib/residency.ts)
// — the copy here says so up front rather than letting a tenant assume it's
// changeable later.
import { TENANT_REGIONS, regionName, type TenantRegion } from '@/lib/residency';

const inputCls =
  'w-full px-3 py-2 rounded-lg bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] text-sm text-[rgb(var(--text-primary))] focus:border-teal-600 outline-none transition-colors';

export function RegionSelect({
  value,
  onChange,
}: {
  value: TenantRegion;
  onChange: (region: TenantRegion) => void;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-[rgb(var(--text-muted))] mb-1">Data region</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as TenantRegion)}
        className={inputCls}
      >
        {TENANT_REGIONS.map((r) => (
          <option key={r} value={r}>
            {regionName(r)}
          </option>
        ))}
      </select>
      <span className="block text-label text-[rgb(var(--text-muted))] mt-1 leading-relaxed">
        Where your data and off-hours runner work are pinned and enforced at the gateway. Changing it later is a
        support-assisted move, not self-serve — pick carefully.
      </span>
    </label>
  );
}
