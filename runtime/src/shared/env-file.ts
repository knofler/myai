/**
 * Minimal .env upsert helper used by `myai rotate-keys local` to persist a
 * rotated GATEWAY_LOCAL_TOKEN so a restart doesn't revert the running
 * process's in-memory rotation (core/local-token.ts). Preserves every line
 * it doesn't touch — comments, blank lines, unrelated vars, formatting.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/**
 * Upsert KEY=VALUE lines in the .env file at `path`. A var mapped to
 * `undefined` is removed (line dropped) rather than written empty. Creates
 * the file if it doesn't exist. Keys not present in `vars` are left
 * untouched.
 */
export function upsertEnvVars(path: string, vars: Record<string, string | undefined>): void {
  const existingLines = existsSync(path) ? readFileSync(path, 'utf-8').split('\n') : [];
  const lines = existingLines.filter((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match) return true; // comment / blank / malformed — keep as-is
    const key = match[1];
    // Drop the old line for any key we're touching — set keys get a fresh
    // line appended below, unset keys are simply gone.
    return !(key in vars);
  });

  // Trim a single trailing blank line so appends don't accumulate blank runs.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) continue;
    lines.push(`${key}=${value}`);
  }

  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
}
