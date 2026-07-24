import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  output: 'standalone',
  images: { unoptimized: true },
  // Client router cache. Next 15 defaults dynamic pages to 0s — every
  // navigation (even straight back to the page you just left) refetched the
  // whole RSC payload from a Vercel function, which is why the app felt like
  // it reloaded its structure on every tap. 30s means back-and-forth
  // browsing serves instantly from the in-memory router cache; live pages
  // still refetch after 30s (and their auto-refresh components keep data
  // current while mounted).
  experimental: {
    staleTimes: { dynamic: 30, static: 300 },
  },
  // 17-page IA collapsed to 6 destinations (2026-06 redesign) — every old URL
  // keeps working via a redirect into its new home.
  async redirects() {
    return [
      { source: '/schedule', destination: '/work', permanent: false },
      { source: '/tasks', destination: '/work', permanent: false },
      { source: '/plan', destination: '/work?tab=plans', permanent: false },
      { source: '/orchestration', destination: '/work?tab=orchestration', permanent: false },
      // NOTE: /fleet is now a REAL page (Fleet Morning Console, 2026-06-16) — no longer redirected.
      { source: '/directory', destination: '/apps', permanent: false },
      { source: '/repos', destination: '/apps?tab=health', permanent: false },
      { source: '/routing', destination: '/system', permanent: false },
      { source: '/budgets', destination: '/system?tab=budgets', permanent: false },
      { source: '/costs', destination: '/system?tab=costs', permanent: false },
      { source: '/api-health', destination: '/system?tab=api', permanent: false },
      { source: '/agents', destination: '/registry', permanent: false },
      { source: '/skills', destination: '/registry?tab=skills', permanent: false },
      { source: '/hooks', destination: '/registry?tab=hooks', permanent: false },
      { source: '/rules', destination: '/registry?tab=rules', permanent: false },
      { source: '/patterns', destination: '/registry?tab=patterns', permanent: false },
      { source: '/sona', destination: '/memory', permanent: false },
      { source: '/sessions', destination: '/memory?tab=sessions', permanent: false },
    ];
  },
  outputFileTracingExcludes: {
    '*': [
      './node_modules/@img/**',
      './node_modules/sharp/**',
      './node_modules/typescript/**',
    ],
  },
  // Heavy static caching (Vercel serves these headers at its edge).
  // /_next/static/* is already immutable-cached by Next automatically; the
  // gap is public/ assets, which Vercel defaults to max-age=0 must-revalidate
  // (a revalidation round-trip on every load). Icons/manifest get a day of
  // hard cache + a week of stale-while-revalidate — snappy repeat loads that
  // still pick up a rebrand within a day without stranding installed
  // home-screen apps for a year. sw.js stays revalidate-always: long-caching
  // a service worker delays every future update of everything it controls.
  async headers() {
    return [
      {
        source: '/:file(icon.svg|icon-192.png|icon-512.png|apple-touch-icon.png|apple-touch-icon.svg)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' },
        ],
      },
      {
        source: '/manifest.webmanifest',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=3600, stale-while-revalidate=86400' },
        ],
      },
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
