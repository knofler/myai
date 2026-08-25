// ResidencyBadge (ADR-024 Phase 2) — the tenant-visible data-residency
// surface. Display-only: the region tag is set at provisioning and enforced
// by the gateway's region-guard; there is no self-serve region change (moving
// live data between regions is a support-assisted operation). Server- and
// client-safe (pure JSX, no hooks).
import { asTenantRegion, regionLabel, residencyTitle, type TenantRegion } from '@/lib/residency';

const COLORS: Record<TenantRegion, string> = {
  us: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  eu: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  au: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
};

export function ResidencyBadge({ region }: { region: unknown }) {
  const r = asTenantRegion(region);
  return (
    <span
      title={residencyTitle(r)}
      aria-label={residencyTitle(r)}
      data-testid="residency-badge"
      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider ${COLORS[r]}`}
    >
      <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="currentColor" aria-hidden="true">
        <path d="M8 1a5 5 0 0 0-5 5c0 3.5 5 9 5 9s5-5.5 5-9a5 5 0 0 0-5-5Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z" />
      </svg>
      {regionLabel(r)} data
    </span>
  );
}
