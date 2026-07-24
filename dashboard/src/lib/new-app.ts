// Pure logic for the "New App" flow (MVP M3 / §7.2 Day 5, seam 4). No DB, no
// network — kept separate from src/app/api/apps/new/route.ts so the
// slugify/validation/task-description rules are unit-testable in isolation.

export const NEW_APP_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type NewAppPriority = (typeof NEW_APP_PRIORITIES)[number];

export function isNewAppPriority(value: unknown): value is NewAppPriority {
  return typeof value === 'string' && (NEW_APP_PRIORITIES as readonly string[]).includes(value);
}

/**
 * Stable, URL-safe repo name from a display name — NO random suffix (unlike
 * slugifyTenantId): a repo name must be predictable so the runner can target it
 * and a re-submit is detected as a duplicate rather than silently forking.
 */
export function slugifyRepoName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || ''
  );
}

const GITHUB_SLUG_RE = /^[\w.-]+\/[\w.-]+$/;

export interface NewAppInput {
  name: string;
  description: string;
  githubSlug: string;
  priority: NewAppPriority;
}

export interface NewAppValidationError {
  error: string;
}

/**
 * Validate + normalize raw request-body fields into a NewAppInput. Returns
 * `{ error }` on the first failing rule (checked in form order), else the
 * clean input with a derived repoName.
 */
export function validateNewAppInput(
  body: Record<string, unknown>,
): { ok: true; input: NewAppInput; repoName: string } | { ok: false; error: NewAppValidationError } {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const githubSlug = typeof body.githubSlug === 'string' ? body.githubSlug.trim() : '';
  const priority: NewAppPriority = isNewAppPriority(body.priority) ? body.priority : 'P2';

  if (!name) return { ok: false, error: { error: 'app name is required' } };
  if (name.length > 80) return { ok: false, error: { error: 'app name too long (max 80)' } };
  if (!description) return { ok: false, error: { error: 'an app description is required' } };
  if (description.length > 2000) return { ok: false, error: { error: 'description too long (max 2000)' } };

  const repoName = slugifyRepoName(name);
  if (!repoName) return { ok: false, error: { error: 'app name must contain letters or numbers' } };
  if (githubSlug && !GITHUB_SLUG_RE.test(githubSlug)) {
    return { ok: false, error: { error: 'GitHub repo must be in owner/repo form' } };
  }

  return { ok: true, input: { name, description, githubSlug, priority }, repoName };
}

/**
 * The scaffold-task description handed to the off-hours runner — carries the
 * idea + explicit agentFlow/`init blueprint` instructions and the tenant's
 * chosen (or blank) GitHub target.
 */
export function buildScaffoldTaskDescription(input: Pick<NewAppInput, 'name' | 'description' | 'githubSlug'>, repoName: string): string {
  return [
    `New app requested from the dashboard: "${input.name}" (repo: ${repoName}).`,
    '',
    'IDEA / SPEC:',
    input.description,
    '',
    input.githubSlug ? `Target GitHub repo: ${input.githubSlug}` : 'No GitHub repo specified — choose a sensible owner/name.',
    '',
    'PIPELINE: scaffold via agentFlow\'s idea→app pipeline / `init blueprint`,',
    'then run Plan → BRD → Gap → TRD → Design → Build per the framework,',
    'committing each stage. Register the live URLs back on this app\'s directory',
    'card when known. Land work on `test` for `ship it` review.',
  ].join('\n');
}
