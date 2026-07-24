/**
 * B-9 — client-side metadata obfuscation ("the Cursor pattern", plan §4 B-9).
 *
 * Pure, deterministic helpers that pseudonymise secret-bearing identifiers
 * (file paths, repo/namespace tokens, @mentions, email addresses) in a chunk of
 * text BEFORE it is embedded and upserted to a REMOTE index (Atlas). The reverse
 * `map` is held locally so results retrieved from the store are resolved back to
 * their real names before being returned to the caller.
 *
 * Design goals:
 *   - **Stable** — same (text, salt) always yields the same tokens, so a query
 *     obfuscated with the same salt lands in the same embedding space as the
 *     corpus (recall is preserved).
 *   - **Unlinkable** — a different salt yields different tokens, so two installs
 *     that never share a salt cannot correlate each other's descriptors.
 *   - **Reversible** — `deobfuscateText(obfuscateText(t, s).text, map) === t`.
 *   - **Conservative** — over-obfuscation degrades recall and mangles ordinary
 *     prose, so detection sticks to a handful of clearly-structured identifier
 *     classes. Bare words, shallow generic `a/b` pairs (`and/or`, `TCP/IP`,
 *     `read/write`), and dotted reverse-DNS names are deliberately LEFT ALONE.
 *
 * Nothing here reads config or the network — the salt is supplied by the caller
 * (see `getBrainObfuscation()` in `shared/config.ts`), keeping this module a
 * unit-testable pure function.
 */
import { createHmac } from 'node:crypto';

/**
 * Metadata key under which `storeVector` stashes the reverse token→original map
 * next to a stored vector row, so `searchVectors` can de-obfuscate that row's
 * content on the way out. Reserved (double-underscore) so it never collides with
 * caller-supplied metadata; stripped from results before they are returned.
 */
export const OBFUSCATION_MAP_METADATA_KEY = '__obfMap';

/** Identifier classes we mask. The class name is embedded in the token so a
 *  reader can see WHAT kind of thing was hidden without learning its value. */
type IdentClass = 'path' | 'repo' | 'user' | 'email';

/** Truncated-HMAC length (hex chars). 12 hex = 48 bits — collision-free for any
 *  realistic descriptor, and fixed-length so no token is a substring of another
 *  (which keeps `deobfuscateText`'s replace loop order-independent). */
const HASH_LEN = 12;

// Guillemets (U+2039/U+203A) delimit every token. They never appear in a path,
// repo, handle, or email, so an inserted token is inert to every later pass and
// can never be a substring of the original text.
const TOKEN_OPEN = '‹'; // ‹
const TOKEN_CLOSE = '›'; // ›

// ── Detection patterns (applied in priority order) ─────────
//
// A shared negative lookbehind `(?<![A-Za-z0-9._~@/:-])` prevents a match from
// starting in the middle of an identifier, a path, a URL scheme (`https://…`),
// or right after an `@` — so email/mention/scoped-package passes running first
// fully claim their text before the generic path pass sees what remains.

