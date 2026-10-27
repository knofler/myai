#!/usr/bin/env node
/**
 * Claude CLI Bridge Server
 *
 * Lightweight HTTP server that runs on the HOST machine and proxies
 * requests to `claude -p`. The gateway container calls this via
 * host.docker.internal:3202.
 *
 * Usage:
 *   npx tsx runtime/src/llm/bridge.ts
 *   # or
 *   node runtime/dist/llm/bridge.js
 *
 * Environment:
 *   BRIDGE_PORT (default: 3202)
 *   BRIDGE_HOST (default: 127.0.0.1)
 *   LLM_BRIDGE_TOKEN (required; the gateway sends the same value)
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { BRIDGE_TOKEN_HEADER, bridgeBindHost, bridgeRequestAuthorized, bridgeToken } from './bridge-guard.js';

const PORT = Number(process.env.BRIDGE_PORT || 3202);
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT || 180_000); // 3 minutes
const HOST = bridgeBindHost();
const TOKEN = bridgeToken();
if (!TOKEN) {
  console.error('[bridge] LLM_BRIDGE_TOKEN is not set. Set the same random value for the bridge and the gateway, e.g.\n'
    + '  export LLM_BRIDGE_TOKEN=$(openssl rand -hex 32)');
  process.exit(1);
}

function callClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'text'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Claude CLI timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Claude CLI exited ${code}: ${stderr}`));
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', provider: 'claude-cli' }));
    return;
  }

  // Prompt endpoint
  if (req.method === 'POST' && req.url === '/') {
    if (!bridgeRequestAuthorized(req.headers[BRIDGE_TOKEN_HEADER], TOKEN)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bridge token required' }));
      return;
    }
    try {
      const body = JSON.parse(await readBody(req));
      const prompt = body.prompt;

      if (!prompt || typeof prompt !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'prompt required' }));
        return;
      }

      console.log(`[bridge] Prompt received (${prompt.length} chars), calling claude...`);
      const start = Date.now();
      const response = await callClaude(prompt);
      const elapsed = Date.now() - start;
      console.log(`[bridge] Response received (${response.length} chars, ${elapsed}ms)`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response, elapsed }));
    } catch (err) {
      console.error('[bridge] Error:', (err as Error).message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] Claude CLI bridge listening on http://${HOST}:${PORT}`);
  console.log(`[bridge] Docker containers use: http://host.docker.internal:${PORT}`);
});
