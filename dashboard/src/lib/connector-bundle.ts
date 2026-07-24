// Dashboard mirror of the gateway's curated MCP connector bundle
// (runtime/src/repos/connector-bundle.ts). The dashboard reads + writes the
// `connectors` collection directly with the active tenant (same pattern as the
// New App flow), so it seeds the bundle itself rather than depending on the
// gateway bridge token's tenant resolution. Keep this in sync with the runtime
// bundle — it is the single source of "what ships day one".

export type ConnectorTransport = 'http' | 'stdio';

export interface ConnectorDef {
  key: string;
  label: string;
  category: string;
  transport: ConnectorTransport;
  description: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  requiresEnv?: string[];
  defaultEnabled: boolean;
}

export const BUNDLED_CONNECTORS: ConnectorDef[] = [
  {
    key: 'myai',
    label: 'betaC Gateway',
    category: 'framework',
    transport: 'http',
    url: 'http://localhost:3100/mcp',
    description:
      'The betaC/myAI gateway itself — memory, RAG session recall, state + handoff store, tasks, scheduling, agents and skills.',
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

export const BUNDLED_BY_KEY: Record<string, ConnectorDef> = Object.fromEntries(
  BUNDLED_CONNECTORS.map((c) => [c.key, c]),
);

export function isBundledKey(key: string): boolean {
  return key in BUNDLED_BY_KEY;
}
