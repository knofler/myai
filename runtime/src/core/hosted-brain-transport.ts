/**
 * hosted-brain-transport.ts — the git-over-HTTP transport route ADR-017
 * deferred to a later slice ("the git-over-HTTP transport route itself
 * (`git http-backend` wiring)"). This is that slice: a thin smart-HTTP
 * handler that shells out to `git http-backend` (the same CGI program
 * GitHub/GitLab/Gitea run underneath) for the actual pkt-line protocol, with
 * everything ADR-017 already built — `verifyHostedToken`, `hostedBrainInfo`,
 * `hostedRoot` (core/hosted-brain.ts) — doing auth, entitlement, and quota in
 * front of it.
 *
 * Mounted at `/brain/:tenantId.git/*` (server.ts), matching the exact path
 * shape `hostedRemoteUrl()` mints: `https://x-access-token:<token>@<host>/brain/<tenantId>.git`.
 * `git http-backend` itself is NOT auth-aware — it happily serves whatever
 * `GIT_PROJECT_ROOT` points it at — so every route below authenticates
 * BEFORE spawning it. Fail-closed: unknown tenant, bad token, lost
 * entitlement, or over-quota all reject before a single git object moves.
 *
 * Auth: HTTP Basic, `x-access-token:<token>` (git-Basic-auth style, matching
 * the credential embedded in `hostedRemoteUrl`) — verified via the existing
 * timing-safe `verifyHostedToken`. This route does NOT go through the
 * tenant-API-key `authenticate()` REST middleware (core/auth.ts) — a
 * different credential scheme for a different transport (see server.ts
 * mount comment) — so req.tenant is never set here.
 *
 * Push gating: `git-receive-pack` (and the `info/refs?service=git-receive-pack`
 * handshake that precedes it) additionally reject when the tenant has lost
 * hosted-brain entitlement (downgrade — ADR-017 §6) or is over its plan quota
 * (ADR-017 §4), via the SAME `hostedBrainInfo` the dashboard status call
 * uses — a client cannot bypass either check by skipping the handshake.
 * `git-upload-pack` (fetch/clone/pull) is never gated: a user can always pull
 * their own data out, even on a lapsed plan (ADR-017 §6 data-locality
 * promise).
 */
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Request, Response, Router as ExpressRouter } from 'express';
import { Router } from 'express';

import { hasHostedBrain } from './billing.js';
import { hostedBrainInfo, hostedRoot, safeTenant, verifyHostedToken } from './hosted-brain.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'hosted-brain-transport' });

/** True for any request this transport owns — used by server.ts to route it around the tenant-API-key auth middleware (a different credential scheme). */
export function isHostedBrainTransportPath(path: string): boolean {
  return /^\/brain\/[^/]+\.git(\/|$)/.test(path);
}

/** Parsed HTTP Basic credentials, or null if the header is absent/malformed. */
export function parseBasicAuth(header: string | undefined): { user: string; token: string } | null {
  if (!header) return null;
  const m = /^Basic\s+(\S+)$/i.exec(header.trim());
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1] as string, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return { user: decoded.slice(0, idx), token: decoded.slice(idx + 1) };
}

function requireBasicAuth(res: Response): void {
  res.setHeader('WWW-Authenticate', 'Basic realm="myai hosted brain"');
  res.status(401).type('text/plain').send('unauthorized');
}

/**
 * Auth (+ push entitlement/quota) guard shared by all three routes. Resolves
 * `req.params.tenantId` (already the slugified form `hostedRemoteUrl` mints
 * into the URL) via the exact same `safeTenant` provisioning used, so a
 * malformed/foreign tenant segment 400s before it ever reaches the
 * filesystem.
 */
function hostedBrainAuth(gate: 'read' | 'write') {
  return (req: Request, res: Response, next: () => void): void => {
    let tenantId: string;
    try {
      tenantId = safeTenant(String(req.params.tenantId ?? ''));
    } catch {
      res.status(400).json({ error: 'invalid tenant', code: 'BAD_TENANT' });
      return;
    }

    const creds = parseBasicAuth(req.header('authorization'));
    if (!creds || !verifyHostedToken(tenantId, creds.token)) {
      requireBasicAuth(res);
      return;
    }

    if (gate === 'write') {
      const info = hostedBrainInfo(tenantId);
      if (!info.provisioned || !info.plan || !hasHostedBrain(info.plan)) {
        res.status(402).json({
          error: 'hosted brain push rejected — plan no longer entitled to the hosted remote; upgrade to resume push, or self-host your origin',
          code: 'HOSTED_BRAIN_NOT_ENTITLED',
        });
        return;
      }
      if (info.withinQuota === false) {
        res.status(507).json({
          error: `hosted brain over quota (${info.usedBytes} / ${info.limitBytes} bytes) — push rejected`,
          code: 'HOSTED_BRAIN_OVER_QUOTA',
        });
        return;
      }
    }

    req.params.tenantId = tenantId; // normalize downstream to the slug form
    next();
  };
}

// ── git http-backend CGI wiring ────────────────────────────────────────────

interface CgiEnv {
  [key: string]: string;
}

