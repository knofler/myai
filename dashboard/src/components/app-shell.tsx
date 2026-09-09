'use client';

// AppShell — decides the page chrome based on the route.
//
// Operator routes get the "Mission Control" shell (AppShellV2): grouped left
// rail, top bar (breadcrumb, tenant switcher, ⌘K, theme toggle, brain badge)
// and a mobile bottom tab bar. Public marketing / legal / trust routes render
// full-bleed with no operator chrome — they are for logged-out prospects and
// procurement, not the operator, so the sidebar, notification bell and command
// palette never mount there. Keeping this decision in one client component means
// the root layout (a server component) stays untouched and no pages need to move
// into route groups.

import { usePathname } from 'next/navigation';
import { AppShellV2 } from '@/components/shell/app-shell-v2';
import { ProductTour } from '@/components/product-tour';

// DASHBOARD_REDESIGN_2026-09 B6: the "Mission Control" shell is now the only
// shell — the NEXT_PUBLIC_UI_V2 flag and the legacy chrome it gated are gone.

// Routes that render WITHOUT the operator chrome (public marketing / legal /
// trust). These leave the app shell per the redesign brief §"Information
// architecture" — they are static, unauthenticated surfaces. Every entry is
// also an OPERATOR_PUBLIC path in src/middleware.ts, so an anonymous visitor
// never sees operator chrome (and its authenticated-only polling).
const FULL_BLEED = [
  '/welcome',
  '/recap',
  '/demo',
  '/showcase',
  '/proof',
  '/pricing',
  '/developers',
  // Trust + compliance pack — procurement reads these pre-signature.
  '/privacy',
  '/terms',
  '/acceptable-use',
  '/security',
  '/dpa',
  '/subprocessors',
];

function isFullBleed(pathname: string): boolean {
  return FULL_BLEED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (isFullBleed(pathname)) {
    return <main className="flex-1 min-w-0 overflow-x-hidden overflow-y-auto">{children}</main>;
  }

  // ProductTour mounts on the operator chrome path only — it walks the Mission
  // Control surfaces, so it must not appear on the full-bleed public routes.
  // B6 dropped this wiring along with the legacy shell; re-attached here.
  return (
    <>
      <AppShellV2>{children}</AppShellV2>
      <ProductTour />
    </>
  );
}
