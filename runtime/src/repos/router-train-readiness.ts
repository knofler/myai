/**
 * router-train-readiness.ts — read-only view of the BRAIN B-7.1 router-training
 * readiness gate for the dashboard /brain panel (task-7fdc970b).
 *
 * scripts/brain_router_train_ready.py counts labeled router-training traces
 * (live route_eval rows with a resolved top-1 + the one-time harvested spike
 * file) against the 500-trace LoRA training floor, and reports the trailing
 * ingestion rate + ETA. Until now that was CLI-only — an operator had to run
 * the script by hand to see progress. This module exposes the same report
 * read-only by shelling out to `brain_router_train_ready.py --json`, mirroring
 * bandit-stats.ts (python3 is already in the gateway image; no SQLite binding
 * in the Node runtime). Never trains, never writes — same posture as the
 * script itself.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'router-train-readiness' });

export interface RouterTrainSources {
  liveRouteEvalLabeled: number;
  harvestedSpikeLabeled: number;
}

export interface RouterTrainIngestion {
  windowDays: number;
  recentLabeled: number;
  perDay: number;
}

export interface RouterTrainReadiness {
  /** false when the repo index DB doesn't exist yet, or the python
   *  shell-out failed — callers should render an empty/explanatory state,
   *  never treat this as "zero traces banked". */
  available: boolean;
  ready: boolean;
  traceCount: number;
  minTracesRequired: number;
  tracesRemaining: number;
  sources: RouterTrainSources;
  ingestion: RouterTrainIngestion;
  /** 0 when ready; null when nothing labeled landed in the window (rate
   *  unknown); else days to the floor at the current ingestion rate. */
  etaDays: number | null;
  estimatedReadyAt: string | null;
  trainingStatus: string;
}

const UNAVAILABLE: RouterTrainReadiness = {
  available: false,
  ready: false,
  traceCount: 0,
  minTracesRequired: 500,
  tracesRemaining: 500,
  sources: { liveRouteEvalLabeled: 0, harvestedSpikeLabeled: 0 },
  ingestion: { windowDays: 0, recentLabeled: 0, perDay: 0 },
  etaDays: null,
  estimatedReadyAt: null,
  trainingStatus: '',
};

interface ReportJson {
  ready: boolean;
  trace_count: number;
  min_traces_required: number;
  traces_remaining: number;
  sources: { live_route_eval_labeled: number; harvested_spike_labeled: number };
  ingestion: { window_days: number; recent_labeled: number; per_day: number };
  eta_days: number | null;
  estimated_ready_at: string | null;
  training_status: string;
}

/** Read the router-training trace-readiness report for this repo. Never
 *  throws — a missing index DB, a python failure, or unparseable output all
 *  degrade to `{available:false}` so a readiness-less dashboard render is the
 *  worst case, never a broken /brain page. Requires the DB to already exist
 *  (the script would create an empty one otherwise — a read surface must not
 *  write). */
export function getRouterTrainReadiness(): RouterTrainReadiness {
  const aiRoot = getConfig().aiRoot;
  const dbPath = join(aiRoot, 'state', '.repo_index.sqlite3');
  const script = join(aiRoot, 'scripts', 'brain_router_train_ready.py');
  if (!existsSync(dbPath) || !existsSync(script)) return UNAVAILABLE;

  const res = spawnSync('python3', [script, '--db', dbPath, '--json'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (res.status !== 0 || !res.stdout) {
    log.warn({ status: res.status, stderr: res.stderr, error: res.error }, 'brain_router_train_ready.py --json failed');
    return UNAVAILABLE;
  }

  try {
    const parsed = JSON.parse(res.stdout) as ReportJson;
    return {
      available: true,
      ready: parsed.ready,
      traceCount: parsed.trace_count,
      minTracesRequired: parsed.min_traces_required,
      tracesRemaining: parsed.traces_remaining,
      sources: {
        liveRouteEvalLabeled: parsed.sources.live_route_eval_labeled,
        harvestedSpikeLabeled: parsed.sources.harvested_spike_labeled,
      },
      ingestion: {
        windowDays: parsed.ingestion.window_days,
        recentLabeled: parsed.ingestion.recent_labeled,
        perDay: parsed.ingestion.per_day,
      },
      etaDays: parsed.eta_days,
      estimatedReadyAt: parsed.estimated_ready_at,
      trainingStatus: parsed.training_status,
    };
  } catch (err) {
    log.warn({ err }, 'brain_router_train_ready.py --json returned unparseable JSON');
    return UNAVAILABLE;
  }
}
