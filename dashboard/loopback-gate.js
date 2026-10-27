'use strict';
/**
 * Front door for the dashboard's published port (task-a6930b2b, local
 * auto-login — operator request, repeat ask 2026-10-02).
 *
 * WHY THIS FILE EXISTS: Next's edge middleware (src/middleware.ts) cannot see
 * the raw TCP peer address — that's the whole reason the single-operator gate
 * (GHSA-ffgf-pmmg-cjj5) had to stop trusting the spoofable `Host` header
 * instead of fixing loopback detection, and why it has had no loopback
 * exemption since. A real fix needs a layer that DOES see the socket, same as
 * the gateway's own `isLoopback(req.socket.remoteAddress)` (runtime/src/core/
 * auth.ts) — but middleware runs in a sandboxed runtime with no such access,
 * and this app is built with `output: 'standalone'`, whose generated
 * server.js uses Next's internal `startServer()` (not the public `next()`
 * custom-server API — that needs webpack-compiled pieces standalone doesn't
 * bundle) and exposes no request hook. So this process is a separate, tiny,
 * Next-independent reverse proxy that IS the one thing bound to the
 * container's published port; Next's own (unmodified, stock-generated)
 * server.js listens on an internal, unpublished port reachable only from
 * inside this same container — nothing, not even another container on the
 * bridge network, can reach it except through here.
 *
 * EMPIRICAL FINDING (verified live against this exact image, 2026-10-02):
 * Docker Desktop (macOS) NATs EVERY host-originated connection to a
 * published port — whether the client dialed 127.0.0.1 OR the Mac's LAN
 * IP — through the SAME fixed VM gateway address, 192.168.65.1. The peer
 * address alone cannot tell loopback and LAN traffic apart on this platform.
 * That is why DASHBOARD_LOCAL_AUTOLOGIN by itself is not enough: it ALSO
 * requires HOST_BIND=127.0.0.1, which changes what Docker actually publishes
 * (docker-compose.yml `ports:`) so the LAN interface is physically unable to
 * reach this port — the OS refuses the connection before Docker (or this
 * file) ever sees it. HOST_BIND defaults to 0.0.0.0 (LAN/phone workflows,
 * see docker-compose.yml), so auto-login stays off until an operator
 * deliberately trades that away for it on their own machine.
 *
 * THREAT MODEL: with both conditions met, anything that can open a TCP
 * connection to this Mac's loopback interface is auto-signed-in as the
 * operator — i.e. another local user account, or another local process, on
 * the SAME machine. Acceptable on a single-user Mac (the stated threat model
 * for this change); would NOT be acceptable on a shared machine. Does not
 * apply on Vercel/hosted (no Dockerfile/custom process there at all — see
 * src/middleware.ts's `process.env.VERCEL` check, which is the second,
 * independent reason this can never fire in production even if the env flag
 * were ever set by mistake somewhere it shouldn't be).
 */
const http = require('node:http');
const fs = require('node:fs');

const PUBLIC_PORT = parseInt(process.env.PORT, 10) || 3210;
const PUBLIC_HOST = process.env.HOSTNAME || '0.0.0.0';
const UPSTREAM_PORT = parseInt(process.env.NEXT_INTERNAL_PORT, 10) || 3211;
const UPSTREAM_HOST = '127.0.0.1';

const DASHBOARD_LOCAL_AUTOLOGIN = process.env.DASHBOARD_LOCAL_AUTOLOGIN === '1';
const HOST_BIND = process.env.HOST_BIND || '0.0.0.0';

// Must match src/middleware.ts's LOOPBACK_HEADER.
const TRUSTED_HEADER = 'x-myai-verified-loopback';

/**
 * LINUX (Docker Engine, v1 G2 2026-10-22): a host-originated connection to a
 * published port reaches this container from its network's GATEWAY address
 * (docker-proxy / the hairpin DNAT), e.g. 172.19.0.1 — not 127.0.0.1 and not
 * Docker Desktop's 192.168.65.1 — so a stranger on Linux could never reach
 * their own dashboard. That gateway is THIS container's default route, read
 * once at start from /proc/net/route. Exactly that one IP is trusted, never
 * its subnet: another container on the same network arrives from its OWN
 * address and stays untrusted. Safe for the same reason as the Desktop VM
 * address — verifiedLoopback() still requires HOST_BIND=127.0.0.1, so nothing
 * off this machine can reach the published port at all.
 */
function defaultRouteGateway(routeText) {
  for (const line of String(routeText || '').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || f[1] !== '00000000') continue;
    const hex = f[2];
    if (!/^[0-9A-Fa-f]{8}$/.test(hex) || /^0+$/.test(hex)) continue;
    const n = parseInt(hex, 16); // host byte order (little-endian) in /proc/net/route
    return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
  }
  return null;
}

function readBridgeGateway() {
  try {
    return defaultRouteGateway(fs.readFileSync(process.env.LOOPBACK_ROUTE_FILE || '/proc/net/route', 'utf8'));
  } catch {
    return null; // not Linux / no procfs → only the fixed addresses below
  }
}
const BRIDGE_GATEWAY = readBridgeGateway();

/** IPv6-mapped IPv4 (`::ffff:127.0.0.1`), bare loopback, the Docker Desktop
 * VM gateway (see EMPIRICAL FINDING above), and — on Linux — this container's
 * own network gateway (see above).
 *
 * The Desktop VM address (audit L-10, v1 G5): another container that dials the
 * published port via host.docker.internal also arrives from 192.168.65.1, so
 * the PEER ADDRESS alone cannot tell it from the operator's browser. It is
 * kept (dropping it breaks auto-login on every Mac) because verifiedLoopback()
 * now also requires a loopback Host header: such a container sends
 * `Host: host.docker.internal:<port>` and is refused. Only local code that
 * deliberately forges `Host: localhost` still passes — the same "another local
 * process on this machine" case the THREAT MODEL above already accepts. */
