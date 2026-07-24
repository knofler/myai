/**
 * Shared secret-shaped-string redaction, used by both Sentry event scrubbing
 * (monitoring/sentry.ts) and the structured request-log store
 * (monitoring/log-store.ts) so the two log surfaces can't drift on what
 * counts as a secret.
 */

/** Header names that may carry credentials — stripped entirely from logs/events. */
export const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-myai-key',
  'x-tenant-key',
  'proxy-authorization',
]);

/**
 * Patterns for secret-shaped values found anywhere in a log/event tree. Each is
 * matched against string values (not keys) and the whole match is redacted on
 * a hit — better to lose a stack frame/log field than leak a live credential.
 */
export const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9-]{16,}/, // Anthropic / OpenAI style API keys
  /https?:\/\/[^@\s]+@[^\s]+/, // DSNs / URLs with embedded credentials
  /mongodb(?:\+srv)?:\/\/[^\s]+/, // Mongo connection strings
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+/, // JWTs
  /(?:AKIA|ASIA)[A-Z0-9]{16}/, // AWS access key ids
  /myai_(?:live|test)_[0-9A-Za-z]{16,}/, // myai tenant/scoped API keys
];

const REDACTED = '[redacted]';

/** Redact every secret-shaped substring inside a single string value. */
export function redactString(value: string): string {
  let out = value;
  for (const pat of SECRET_VALUE_PATTERNS) {
    out = out.replace(new RegExp(pat.source, 'g'), REDACTED);
  }
  return out;
}

/** Recursively redact secret-shaped strings inside an arbitrary value. */
export function deepRedact(value: unknown, depth = 0): unknown {
  if (depth > 6) return value; // guard against cyclic / very deep trees
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_HEADERS.has(k.toLowerCase())) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = deepRedact(v, depth + 1);
    }
    return out;
  }
  return value;
}
