/**
 * bandit-stats.ts — read-only view of retrieval_bandit's currently favored
 * arm per query context (BRAIN B-7 follow-up, task-49fda69b).
 *
 * scripts/brain_route.py reads scripts/retrieval_bandit.py's `bandit_arms`
 * table (scripts/lib/repo_index_schema.py) to pick the live retrieval config
 * (k, rerank_on) per query context — that wiring shipped in commit 49a99aa,
 * but it was CLI/scripts-only: no operator-visible surface showed which arm
 * the bandit favors or its recent reward trend. This module exposes the same
 * table read-only for the dashboard's /brain view by shelling out to
 * `retrieval_bandit.py --db <path> --summary` (bandit_snapshot() — never
 * mutates bandit_arms, unlike the offline replay_tune() pass), mirroring the
 * python3-already-in-the-gateway-image pattern (brain_token_eval.py, see
 * runtime/Dockerfile) rather than adding a SQLite binding to the Node runtime.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'bandit-stats' });

export interface BanditArmStat {
  arm: string;
  k: number;
  rerankOn: boolean;
  pulls: number;
  rewardSum: number;
  meanReward: number;
}

export interface BanditFavoredArm {
  k: number;
  rerank_on: boolean;
}

export interface BanditContextStat {
  context: string;
  favoredArm: BanditFavoredArm | null;
  pullsTotal: number;
  arms: BanditArmStat[];
}

export interface BanditStats {
  /** false when the repo index DB doesn't exist yet, or the python
   *  shell-out failed — callers should render an empty/explanatory state,
   *  never treat this as "bandit favors nothing everywhere". */
  available: boolean;
  totalPulls: number;
  contexts: BanditContextStat[];
}

const UNAVAILABLE: BanditStats = { available: false, totalPulls: 0, contexts: [] };

interface SnapshotJson {
  total_pulls: number;
  contexts: Array<{
    context: string;
    favored_arm: BanditFavoredArm | null;
    pulls_total: number;
    arms: Array<{ arm: string; k: number; rerank_on: boolean; pulls: number; reward_sum: number; mean_reward: number }>;
  }>;
}

/** Read the live retrieval_bandit state for this repo. Never throws — a
 *  missing index DB, a python failure, or unparseable output all degrade to
 *  `{available:false}` so a stats-less dashboard render is the worst case,
 *  never a broken /brain page. */
export function getBanditStats(): BanditStats {
  const aiRoot = getConfig().aiRoot;
  const dbPath = join(aiRoot, 'state', '.repo_index.sqlite3');
  const script = join(aiRoot, 'scripts', 'retrieval_bandit.py');
  if (!existsSync(dbPath) || !existsSync(script)) return UNAVAILABLE;

  const res = spawnSync('python3', [script, '--db', dbPath, '--summary'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (res.status !== 0 || !res.stdout) {
    log.warn({ status: res.status, stderr: res.stderr, error: res.error }, 'retrieval_bandit.py --summary failed');
    return UNAVAILABLE;
  }

  try {
    const parsed = JSON.parse(res.stdout) as SnapshotJson;
    return {
      available: true,
      totalPulls: parsed.total_pulls,
      contexts: parsed.contexts.map((c) => ({
        context: c.context,
        favoredArm: c.favored_arm,
        pullsTotal: c.pulls_total,
        arms: c.arms.map((a) => ({
          arm: a.arm,
          k: a.k,
          rerankOn: a.rerank_on,
          pulls: a.pulls,
          rewardSum: a.reward_sum,
          meanReward: a.mean_reward,
        })),
      })),
    };
  } catch (err) {
    log.warn({ err }, 'retrieval_bandit.py --summary returned unparseable JSON');
    return UNAVAILABLE;
  }
}
