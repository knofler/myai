import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getAgent, listAgents } from './loader.js';
import { executeAgent } from './runtime.js';
import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';
import type { AgentExecuteOptions } from './runtime.js';

const log = createChildLogger({ module: 'agent-pipeline' });

/**
 * In-gateway 8-stage generation pipeline (MYAI_GATEWAY Phase 6).
 *
 * Wraps the existing project-generation pipeline (see `mcp/src/generate.ts`
 * and `config/generation-stages.json`) so the gateway can run it end-to-end
 * through the agent runtime: idea → plan → brd → gap-analysis → trd →
 * design → build → ship, each stage executed by the mapped specialist agent
 * with the previous stage's output carried forward as context.
 */

export interface PipelineStageDef {
  id: string;
  name: string;
  description: string;
  instructions: string;
}

export interface StageResult {
  stageId: string;
  stageName: string;
  agentName: string;
  output: string;
  executed: boolean;
  durationMs: number;
}

export interface PipelineRunResult {
  idea: string;
  stages: StageResult[];
  completed: string[];
  failed?: { stage: string; error: string };
  durationMs: number;
}

/** Which specialist runs each stage. Falls back per `resolveStageAgent`. */
export const STAGE_AGENTS: Record<string, string> = {
  idea: 'product-manager',
  plan: 'project-manager',
  brd: 'tech-ba',
  'gap-analysis': 'tech-ba',
  trd: 'solution-architect',
  design: 'ui-ux-specialist',
  build: 'tech-lead',
  ship: 'devops-specialist',
};

/** Minimal built-in stage list used when generation-stages.json is unreadable. */
const FALLBACK_STAGES: PipelineStageDef[] = [
  { id: 'idea', name: 'Idea Refinement', description: 'Refine the raw idea into a structured concept', instructions: 'Produce a structured Idea Document: project name, one-line pitch, problem statement, target audience, value proposition, core features, tech stack recommendation, success metrics, risks.' },
  { id: 'plan', name: 'Project Plan', description: 'Detailed project plan with milestones and phases', instructions: 'Create a Project Plan: overview, architecture, phase breakdown with tasks, data model, API endpoints, frontend pages, infrastructure, testing strategy, MVP scope.' },
  { id: 'brd', name: 'Business Requirements Document', description: 'Formal BRD with functional and non-functional requirements', instructions: 'Produce a BRD: executive summary, business objectives, scope, functional requirements (FR-###), non-functional requirements (NFR-###), user stories, data requirements, constraints.' },
  { id: 'gap-analysis', name: 'Gap Analysis', description: 'Gaps between requirements and plan, with mitigations', instructions: 'Perform a gap analysis: requirements coverage matrix, identified gaps, technical risks with mitigations, security gaps, recommendations, updated scope.' },
  { id: 'trd', name: 'Technical Requirements Document', description: 'Technical specification with architecture, schemas, API contracts', instructions: 'Produce a TRD: system architecture, technology stack, database schema, API specification, auth flow, frontend architecture, infrastructure, error handling, monitoring.' },
  { id: 'design', name: 'Design Specification', description: 'UI/UX design spec with component library and layouts', instructions: 'Produce a Design Spec: design system (colors, typography, spacing), component library, page layouts, navigation flow, forms, accessibility checklist, dark/light mode.' },
  { id: 'build', name: 'Build Specification', description: 'Implementation guide with file structure and build order', instructions: 'Produce a Build Spec: project scaffolding, build order, key implementation files, testing plan, deployment checklist, post-launch steps.' },
  { id: 'ship', name: 'Ship Plan', description: 'Deployment plan and go-live strategy', instructions: 'Produce a Ship Plan: pre-launch checklist, deployment steps, monitoring setup, rollback plan, post-launch verification, launch communication.' },
];

/**
 * Load stage definitions from `<aiRoot>/config/generation-stages.json`
 * (the same file the MCP generate tool uses). Built-in fallback when the
 * file is missing or malformed.
 */
