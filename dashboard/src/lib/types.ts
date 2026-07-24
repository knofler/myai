export interface Agent {
  _id: string;
  name: string;
  description: string;
  tools: string[];
  category: string;
  instructions: string;
  filePath: string;
  contentHash?: string;
  loadedAt: string;
}

export interface Skill {
  _id: string;
  name: string;
  description: string;
  triggers: string[];
  playbook: string;
  filePath: string;
  contentHash?: string;
  loadedAt: string;
}

export interface Hook {
  _id: string;
  name: string;
  events: string[];
  priority: number;
  timeout: number;
  enabled: boolean;
  source: 'builtin' | 'user' | 'bash';
  loadedAt: string;
}

export interface Rule {
  _id: string;
  name: string;
  description: string;
  category: string;
  content: string;
  filePath: string;
  loadedAt: string;
}

export interface Pattern {
  _id: string;
  patternId: string;
  title: string;
  description: string;
  tags: string[];
  category: string;
  confidence: number;
  usageCount: number;
  successCount: number;
  failureCount: number;
  lastUsed: string;
  createdAt: string;
}

export interface GatewayStatus {
  name: string;
  version: string;
  uptime: number;
  mongodb: string;
  agents: number;
  skills: number;
  hooks: number;
  rules: number;
  sessions: { total: number; active: number };
}

export const CATEGORIES = [
  'analysis', 'content', 'core', 'data', 'dev', 'devops',
  'frontend', 'github', 'neural', 'ops', 'security', 'swarm',
] as const;
