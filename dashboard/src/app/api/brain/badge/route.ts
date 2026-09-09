import { NextResponse } from 'next/server';
import { fetchBrainExplore, fetchBrainHealth } from '@/lib/brain';

// Brain badge feed — the same data the CLI statusline badge shows (brain SHA +
// health score/grade), for the v2 shell top-bar badge (DASHBOARD_REDESIGN_
// 2026-09 §Shell). SHA/branch come from `brain_explore` (called with no
// expensive sections — just the cheap top-level metadata), the composite score
// from `brain_health` (record:false so a page load never logs a trend point).
// Every field is null-safe: if the gateway is unreachable the badge degrades to
// a neutral placeholder rather than erroring.

export const dynamic = 'force-dynamic';

export async function GET() {
  const [health, explore] = await Promise.all([
    fetchBrainHealth(),
    fetchBrainExplore([]),
  ]);

  return NextResponse.json({
    sha: explore?.lastCommit ?? null,
    branch: explore?.branch ?? null,
    score: health?.score ?? null,
    grade: health?.grade ?? null,
  });
}
