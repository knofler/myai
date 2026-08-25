// Pure, DB-free shaping for the /welcome landing page's live proof numbers
// (agents/skills/repos/shipped). The page (app/welcome/page.tsx) and the
// OG share card (app/welcome/card/route.ts) both do the Mongo read and hand
// raw counts here — same DB-free-testable split as lib/proof.ts.

export interface WelcomeProof {
  agents: number;
  skills: number;
  repos: number;
  shipped: number; // tasks the autonomous runner has carried to review/done
}

// Known-good figures so the public page never renders a blank/zero headline
// number it can't back up when Mongo is briefly unreachable.
export const WELCOME_PROOF_FALLBACK: WelcomeProof = { agents: 56, skills: 62, repos: 24, shipped: 0 };

/**
 * Merge raw Mongo counts with the fallback. `agents`/`skills`/`repos` fall
 * back on a falsy (0/undefined) count — an empty or unreachable collection
 * shouldn't headline as "0 specialist agents". `shipped` is the one count
 * allowed to be a genuine zero (a fresh install has shipped nothing yet), so
 * it's never replaced by the fallback.
 */
export function mergeWelcomeProof(raw: Partial<WelcomeProof>): WelcomeProof {
  return {
    agents: raw.agents || WELCOME_PROOF_FALLBACK.agents,
    skills: raw.skills || WELCOME_PROOF_FALLBACK.skills,
    repos: raw.repos || WELCOME_PROOF_FALLBACK.repos,
    shipped: raw.shipped ?? WELCOME_PROOF_FALLBACK.shipped,
  };
}