function isLoopbackish(addr, bridgeGateway = BRIDGE_GATEWAY) {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  if (a === '::1' || a === '127.0.0.1' || a.startsWith('127.')) return true;
  if (a === '192.168.65.1') return true;
  if (bridgeGateway && a === bridgeGateway) return true;
  return false;
}

/**
 * Audit H-7 (v1 G5): the peer address proves the TCP connection is local, not
 * that the BROWSER meant to talk to the dashboard. A page on any website can
 * DNS-rebind its own hostname to 127.0.0.1 — the connection is then loopback
 * but the request carries `Host: evil.example:<port>`. Auto-login is only for
 * a Host the operator would actually type: localhost, 127.x or [::1], any port
 * (the published port may be remapped). Anything else gets no trust header and
 * falls through to the normal operator login.
 */
function hostnameOf(hostHeader) {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLoopbackHost(hostHeader) {
  const h = hostnameOf(hostHeader);
  if (!h) return false;
  return h === 'localhost' || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function verifiedLoopback(req) {
  return (
    DASHBOARD_LOCAL_AUTOLOGIN &&
    HOST_BIND === '127.0.0.1' &&
    isLoopbackish(req.socket.remoteAddress) &&
    isLoopbackHost(req.headers && req.headers.host)
  );
}

/**
 * Audit H-7, the CSRF half: with auto-login on (and with a cookie session
 * too), any page the operator visits could POST to a localhost route. Refuse
 * every state-changing request a browser marks as cross-origin, before it
 * reaches Next. Browsers always send `Origin` on a non-GET fetch or form
 * post; `Sec-Fetch-Site` covers the rest. A request with neither is not from
 * a browser page (curl, a server-to-server webhook) and is left to the app's
 * own auth.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sameOriginHost(origin, hostHeader) {
  try {
    const o = new URL(origin);
    if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
    return o.host === new URL(`http://${hostHeader}`).host;
  } catch {
    return false;
  }
}

function isCrossOriginUnsafe(req) {
  if (SAFE_METHODS.has(String(req.method || 'GET').toUpperCase())) return false;
  const headers = req.headers || {};
  const origin = headers.origin;
  if (origin !== undefined) return origin === 'null' || !sameOriginHost(origin, headers.host);
  const site = headers['sec-fetch-site'];
  return site === 'cross-site' || site === 'same-site';
}

/**
 * Next's self-hosted server does not trust the inbound `Host` header for
 * building absolute URLs (it reports itself as whatever HOSTNAME/PORT it was
 * started with — verified live: a redirect came back as
 * `http://localhost:3211/operator-login`, the INTERNAL port, not the one the
 * browser dialed). Standard reverse-proxy fix (the same thing nginx's
 * `proxy_redirect` does): rewrite a `Location` that points at our own
 * upstream back to the Host the client actually used. Matches on PORT alone,
 * not hostname: verified live that Next reports its host as the literal
 * string "localhost" regardless of the HOSTNAME env var it was started with,
 * so also requiring hostname === UPSTREAM_HOST silently never fired.
 * UPSTREAM_PORT is internal-only and never published, so a redirect landing
 * on it is unambiguously ours to rewrite.
 */
function rewriteLocation(location, requestHost) {
  if (!location || !requestHost) return location;
  try {
    const url = new URL(location);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (port === UPSTREAM_PORT) {
      url.protocol = 'http:';
      url.host = requestHost;
      return url.toString();
    }
  } catch {
    // Relative path — nothing to rewrite.
  }
  return location;
}

function createGateServer() {
  return http.createServer((req, res) => {
    // Strip unconditionally first: nothing arriving over the wire may set
    // this header itself. Only this process (never a client, never Next)
    // decides its value, and only after the checks above.
    if (isCrossOriginUnsafe(req)) {
      // Drain the body first, then answer: replying mid-upload makes the
      // client see a reset ("socket hang up") instead of the 403.
      req.on('end', () => {
        res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
        res.end('Cross-origin request refused');
      });
      req.resume();
      return;
    }

    const headers = { ...req.headers };
    delete headers[TRUSTED_HEADER];
    if (verifiedLoopback(req)) headers[TRUSTED_HEADER] = '1';
    // The real peer, never a client-supplied chain: the login throttle keys on
    // it, and a spoofed X-Forwarded-For would give every attempt a fresh key.
    headers['x-forwarded-for'] = req.socket.remoteAddress || '';
    delete headers['x-real-ip'];

    const upstreamReq = http.request(
      { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers },
      (upstreamRes) => {
        const resHeaders = { ...upstreamRes.headers };
        if (resHeaders.location) resHeaders.location = rewriteLocation(resHeaders.location, req.headers.host);
        res.writeHead(upstreamRes.statusCode || 502, resHeaders);
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Upstream unavailable: ${err.message}`);
    });
    req.pipe(upstreamReq);
  });
}

module.exports = { isLoopbackish, isLoopbackHost, verifiedLoopback, isCrossOriginUnsafe, rewriteLocation, defaultRouteGateway, BRIDGE_GATEWAY, TRUSTED_HEADER, createGateServer };

if (require.main === module) {
  createGateServer().listen(PUBLIC_PORT, PUBLIC_HOST, () => {
    console.log(`loopback-gate: listening on ${PUBLIC_HOST}:${PUBLIC_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  });
}
