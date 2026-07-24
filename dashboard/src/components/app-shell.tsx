'use client';

// AppShell — decides the page chrome based on the route.
//
// Dashboard routes get the sidebar Nav + ⌘K palette + the left-margined
// <main>. Public marketing routes (the /welcome landing page, MVP M6) render
// full-bleed with no sidebar — they are for logged-out prospects, not the
// operator. Keeping this decision in one client component means the root
// layout (a server component) stays untouched and no pages need to move into
// route groups.

import { usePathname } from 'next/navigation';
import { Nav } from '@/components/nav';
import { CommandPalette } from '@/components/command-palette';
import { NotificationProvider } from '@/lib/use-notifications';
import { NotificationToasts } from '@/components/notification-toasts';
import { ProductTour } from '@/components/product-tour';

// Routes that render WITHOUT the dashboard chrome (public / marketing / trust).
const FULL_BLEED = ['/welcome', '/privacy', '/terms', '/security', '/proof', '/developers'];

function isFullBleed(pathname: string): boolean {
  return FULL_BLEED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (isFullBleed(pathname)) {
    return <main className="flex-1 min-w-0 overflow-x-hidden overflow-y-auto">{children}</main>;
  }

  return (
    <NotificationProvider>
      <Nav />
      <CommandPalette />
      <NotificationToasts />
      {/* First-run interactive walk to the continuity aha-moment (once per
          browser; replay via the `myai:tour:start` window event). */}
      <ProductTour />
      {/* Mobile pt clears the fixed top bar PLUS the iOS safe-area inset the
          bar grows by in standalone (home-screen) mode; md+ has no top bar. */}
      <main className="flex-1 min-w-0 md:ml-56 p-4 pt-[calc(4rem+env(safe-area-inset-top))] md:p-8 md:pt-8 overflow-x-hidden overflow-y-auto">
        {children}
      </main>
    </NotificationProvider>
  );
}
