// ── Bundled MCP connector set (betaC day-one connectors) ─────────────
//
// A fresh betaC install should have working MCP connectors the moment it boots
// — not an empty list the user has to assemble by hand. This module is the
// single source of truth for the *curated default bundle*: the connectors every
// new tenant is seeded with, mirrored from the framework's own `templates/
// mcp.json` + `mcp-web.json` so the dashboard, the gateway, and a scaffolded
// project all agree on "what connectors ship out of the box".
//
// The per-tenant enabled/disabled state + any custom connectors live in Mongo
// (see connector-store.ts). This file is just the immutable catalog of bundled
// definitions and the seed source.

export type ConnectorTransport = 'http' | 'stdio';

export type ConnectorCategory =
  | 'framework'   // the betaC/myAI gateway itself
  | 'docs'        // library / API documentation
  | 'design'      // UI / component / design tooling
  | 'browser'     // browser automation + E2E
  | 'vcs'         // source control / GitHub
  | 'deploy'      // hosting / deployment
  | 'storage'     // files / object storage
  | 'custom';     // user-added

export interface ConnectorDef {
  /** Stable slug, also the key under `mcpServers` in a generated .mcp.json. */
  key: string;
  /** Human-readable label for the dashboard. */
  label: string;
  category: ConnectorCategory;
  transport: ConnectorTransport;
  description: string;
  /** http transport — the MCP endpoint URL. */
  url?: string;
  /** stdio transport — the launch command + args. */
  command?: string;
  args?: string[];
  /** Env passed to a stdio server or as http headers (values may be `${VAR}`). */
  env?: Record<string, string>;
  /**
   * Env var names the operator must supply for this connector to actually work
   * (e.g. a PAT / API key). When non-empty the dashboard flags the connector as
   * "needs a key" so a day-one install knows what's still required.
   */
  requiresEnv?: string[];
  /**
   * Whether this connector is enabled by default when a tenant is seeded.
   * Key-less connectors that work immediately default to enabled; ones that
   * need a credential are seeded disabled so nothing is half-wired on boot.
   */
  defaultEnabled: boolean;
}

/**
 * The curated bundle. Order is the dashboard display order. `myai` is
 * always first — it is betaC talking to its own gateway and is the connector
 * that makes the whole memory/context/RAG/scheduling surface available.
 */
export const BUNDLED_CONNECTORS: ConnectorDef[] = [
  {
    key: 'myai',
    label: 'betaC Gateway',
    category: 'framework',
    transport: 'http',
    url: 'http://localhost:3100/mcp',
    description:
      'The betaC/myAI gateway itself — memory, RAG session recall, state + handoff store, tasks, scheduling, agents and skills. This is the connector that makes betaC "Better Claude".',
    defaultEnabled: true,
  },
  {
    key: 'context7',
    label: 'Context7',
    category: 'docs',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    description: 'Up-to-date library + framework documentation fetched on demand. No key required.',
    defaultEnabled: true,
  },
  {
    key: 'shadcn-ui',
    label: 'shadcn/ui',
    category: 'design',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@jpisnice/shadcn-ui-mcp-server'],
    description: 'Browse and pull shadcn/ui component source + demos. No key required.',
    defaultEnabled: true,
  },
  {
    key: 'playwright',
    label: 'Playwright',
    category: 'browser',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp'],
    description: 'Drive a real browser for E2E testing, navigation, snapshots and form fills. No key required.',
    defaultEnabled: true,
  },
  {
    key: 'github',
    label: 'GitHub',
    category: 'vcs',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
    requiresEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    description: 'Issues, PRs, repo + code search. Needs a GitHub personal access token.',
    defaultEnabled: false,
  },
  {
    key: 'vercel',
    label: 'Vercel',
    category: 'deploy',
    transport: 'http',
    url: 'https://mcp.vercel.com',
    description: 'Inspect deployments, projects, build + runtime logs. Authenticates in-app (OAuth).',
    defaultEnabled: true,
  },
  {
    key: 'dropbox',
    label: 'Dropbox',
    category: 'storage',
    transport: 'http',
    url: 'https://mcp.dropbox.com/mcp',
    description: 'Read + write files in Dropbox. Authenticates in-app (OAuth).',
    defaultEnabled: false,
  },
];

/** Quick lookup of a bundled definition by key. */
export const BUNDLED_BY_KEY: Record<string, ConnectorDef> = Object.fromEntries(
  BUNDLED_CONNECTORS.map((c) => [c.key, c]),
);

/** True if `key` names a connector that ships in the curated bundle. */
export function isBundledKey(key: string): boolean {
  return key in BUNDLED_BY_KEY;
}
