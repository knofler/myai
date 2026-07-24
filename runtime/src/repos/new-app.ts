import { createChildLogger } from '../shared/logger.js';
import { upsertRepoCard } from './app-card-store.js';
import type { RepoCardView } from './app-card-store.js';

const log = createChildLogger({ module: 'new-app' });

// Minimal fetch shape so the module is testable without a live agentFlow and
// without depending on the DOM `fetch` lib types. Only the bits we read.
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  body?: unknown;
}
export type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<FetchResponseLike>;

export interface NewAppInput {
  /** Plain-English app idea — the seed for agentFlow's idea→app pipeline. */
  idea: string;
  /** Optional explicit project/repo name. Defaults to a slug of the idea. */
  name?: string;
  /** Optional directory grouping label for the registered card. */
  group?: string;
  /**
   * When true (default), kick off agentFlow's full auto-run pipeline immediately
   * (idea → ship → codegen). When false, only create the project + register the
   * card so the user can drive stages manually in agentFlow.
   */
  trigger?: boolean;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export interface NewAppResult {
  ok: boolean;
  name: string;
  projectId?: string;
  agentFlowUrl?: string;
  projectUrl?: string;
  pipelineTriggered: boolean;
  card?: RepoCardView | null;
  message: string;
  error?: string;
}

/** Slugify an idea into a safe, short, repo-friendly name. */
export function slugifyIdea(idea: string): string {
  const slug = idea
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 5)
    .join('-');
  return slug || 'new-app';
}

/** Resolve the agentFlow base URL (env-configurable; host bridge by default). */
function agentFlowBaseUrl(): string {
  return (process.env.AGENTFLOW_URL || 'http://host.docker.internal:3000').replace(/\/+$/, '');
}

/**
 * Trigger agentFlow's idea→app pipeline for a new app and register the
 * generated repo in the gateway app-directory.
 *
 * The agentFlow HTTP side (project create + autorun codegen→runner bridge,
 * agentFlow PRs #67/#73) is the integration boundary — its trigger is verified
 * in a companion agentFlow task. Here we (1) create the project, (2) optionally
 * fire the auto-run pipeline (detached — the run streams server-side for
 * minutes; we only confirm dispatch), and (3) always register a directory card
 * so the new app is visible on the dashboard even if agentFlow is unreachable.
 */
export async function createNewApp(tenantId: string, input: NewAppInput): Promise<NewAppResult> {
  const idea = (input.idea || '').trim();
  const name = (input.name || '').trim() || slugifyIdea(idea);
  const trigger = input.trigger ?? true;
  const doFetch = input.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);

  if (!idea) {
    return { ok: false, name, pipelineTriggered: false, message: 'idea is required', error: 'idea is required' };
  }

  const baseUrl = agentFlowBaseUrl();
  const token = process.env.AGENTFLOW_TOKEN || '';
  const description = idea.length > 200 ? `${idea.slice(0, 197)}…` : idea;

  let projectId: string | undefined;
  let projectUrl: string | undefined;
  let pipelineTriggered = false;
  let error: string | undefined;

  // ── 1. Create the agentFlow project ──────────────────────
  if (!doFetch) {
    error = 'fetch unavailable in this runtime';
  } else if (!token) {
    error = 'AGENTFLOW_TOKEN not configured — cannot authenticate to agentFlow';
  } else {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    try {
      const res = await doFetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, description }),
      });
      if (!res.ok) {
        const detail = await safeText(res);
        error = `agentFlow project create failed (${res.status})${detail ? `: ${detail}` : ''}`;
      } else {
        const payload = (await res.json()) as { data?: { _id?: string; id?: string } } | undefined;
        const created = payload?.data;
        projectId = (created?._id || created?.id) as string | undefined;
        if (projectId) projectUrl = `${baseUrl}/projects/${projectId}`;

        // ── 2. Trigger the auto-run pipeline (detached) ────────
        if (projectId && trigger) {
          try {
            const runRes = await doFetch(`${baseUrl}/api/projects/${projectId}/autorun`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ confirm: true }),
            });
            if (runRes.ok) {
              pipelineTriggered = true;
              // The auto-run is a long-lived SSE stream — drain it in the
              // background so the connection completes server-side while we
              // return to the caller now.
              void drainInBackground(runRes);
            } else {
              error = `agentFlow autorun failed (${runRes.status})`;
            }
          } catch (err) {
            error = `agentFlow autorun error: ${(err as Error).message}`;
          }
        }
      }
    } catch (err) {
      error = `agentFlow unreachable at ${baseUrl}: ${(err as Error).message}`;
    }
  }

  // ── 3. Register the directory card (always, best-effort) ──
  const level = error ? 'warn' : (pipelineTriggered ? 'ok' : 'unknown');
  const status = error
    ? `New app queued — agentFlow trigger failed: ${error}`
    : pipelineTriggered
      ? 'Generating via agentFlow idea→app pipeline'
      : projectId
        ? 'agentFlow project created — awaiting manual stage run'
        : 'New app registered (agentFlow trigger skipped)';

  let card: RepoCardView | null = null;
  try {
    card = await upsertRepoCard(tenantId, {
      repoName: name,
      description,
      group: input.group || 'Generated',
      appUrl: projectUrl,
      localhostUrl: projectUrl,
      lastStatus: status,
      lastStatusLevel: level,
      reportedBy: 'myai new-app',
    });
  } catch (err) {
    log.warn({ err, name }, 'Failed to register new-app directory card');
  }

  log.info({ name, projectId, pipelineTriggered, error }, 'new-app processed');

  return {
    ok: !error && Boolean(projectId),
    name,
    projectId,
    agentFlowUrl: baseUrl,
    projectUrl,
    pipelineTriggered,
    card,
    message: status,
    error,
  };
}

async function safeText(res: FetchResponseLike): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return '';
  }
}

/** Consume (and discard) a streamed response body in the background. */
async function drainInBackground(res: FetchResponseLike): Promise<void> {
  try {
    await res.text();
  } catch (err) {
    log.debug({ err }, 'autorun stream drain ended');
  }
}