function buildCgiEnv(req: Request, tenantId: string): CgiEnv {
  const url = req.url ?? '';
  const qIdx = url.indexOf('?');
  const queryString = qIdx >= 0 ? url.slice(qIdx + 1) : '';
  // req.path is the mount-relative path under the router (e.g.
  // "/<tenantId>.git/info/refs"); http-backend wants PATH_INFO relative to
  // GIT_PROJECT_ROOT, which is exactly that.
  const pathInfo = req.path;
  const env: CgiEnv = {
    ...(process.env as CgiEnv),
    GIT_PROJECT_ROOT: hostedRoot(),
    GIT_HTTP_EXPORT_ALL: '1',
    REQUEST_METHOD: req.method,
    PATH_INFO: pathInfo,
    QUERY_STRING: queryString,
    CONTENT_TYPE: req.header('content-type') || '',
    REMOTE_USER: tenantId,
    REMOTE_ADDR: req.ip || req.socket.remoteAddress || '',
    GIT_HTTP_MAX_SIZE: process.env.HOSTED_BRAIN_MAX_PUSH_BYTES || '',
  };
  const contentLength = req.header('content-length');
  if (contentLength) env.CONTENT_LENGTH = contentLength;
  return env;
}

/**
 * Spawn `git http-backend` as a CGI process, feed it the request body on
 * stdin, and translate its CGI-style stdout (`Status:`/`Content-Type:`
 * headers, blank line, then the raw pkt-line body) into a real HTTP
 * response. No buffering of the git protocol stream itself — headers are
 * parsed incrementally from the front of stdout, everything after streams
 * straight through, so a multi-hundred-MB pack push never sits in memory.
 */
export function runGitHttpBackend(req: Request, res: Response, tenantId: string): void {
  const env = buildCgiEnv(req, tenantId);
  const child: ChildProcessByStdio<import('node:stream').Writable, Readable, Readable> = spawn(
    'git',
    ['http-backend'],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  let headersDone = false;
  let headerBuf = Buffer.alloc(0);
  let responseStarted = false;

  const cleanupAndKill = () => {
    if (!child.killed) child.kill('SIGTERM');
  };

  req.on('aborted', cleanupAndKill);
  res.on('close', cleanupAndKill);

  req.pipe(child.stdin);
  req.on('error', () => cleanupAndKill());

  child.stderr.on('data', (chunk: Buffer) => {
    log.warn({ tenantId, stderr: chunk.toString('utf8').slice(0, 2000) }, 'git http-backend stderr');
  });

  child.stdout.on('data', (chunk: Buffer) => {
    if (headersDone) {
      res.write(chunk);
      return;
    }
    headerBuf = Buffer.concat([headerBuf, chunk]);
    // CGI header/body separator is a blank line — accept both \n\n and \r\n\r\n.
    const sepLf = headerBuf.indexOf('\n\n');
    const sepCrlf = headerBuf.indexOf('\r\n\r\n');
    const sep = sepCrlf >= 0 && (sepLf < 0 || sepCrlf < sepLf) ? sepCrlf : sepLf;
    if (sep < 0) return; // keep buffering until we see the full header block

    const sepLen = headerBuf.slice(sep, sep + 4).toString('ascii') === '\r\n\r\n' ? 4 : 2;
    const rawHeaders = headerBuf.slice(0, sep).toString('utf8');
    const body = headerBuf.slice(sep + sepLen);
    headersDone = true;

    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of rawHeaders.split(/\r?\n/)) {
      if (!line) continue;
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const name = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (/^status$/i.test(name)) {
        const m = /^(\d{3})/.exec(value);
        if (m) status = Number(m[1]);
      } else {
        headers[name] = value;
      }
    }
    responseStarted = true;
    res.writeHead(status, headers);
    if (body.length) res.write(body);
  });

  child.on('error', (err) => {
    log.error({ tenantId, err }, 'git http-backend failed to spawn');
    if (!res.headersSent) {
      res.status(500).json({ error: 'hosted brain transport unavailable', code: 'GIT_BACKEND_ERROR' });
    } else {
      res.end();
    }
  });

  child.on('close', (code) => {
    if (!responseStarted) {
      // Process exited before completing the CGI header block — treat as a
      // hard failure rather than hanging the client.
      log.error({ tenantId, code }, 'git http-backend closed before emitting headers');
      if (!res.headersSent) {
        res.status(502).json({ error: 'hosted brain transport error', code: 'GIT_BACKEND_NO_HEADERS' });
        return;
      }
    }
    res.end();
  });
}

// ── router ──────────────────────────────────────────────────────────────────

/**
 * Express Router implementing the smart-HTTP dumb^Wsmart protocol surface:
 * ref advertisement (GET .../info/refs) + the two RPCs (POST .../git-upload-pack,
 * POST .../git-receive-pack). Mount at `/brain` in server.ts — routes below
 * are relative to that.
 */
export function hostedBrainTransportRouter(): ExpressRouter {
  const router = Router();

  router.get('/:tenantId.git/info/refs', (req: Request, res: Response) => {
    const service = String(req.query.service ?? '');
    const gate = service === 'git-receive-pack' ? 'write' : 'read';
    hostedBrainAuth(gate)(req, res, () => {
      runGitHttpBackend(req, res, req.params.tenantId as string);
    });
  });

  router.post('/:tenantId.git/git-upload-pack', (req: Request, res: Response) => {
    hostedBrainAuth('read')(req, res, () => {
      runGitHttpBackend(req, res, req.params.tenantId as string);
    });
  });

  router.post('/:tenantId.git/git-receive-pack', (req: Request, res: Response) => {
    hostedBrainAuth('write')(req, res, () => {
      runGitHttpBackend(req, res, req.params.tenantId as string);
    });
  });

  return router;
}