// RFC-ish email. Highest priority (unambiguous once a TLD is present).
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Scoped package / namespaced handle: `@scope/name` (e.g. `@anthropic-ai/claude`).
// Treated as a repo/namespace token.
const SCOPED_RE = /(?<![A-Za-z0-9._~@/:-])@[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+/g;

// Bare @mention: `@handle`, at least two chars. Runs AFTER email + scoped so it
// only claims genuine standalone mentions.
const MENTION_RE = /(?<![A-Za-z0-9._~@/:-])@[A-Za-z0-9][A-Za-z0-9_-]+/g;

// Anything path/repo-shaped: either a leading `/`, `./`, `../` followed by ≥1
// segment (absolute or explicit-relative path), OR a token with at least one
// internal slash (`a/b`, `a/b/c`, `plan/x.md`). The `classifyPath` step below
// decides whether a match is a real filesystem path, a repo token, or neither.
const PATHISH_RE =
  /(?<![A-Za-z0-9._~@/:-])(?:(?:\.{1,2}\/|\/)[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?|[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)+\/?)/g;

/** A repo/owner segment must start with a letter and carry a "repo-ish" signal
 *  (underscore, hyphen, digit, or a camelCase hump). This is what separates a
 *  real repo like `acme-api` / `dataPipeline` / `web-client` from an ordinary
 *  two-word prose pair like `read/write` or `input/output`. */
function hasRepoSignal(seg: string): boolean {
  return /[_-]/.test(seg) || /[0-9]/.test(seg) || /[a-z][A-Z]/.test(seg);
}

function isRepoPair(a: string, b: string): boolean {
  const alpha = /^[A-Za-z][A-Za-z0-9._-]*$/; // must start with a letter (excludes 24/7, 1/2)
  if (!alpha.test(a) || !alpha.test(b)) return false;
  return hasRepoSignal(a) || hasRepoSignal(b);
}

/**
 * Decide what a slash-bearing token is. Returns the class, or `null` when the
 * token is too ambiguous to mask safely (conservative — leave it in the clear).
 */
function classifyPath(core: string): IdentClass | null {
  const hasLeadingSlash = /^(?:\.{1,2}\/|\/)/.test(core);
  const endsWithSlash = /\/$/.test(core);
  const body = core.replace(/^(?:\.{1,2}\/|\/)/, '').replace(/\/$/, '');
  const segs = body.split('/').filter(Boolean);
  if (segs.length === 0) return null;

  const last = segs[segs.length - 1];
  const hasExt = /[^./]\.[A-Za-z0-9]{1,8}$/.test(last); // name.ext (e.g. obfuscate.ts)

  // Clear filesystem signals → path.
  if (hasLeadingSlash) return 'path';
  if (endsWithSlash) return 'path';
  if (segs.length >= 3) return 'path';
  if (hasExt) return 'path';

  // Exactly two segments, no extension, no leading/trailing slash → only a repo
  // token if it carries a repo-ish signal; otherwise it is likely prose (`and/or`,
  // `TCP/IP`, `runtime/src`) and is left untouched.
  if (segs.length === 2 && isRepoPair(segs[0], segs[1])) return 'repo';
  return null;
}

/**
 * Obfuscate `text`, returning the pseudonymised text plus a reverse map of
 * `{ token: original }` for later de-obfuscation. Deterministic in (text, salt).
 */
export function obfuscateText(text: string, salt: string): { text: string; map: Record<string, string> } {
  const map: Record<string, string> = {};

  const tokenFor = (cls: IdentClass, original: string): string => {
    // Class is folded into the HMAC input so the same literal under two classes
    // (rare) can't collide, and so tokens are self-describing without leaking.
    const digest = createHmac('sha256', salt).update(`${cls}:${original}`).digest('hex').slice(0, HASH_LEN);
    const token = `${TOKEN_OPEN}${cls}:${digest}${TOKEN_CLOSE}`;
    map[token] = original;
    return token;
  };

  let out = text;
  out = out.replace(EMAIL_RE, (m) => tokenFor('email', m));
  out = out.replace(SCOPED_RE, (m) => tokenFor('repo', m));
  out = out.replace(MENTION_RE, (m) => tokenFor('user', m));
  out = out.replace(PATHISH_RE, (m) => {
    // Re-emit a trailing sentence period (`See runtime/src/x.ts.`) instead of
    // swallowing it into the identifier — keeps surrounding prose intact.
    const trail = /\/$/.test(m) ? '' : (m.match(/\.+$/)?.[0] ?? '');
    const core = trail ? m.slice(0, m.length - trail.length) : m;
    const cls = classifyPath(core);
    if (!cls) return m; // ambiguous — leave untouched
    return tokenFor(cls, core) + trail;
  });

  return { text: out, map };
}

/**
 * Reverse `obfuscateText` using its map. Order-independent: originals never
 * contain a token, and all tokens are fixed-length per class so none is a
 * substring of another. `split/join` avoids regex-escaping the token.
 */
export function deobfuscateText(text: string, map: Record<string, string>): string {
  let out = text;
  for (const token of Object.keys(map)) {
    if (out.includes(token)) out = out.split(token).join(map[token]);
  }
  return out;
}
