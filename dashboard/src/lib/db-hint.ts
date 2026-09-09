// db-hint.ts — the operator-facing "database not reachable" line, derived from
// the CONFIGURED connection instead of a hardcoded port.
//
// Five pages (velocity, fleet, revenue, revenue/nrr, apps) used to print
// "needs the gateway Mongo at :27200" on ANY connectDB() failure. The dashboard
// has run against Atlas (mongodb+srv) since the M0 move, so on a transient Atlas
// blip the operator was pointed at a local port that was up and irrelevant
// (2026-09-09). Pure + credential-safe: only the hostname (never user:pass or
// query string) of MONGODB_URI is echoed.
export function dbUnreachableHint(what: string, uri: string | undefined = process.env.MONGODB_URI): string {
  const target = describeMongoTarget(uri);
  const transient = 'Usually transient — retry in a few seconds; if it persists check MONGODB_URI, DNS/network' +
    (target.kind === 'atlas' ? ', and the Atlas IP allowlist.' : ', and that the container is up.');
  return `Database not reachable — ${what} need ${target.label}. ${transient}`;
}

export interface MongoTarget {
  kind: 'atlas' | 'local' | 'unknown';
  label: string;
}

/** Human label for where MONGODB_URI points, with credentials stripped. */
export function describeMongoTarget(uri: string | undefined): MongoTarget {
  if (!uri) return { kind: 'unknown', label: 'a MongoDB (MONGODB_URI is not set)' };
  const srv = uri.startsWith('mongodb+srv://');
  // Reuse the URL parser via an http(s) stand-in scheme; mongodb URIs share the
  // authority grammar (user:pass@host:port). Only host/port are read back.
  let host = '';
  let port = '';
  try {
    const u = new URL(uri.replace(/^mongodb\+srv:\/\//, 'https://').replace(/^mongodb:\/\//, 'http://').split(',')[0]);
    host = u.hostname;
    port = u.port;
  } catch {
    return { kind: 'unknown', label: 'the configured MongoDB (MONGODB_URI could not be parsed)' };
  }
  if (srv) return { kind: 'atlas', label: `the Atlas cluster at ${host}` };
  return { kind: 'local', label: `the MongoDB at ${host}:${port || '27017'}` };
}