export function loadStages(): PipelineStageDef[] {
  const config = getConfig();
  const stagesFile = join(config.aiRoot, 'config', 'generation-stages.json');
  try {
    if (existsSync(stagesFile)) {
      const parsed = JSON.parse(readFileSync(stagesFile, 'utf-8')) as { stages?: PipelineStageDef[] };
      if (Array.isArray(parsed.stages) && parsed.stages.length > 0) {
        return parsed.stages;
      }
    }
  } catch (err) {
    log.warn({ err, stagesFile }, 'Failed to read generation-stages.json — using built-in stages');
  }
  return FALLBACK_STAGES;
}

/**
 * Resolve the agent for a stage: the mapped specialist if loaded, else
 * solution-architect, else the first loaded agent. Throws when no agents
 * are loaded at all.
 */
export function resolveStageAgent(stageId: string): string {
  const mapped = STAGE_AGENTS[stageId];
  if (mapped && getAgent(mapped)) return mapped;
  if (getAgent('solution-architect')) return 'solution-architect';
  const all = listAgents();
  if (all.length === 0) throw new Error('No agents loaded — cannot run generation pipeline');
  return all[0].name;
}

export interface PipelineOptions {
  /** Start from this stage id (inclusive). */
  fromStage?: string;
  /** Stop after this stage id (inclusive). */
  toStage?: string;
  /** Called after each stage completes (progress reporting). */
  onStage?: (result: StageResult) => void;
  /** Max chars of the previous stage's output carried into the next prompt. */
  carryChars?: number;
  /** Forwarded to each stage's executeAgent call. */
  executeOptions?: AgentExecuteOptions;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + '\n…(truncated)' : text;
}

/**
 * Run the generation pipeline for a project idea. Stages run sequentially;
 * each stage's task embeds the idea plus the previous stage's (truncated)
 * output. A stage failure stops the pipeline and is reported in `failed`.
 */
export async function runPipeline(idea: string, opts: PipelineOptions = {}): Promise<PipelineRunResult> {
  const allStages = loadStages();
  const carryChars = opts.carryChars ?? 8000;

  let fromIdx = opts.fromStage ? allStages.findIndex(s => s.id === opts.fromStage) : 0;
  let toIdx = opts.toStage ? allStages.findIndex(s => s.id === opts.toStage) : allStages.length - 1;
  if (fromIdx < 0) throw new Error(`Unknown pipeline stage: ${opts.fromStage}`);
  if (toIdx < 0) throw new Error(`Unknown pipeline stage: ${opts.toStage}`);
  if (fromIdx > toIdx) throw new Error(`fromStage "${opts.fromStage}" comes after toStage "${opts.toStage}"`);

  const stages = allStages.slice(fromIdx, toIdx + 1);
  const started = Date.now();
  const results: StageResult[] = [];
  let previous: StageResult | undefined;
  let failed: { stage: string; error: string } | undefined;

  log.info({ stageCount: stages.length, from: stages[0]?.id, to: stages[stages.length - 1]?.id }, 'Pipeline run started');

  for (const stage of stages) {
    const agentName = resolveStageAgent(stage.id);
    const taskParts = [
      `## Generation pipeline — stage: ${stage.name} (${stage.id})`,
      stage.description,
      '',
      stage.instructions,
      '',
      '## Project idea',
      idea,
    ];
    if (previous) {
      taskParts.push('', `## Previous stage output (${previous.stageId})`, truncate(previous.output, carryChars));
    }

    const stageStarted = Date.now();
    try {
      const run = await executeAgent(agentName, taskParts.join('\n'), {
        ...opts.executeOptions,
        metadata: { pipelineStage: stage.id, ...(opts.executeOptions?.metadata ?? {}) },
      });
      const stageResult: StageResult = {
        stageId: stage.id,
        stageName: stage.name,
        agentName,
        output: run.output,
        executed: run.executed,
        durationMs: Date.now() - stageStarted,
      };
      results.push(stageResult);
      previous = stageResult;
      opts.onStage?.(stageResult);
      log.info({ stage: stage.id, agentName, executed: run.executed, durationMs: stageResult.durationMs }, 'Pipeline stage complete');
    } catch (err) {
      failed = { stage: stage.id, error: (err as Error).message };
      log.error({ err, stage: stage.id, agentName }, 'Pipeline stage failed — stopping');
      break;
    }
  }

  return {
    idea,
    stages: results,
    completed: results.map(r => r.stageId),
    failed,
    durationMs: Date.now() - started,
  };
}
