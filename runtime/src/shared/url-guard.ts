/**
 * Outbound URL guard for tenant-supplied destinations (plugin-tool handlers,
 * outbound webhooks) — v1 gate G5, H-4 interim fix.
 *
 * Inside the gateway container a request from 127.0.0.1 counts as local trust,
 * so a tenant URL that resolves to loopback (or any private / link-local
 * address) could reach the gateway's own operator-only endpoints. We resolve
 * the host and refuse those addresses, and callers fetch with
 * `redirect: 'manual'` so a public URL cannot bounce back inward.
 *
 * Self-hosters whose handlers live on their own LAN opt in with
 * MYAI_ALLOW_PRIVATE_OUTBOUND=1 (restores the old loopback/private behaviour).
 * The full fix (local trust from the local token only) is tracked in the report.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function privateOutboundAllowed(): boolean {
  return process.env.MYAI_ALLOW_PRIVATE_OUTBOUND === '1';
}

function ipv4Blocked(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||           // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224                              // multicast + reserved
  );
}

/** Expand an IPv6 address (any notation, incl. a dotted IPv4 tail) to 8 hextets. */
function ipv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const parts = [...head, ...Array(fill).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  const nums = parts.map((h) => parseInt(h, 16));
  return nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}

/**
 * The IPv4 address an IPv6 address embeds, for the forms that route to it:
 * IPv4-mapped ::ffff:0:0/96, IPv4-compatible ::/96 and NAT64 64:ff9b::/96.
 * Node normalises [::ffff:127.0.0.1] to [::ffff:7f00:1], so a dotted-only
 * check misses it (G5 re-verify RV-3).
 */
function embeddedIpv4(h: number[]): string | null {
  const quad = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  if (h[0] === 0x2002) return quad(h[1], h[2]);                // 6to4 2002::/16
  const zero4 = h.slice(0, 4).every((x) => x === 0);
  const mapped = zero4 && h[4] === 0 && h[5] === 0xffff;
  const translated = zero4 && h[4] === 0xffff && h[5] === 0;   // SIIT ::ffff:0:0/96
  const compat = zero4 && h[4] === 0 && h[5] === 0 && (h[6] !== 0 || h[7] > 1); // not :: or ::1
  const nat64 = h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0);
  if (!mapped && !translated && !compat && !nat64) return null;
  return quad(h[6], h[7]);
}

/** True for loopback, private, link-local, CGNAT, unspecified and reserved addresses. */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ipv4Blocked(ip);
  if (v !== 6) return true;
  const h = ipv6Hextets(ip);
  if (!h) return true;
  const v4 = embeddedIpv4(h);
  if (v4) return ipv4Blocked(v4);
  return (
    h.every((x) => x === 0) ||                          // ::
    (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) || // ::1
    (h[0] & 0xfe00) === 0xfc00 ||                       // fc00::/7 unique-local
    (h[0] & 0xffc0) === 0xfe80 ||                       // fe80::/10 link-local
    (h[0] & 0xffc0) === 0xfec0 ||                       // fec0::/10 site-local (deprecated)
    (h[0] === 0x2001 && h[1] === 0) ||                  // 2001::/32 Teredo (tunnels to an embedded IPv4)
    (h[0] & 0xff00) === 0xff00                          // multicast
  );
}

function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}

/** Sync check for registration time: a literal blocked IP or `localhost`. */
export function isBlockedHostLiteral(hostname: string): boolean {
  const h = bareHost(hostname).toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  return isIP(h) !== 0 && isBlockedAddress(h);
}

/**
 * Resolve the URL's host and throw if any address is blocked. Run immediately
 * before each outbound fetch (DNS can change after registration).
 */
export async function assertPublicDestination(rawUrl: string): Promise<void> {
  if (privateOutboundAllowed()) return;
  const host = bareHost(new URL(rawUrl).hostname);
  if (isBlockedHostLiteral(host)) throw new Error(`destination ${host} is a private or loopback address`);
  if (isIP(host)) return;
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return; // unresolvable: the fetch itself fails
  }
  const bad = addrs.find((a) => isBlockedAddress(a.address));
  if (bad) throw new Error(`destination ${host} resolves to a private or loopback address`);
}
