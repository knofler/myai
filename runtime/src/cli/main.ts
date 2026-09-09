#!/usr/bin/env node
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '../core/index.js';
import { upsertEnvVars } from '../shared/env-file.js';

/**
 * Locate the framework's init_connect.sh. It ships with the master repo at
 * <root>/scripts/init_connect.sh; this compiled CLI lives at
 * <root>/runtime/dist/cli/main.js, so the script is three levels up. We also
 * try a couple of fallbacks (cwd, AI/ subtree) so the command works whether
 * invoked from the master repo or a managed project.
 */
function resolveInitConnectScript(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../scripts/init_connect.sh'),
    resolve(process.cwd(), 'scripts/init_connect.sh'),
    resolve(process.cwd(), 'AI/scripts/init_connect.sh'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

interface StatusResponse {
  version: string;
  uptime: number;
  mongodb: string;
  agents: number;
  skills: number;
  sessions: { active: number; total: number };
}

interface AgentItem { name: string; category: string; description: string }
interface SessionItem { id: string; agentName: string; status: string; messageCount: number; lastActivity: string }

const program = new Command();

program
  .name('myai')
  .description('myAI — Self-hosted AI gateway daemon')
  .version('0.1.0');

program
  .command('start')
  .description('Start the myAI gateway')
  .option('-c, --config <path>', 'Path to gateway.config.json')
  .option('-p, --port <number>', 'HTTP port override', '3200')
  .option('--ws-port <number>', 'WebSocket port override', '3201')
  .action(async (opts: { config?: string; port: string; wsPort: string }) => {
    if (opts.port) process.env.GATEWAY_HTTP_PORT = opts.port;
    if (opts.wsPort) process.env.GATEWAY_WS_PORT = opts.wsPort;
    await bootstrap(opts.config);
  });

program
  .command('status')
  .description('Show gateway status')
  .option('-p, --port <number>', 'HTTP port', '3200')
  .action(async (opts: { port: string }) => {
    try {
      const res = await fetch(`http://localhost:${opts.port}/status`);
      const data = await res.json() as StatusResponse;
      console.log('\nmyAI Gateway Status');
      console.log('═'.repeat(40));
      console.log(`  Version:    ${data.version}`);
      console.log(`  Uptime:     ${formatUptime(data.uptime)}`);
      console.log(`  MongoDB:    ${data.mongodb}`);
      console.log(`  Agents:     ${data.agents}`);
      console.log(`  Skills:     ${data.skills}`);
      console.log(`  Sessions:   ${data.sessions.active} active / ${data.sessions.total} total`);
      console.log('');
    } catch {
      console.error('Gateway not running on port', opts.port);
      process.exit(1);
    }
  });

program
  .command('agents')
  .description('List loaded agents')
  .option('-p, --port <number>', 'HTTP port', '3200')
  .option('--category <name>', 'Filter by category')
  .action(async (opts: { port: string; category?: string }) => {
    try {
      const url = new URL(`http://localhost:${opts.port}/api/agents`);
      if (opts.category) url.searchParams.set('category', opts.category);
      const res = await fetch(url.toString());
      const data = await res.json() as { count: number; agents: AgentItem[] };
      console.log(`\n${data.count} agents loaded:\n`);
      for (const a of data.agents) {
        console.log(`  [${a.category}] ${a.name} — ${a.description.slice(0, 80)}`);
      }
      console.log('');
    } catch {
      console.error('Gateway not running on port', opts.port);
      process.exit(1);
    }
  });

program
  .command('sessions')
  .description('List active sessions')
  .option('-p, --port <number>', 'HTTP port', '3200')
  .action(async (opts: { port: string }) => {
    try {
      const res = await fetch(`http://localhost:${opts.port}/api/sessions`);
      const data = await res.json() as { count: number; sessions: SessionItem[] };
      if (data.count === 0) {
        console.log('\nNo active sessions.\n');
        return;
      }
      console.log(`\n${data.count} sessions:\n`);
      for (const s of data.sessions) {
        console.log(`  ${s.id.slice(0, 8)} [${s.status}] ${s.agentName} — ${s.messageCount} msgs — ${s.lastActivity}`);
      }
      console.log('');
    } catch {
      console.error('Gateway not running on port', opts.port);
      process.exit(1);
    }
  });

program
  .command('new-app')
  .description('Create a new app from a plain-English idea — drives agentFlow\'s idea→app pipeline and registers it in the directory')
  .argument('<idea>', 'Plain-English description of the app to build')
  .option('-p, --port <number>', 'Gateway HTTP port', '3200')
  .option('-n, --name <name>', 'Explicit project/repo name (defaults to a slug of the idea)')
  .option('-g, --group <group>', 'Directory grouping label', 'Generated')
  .option('--no-trigger', "Create the project + register the card but don't start the auto-run pipeline")
  .action(async (idea: string, opts: { port: string; name?: string; group?: string; trigger: boolean }) => {
    try {
      const res = await fetch(`http://localhost:${opts.port}/api/new-app`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idea, name: opts.name, group: opts.group, trigger: opts.trigger }),
      });
      const data = await res.json() as {
        ok?: boolean; name?: string; projectId?: string; projectUrl?: string;
        pipelineTriggered?: boolean; message?: string; error?: string;
      };
      console.log('\nmyAI — New App');
      console.log('═'.repeat(40));
      console.log(`  Name:       ${data.name ?? '(unknown)'}`);
      if (data.projectId) console.log(`  Project:    ${data.projectId}`);
      if (data.projectUrl) console.log(`  URL:        ${data.projectUrl}`);
      console.log(`  Pipeline:   ${data.pipelineTriggered ? 'triggered' : 'not triggered'}`);
      console.log(`  Status:     ${data.message ?? ''}`);
      if (data.error) console.log(`  Note:       ${data.error}`);
      console.log('');
      if (!data.ok) process.exitCode = 1;
    } catch {
      console.error('Gateway not running on port', opts.port);
      process.exit(1);
    }
  });

