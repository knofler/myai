// Read-only demo mode (GO_LIVE_PLAN P2 item 14) — the hosted demo tenant on
// Vercel that lets launch visitors click around a seeded myAI workspace
// before installing.
//
// Switched by NEXT_PUBLIC_DEMO_MODE=true, set ONLY on the demo Vercel
// project. NEXT_PUBLIC_ so the same flag is inlined at build time for both
// server components (banner, tenant pinning) and the edge middleware
// (mutation gate). Local dev and the real hosted dashboard leave it unset —
// everything here compiles away to no-ops.
//
// Demo mode does three things:
//   1. middleware.ts rejects every mutating request (non-GET/HEAD/OPTIONS)
//      with 403 — the single choke point; all dashboard writes are fetch
//      calls to /api/*.
//   2. tenant.ts pins the active tenant to the default tenant, ignoring the
//      myai_tenant cookie — the demo database only holds seeded demo data,
//      but a visitor still shouldn't be able to point the UI elsewhere.
//   3. layout.tsx renders <DemoBanner /> — the "this is a demo, install the
//      real thing" CTA.
//
// Seeding: the demo Atlas database is populated with scripts/myai_demo.sh
// pointed at the demo MONGODB_URI. See documentation/HOSTED_DEMO.md.

export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

/** Where the banner's install CTA sends visitors. */
export const DEMO_INSTALL_URL =
  process.env.NEXT_PUBLIC_DEMO_INSTALL_URL || 'https://github.com/knofler/ai_management#readme';
