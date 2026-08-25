// GET /welcome/card — the public landing page's Open Graph / Twitter share
// image: <img src="https://myai.dev/welcome/card">. Public via middleware's
// PUBLIC_PREFIXES ('/welcome' matches by startsWith). Wired into
// app/welcome/page.tsx's `metadata.openGraph.images` / `metadata.twitter.images`
// so link unfurls carry the pitch instead of the generic dashboard favicon.

import { connectDB, Agent, Skill, RepoCard, Task } from '@/lib/db';
import { mergeWelcomeProof, WELCOME_PROOF_FALLBACK } from '@/lib/welcome-proof';
import { renderWelcomeCardSvg } from '@/lib/welcome-card';

export const dynamic = 'force-dynamic';

export async function GET() {
  let proof = WELCOME_PROOF_FALLBACK;
  try {
    await connectDB();
    const [agents, skills, repos, shipped] = await Promise.all([
      Agent.countDocuments(),
      Skill.countDocuments(),
      RepoCard.countDocuments(),
      Task.countDocuments({ status: { $in: ['review', 'done'] } }),
    ]);
    proof = mergeWelcomeProof({ agents, skills, repos, shipped });
  } catch {
    // Mongo down — render the fallback card rather than fail the unfurl.
  }

  const svg = renderWelcomeCardSvg(proof);

  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      // Moves slowly (aggregate platform counts) — cache generously so a
      // viral share doesn't hammer the DB.
      'cache-control': 'public, max-age=300, s-maxage=300',
    },
  });
}