// `myai connect …` — Connect Hub embedding into a target app.
const connect = program.command('connect').description('Connect Hub — in-app bug/feature/help center');

connect
  .command('install')
  .description('Embed Connect Hub into a target Next.js app (wraps init_connect.sh)')
  .argument('<repo>', 'Path to the target Next.js project')
  .action((repo: string) => {
    const target = resolve(process.cwd(), repo);
    if (!existsSync(resolve(target, 'src'))) {
      console.error(`Error: ${target}/src not found — is this a Next.js project?`);
      process.exit(1);
    }
    const script = resolveInitConnectScript();
    if (!script) {
      console.error('Error: init_connect.sh not found. Run from the AI framework repo (master or a managed project with AI/).');
      process.exit(1);
    }
    console.log(`\nmyAI — Connect Hub install`);
    console.log('═'.repeat(40));
    console.log(`  Script: ${script}`);
    console.log(`  Target: ${target}\n`);
    const child = spawn('bash', [script, target], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    child.on('error', (err) => {
      console.error(`Failed to run init_connect.sh: ${err.message}`);
      process.exit(1);
    });
  });

// `myai rotate-keys …` — self-rotation for the gateway local-bridge token and
// a tenant's bootstrap API key, both with a dual-valid grace window: the OLD
// credential keeps authenticating until the grace cutoff (core/auth.ts), so
// rotating never 401s an in-flight caller still holding it. Both subcommands
// call the gateway over loopback (http://localhost:<port>), which is
// local-trust — no token needed for the rotate call itself.
const rotateKeys = program.command('rotate-keys').description('Rotate gateway credentials with a zero-downtime grace window');

interface LocalTokenRotateResponse {
  token?: string;
  previousToken?: string;
  previousExpiresAt?: number;
  graceMinutes?: number;
  error?: string;
}

rotateKeys
  .command('local')
  .description('Rotate GATEWAY_LOCAL_TOKEN — the OLD token keeps authenticating until the grace window elapses')
  .option('-p, --port <number>', 'Gateway HTTP port', '3200')
  .option('-g, --grace-minutes <number>', 'Minutes the old token stays valid (0 = immediate cutover)')
  .option('--env-file <path>', 'Persist the rotation into this .env file (GATEWAY_LOCAL_TOKEN + _PREVIOUS + _PREVIOUS_EXPIRES_AT) so a restart does not revert it')
  .action(async (opts: { port: string; graceMinutes?: string; envFile?: string }) => {
    try {
      const body: Record<string, unknown> = {};
      if (opts.graceMinutes !== undefined) body.graceMinutes = Number(opts.graceMinutes);
      const res = await fetch(`http://localhost:${opts.port}/api/auth/local-token/rotate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json() as LocalTokenRotateResponse;
      if (!res.ok || !data.token) {
        console.error(`Rotate failed: ${data.error ?? res.statusText}`);
        process.exit(1);
      }
      console.log('\nmyAI — Local token rotated');
      console.log('═'.repeat(40));
      console.log(`  New token:    ${data.token}`);
      console.log(`  Grace window: ${data.graceMinutes} min`);
      if (data.previousExpiresAt) {
        console.log(`  Old token valid until: ${new Date(data.previousExpiresAt).toISOString()}`);
      }
      if (opts.envFile) {
        upsertEnvVars(opts.envFile, {
          GATEWAY_LOCAL_TOKEN: data.token,
          GATEWAY_LOCAL_TOKEN_PREVIOUS: data.previousToken,
          GATEWAY_LOCAL_TOKEN_PREVIOUS_EXPIRES_AT: data.previousExpiresAt ? String(data.previousExpiresAt) : undefined,
        });
        console.log(`  Persisted to: ${opts.envFile}`);
      } else {
        console.log('  Not persisted — pass --env-file <path> so a restart keeps this rotation.');
      }
      console.log('');
    } catch {
      console.error('Gateway not running on port', opts.port);
      process.exit(1);
    }
  });

rotateKeys
  .command('tenant')
  .description("Rotate a tenant's bootstrap API key — the OLD key keeps authenticating until the grace window elapses")
  .argument('<tenantId>', 'Tenant ID to rotate')
  .option('-p, --port <number>', 'Gateway HTTP port', '3200')
  .option('-e, --env <live|test>', 'Key environment', 'live')
  .option('-g, --grace-minutes <number>', 'Minutes the old key stays valid (0 = immediate cutover)')
  .action(async (tenantId: string, opts: { port: string; env: string; graceMinutes?: string }) => {
    try {
      const body: Record<string, unknown> = { tenantId, env: opts.env === 'test' ? 'test' : 'live' };
      if (opts.graceMinutes !== undefined) body.graceMinutes = Number(opts.graceMinutes);
      const res = await fetch(`http://localhost:${opts.port}/api/auth/tenant-key/rotate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { tenantId?: string; rawKey?: string; error?: string };
      if (!res.ok || !data.rawKey) {
        console.error(`Rotate failed: ${data.error ?? res.statusText}`);
        process.exit(1);
      }
      console.log('\nmyAI — Tenant key rotated');
      console.log('═'.repeat(40));
      console.log(`  Tenant:  ${data.tenantId}`);
      console.log(`  New key: ${data.rawKey}`);
      console.log('  (show-once — store it now; the old key stays valid for the grace window)');
      console.log('');
    } catch {
      console.error('Gateway not running on port', opts.port);
      process.exit(1);
    }
  });

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

program.parse();
