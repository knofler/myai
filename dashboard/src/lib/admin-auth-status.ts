// Admin-auth status — whether ADMIN_API_TOKEN is configured on this
// deployment, and what it gates. Never reads or exposes the token value
// itself; every consumer (mcp-tools, gift-codes, feature-flags, marketplace
// review, budgets admin endpoints) already checks `process.env.ADMIN_API_TOKEN`
// independently (lib/require-operator.ts) and surfaces a reactive error when
// it's missing — this is the one place an operator can see the posture across
// all of them at a glance, without having to hit each panel first.

export interface AdminAuthStatus {
  configured: boolean;
  gatedCapabilities: string[];
}

const GATED_CAPABILITIES: string[] = [
  'MCP tool visibility overrides (System → MCP Tools)',
  'Gift codes mint / list / revoke (System → Gift Codes)',
  'Feature flags admin (System → Feature Flags)',
  'Marketplace review queue (/marketplace/review)',
  'Budget guard admin endpoints',
];

export function readAdminAuthStatus(): AdminAuthStatus {
  return {
    configured: Boolean(process.env.ADMIN_API_TOKEN),
    gatedCapabilities: GATED_CAPABILITIES,
  };
}
