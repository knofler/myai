import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { AppShell } from '@/components/app-shell';
import { DemoBanner } from '@/components/demo-banner';
import { IdleTimeoutGuard } from '@/components/idle-timeout-guard';
import { ServiceWorkerRegister } from '@/components/sw-register';
import { TenantProvider } from '@/lib/tenant-context';
import { TenantCookieSync } from '@/components/tenant-cookie-sync';
import { ThemeProvider } from '@/lib/theme-context';
import './globals.css';

// Applies the resolved theme class before first paint so there's no
// dark<->light flash between server render and hydration. Runs inline
// (not a module) precisely so it executes synchronously in <head>, before
// the browser paints <body>. Kept in lockstep with the storage key format
// in lib/theme.ts (`myai.theme.v1.<tenantId|default>`) and the resolution
// rule in lib/theme.ts#resolveTheme — duplicated here in plain JS because
// this needs to run before any React/module code loads.
const THEME_BOOT_SCRIPT = `
(function () {
  try {
    var cur = localStorage.getItem('myai.tenant.current.v1');
    var key = 'myai.theme.v1.' + (cur || 'default');
    var pref = localStorage.getItem(key) || 'system';
    var dark = pref === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : pref === 'dark';
    if (!dark) document.documentElement.classList.add('light');
  } catch (e) {}
})();
`;

export const metadata: Metadata = {
  title: 'myAI — Mission Control',
  description: 'AI Management Framework — Mission Control Dashboard',
  applicationName: 'myAI',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'myAI',
  },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#cc4426',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale}>
      <head>
        {/* eslint-disable-next-line react/no-danger */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-screen flex">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <TenantProvider>
            <ThemeProvider>
              <TenantCookieSync />
              <ServiceWorkerRegister />
              <IdleTimeoutGuard />
              <AppShell>{children}</AppShell>
              <DemoBanner />
            </ThemeProvider>
          </TenantProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
