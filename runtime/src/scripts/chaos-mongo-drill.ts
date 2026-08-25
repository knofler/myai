/**
 * chaos-mongo-drill.ts — the actual behavioral assertion behind
 * scripts/chaos_mongo_drill.sh (gateway resilience chaos task, on the pattern
 * of atlas-failover-drill.ts / ADR-036 §5: a scheduled, unattended proof that
 * a documented recovery property actually holds, not just a hypothesis).
 *
 * The property under test is the reliability half of the autonomous claim:
 * if MongoDB dies (SIGKILL — a crash, not a clean shutdown) while a runner
 * task is in-flight, the gateway's task queue must come back consistent —
 * the task is neither lost nor double-executed, and the same gateway process
 * reconnects on its own (no restart). Exercises the REAL task-store code
 * paths (createTask/claimTask/updateTask/listTasks/countTasks — the exact
 * functions behind the runner's `mcp tasks_claim` / `tasks_update` calls)
 * against a real mongod (never mocked), in four phases:
 *
 *   Phase 1 — in-flight: seed one pending task, claim it as runner-A
 *   (pending→working, atomic findOneAndUpdate). fsync so the claim is
 *   crash-durable, then SIGKILL the mongod container mid-task.
 *
 *   Phase 2 — outage: with the task in-flight and Mongo dead, an in-flight
 *   completion write (runner-A) and a concurrent claim poll (runner-B) must
 *   both surface an ERROR — never a silent success and never a silent
 *   "queue empty" (the false-healthy-queue failure mode).
 *
 *   Phase 3 — recovery: restart the same container (crash recovery from the
 *   WiredTiger journal). Assert the SAME mongoose connection heals itself
 *   within the window — then: the task still exists, still 'working', still
 *   claimed by runner-A with a clean retry ledger (a DB outage is not a task
 *   failure); runner-B's claim returns null (the working task is not
 *   re-claimable — no double execution); runner-A's retried completion
 *   succeeds.
 *
 *   Phase 4 — queue consistency: exactly one task exists for the drill
 *   tenant, its status counts sum to one, and its final state is 'review'
 *   with retryCount 0 — nothing lost, nothing duplicated, ledger untouched.
 *
 * Never touches the shared myai-gateway/myai-mongo stack (DEPLOY GUARD) —
 * MONGODB_URI and CHAOS_MONGO_CONTAINER point at a throwaway container the
 * wrapper script owns and tears down.
 *
 * Env (set by the wrapper):
 *   MONGODB_URI / MONGODB_NAME   the throwaway mongod
 *   CHAOS_MONGO_CONTAINER        its container name (this script kills/starts it)
 *   CHAOS_DOCKER_BIN             docker binary (default 'docker'; tests stub it)
 *   CHAOS_RECONNECT_TIMEOUT_MS   reconnect assertion window (default 60000)
 *
 * Exit 0 = all phases passed. Exit 1 = a phase failed its assertions or the
 * script errored. Prints one JSON line per phase plus a final result line.
 */
import { execFileSync } from 'node:child_process';
import mongoose from 'mongoose';
import { setConfig } from '../shared/config.js';
import { connectDB, disconnectDB } from '../shared/db.js';
import type { GatewayConfig } from '../shared/types.js';
import {
  createTask,
  claimTask,
  updateTask,
  getTask,
  listTasks,
  countTasks,
} from '../tasks/task-store.js';

const TENANT = 'chaos-mongo-drill';
const REPO = 'chaos-drill-repo';
const RUNNER_A = 'chaos-runner-a/slot-0';
const RUNNER_B = 'chaos-runner-b/slot-0';

const DOCKER_BIN = process.env.CHAOS_DOCKER_BIN || 'docker';
const CONTAINER = process.env.CHAOS_MONGO_CONTAINER || '';
const RECONNECT_TIMEOUT_MS = Number(process.env.CHAOS_RECONNECT_TIMEOUT_MS || 60_000);

function docker(...args: string[]): void {
  execFileSync(DOCKER_BIN, args, { stdio: 'ignore' });
}

function reloadConfig(): void {
  setConfig(null as unknown as GatewayConfig);
}

interface PhaseResult {
  phase: 'in-flight' | 'outage' | 'recovery' | 'consistency';
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

function check(checks: PhaseResult['checks'], name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Run an op expecting it to reject; returns the error (or null on silent success). */
async function expectError(op: () => Promise<unknown>): Promise<Error | null> {
  try {
    await op();
    return null;
  } catch (err) {
    return err as Error;
  }
}

async function runInFlightPhase(): Promise<{ result: PhaseResult; taskId: string }> {
  const checks: PhaseResult['checks'] = [];
  reloadConfig();
  await connectDB();

  const created = await createTask(TENANT, {
    repo: REPO,
    title: 'chaos drill — in-flight task',
    description: 'seeded by chaos-mongo-drill.ts; lives only in the throwaway mongod',
    priority: 'P2',
    source: 'manual',
  });
  check(checks, 'seed task created pending', created.status === 'pending', created.taskId);

  const claimed = await claimTask(TENANT, { claimedBy: RUNNER_A });
  check(checks, 'runner-A claims the task (pending→working)', claimed?.taskId === created.taskId);
  check(checks, 'claim is attributed to runner-A', claimed?.claimedBy === RUNNER_A, claimed?.claimedBy);
  check(checks, 'claimed task is working', claimed?.status === 'working', claimed?.status);

  // Make the claim crash-durable before we SIGKILL mongod: WiredTiger groups
  // journal commits (~100ms window), so an immediate kill could legitimately
  // lose the very last write — that would test journal timing, not the queue.
  await mongoose.connection.db?.admin().command({ fsync: 1 });

  return { result: { phase: 'in-flight', ok: checks.every(c => c.ok), checks }, taskId: created.taskId };
}

async function runOutagePhase(taskId: string): Promise<PhaseResult> {
  const checks: PhaseResult['checks'] = [];

  docker('kill', CONTAINER); // SIGKILL — a crash mid-task, not a clean shutdown

  // In-flight completion by runner-A must surface an error, never a silent
  // success (the write has nowhere durable to land).
  const completeErr = await expectError(() =>
    updateTask(TENANT, { taskId, status: 'review', notes: 'attempted mid-outage — must fail' }),
  );
  check(checks, 'in-flight completion during outage surfaces an error', completeErr !== null, completeErr?.message);

  // Concurrent claim poll by runner-B must ALSO error — a null here would read
  // to the runner as "queue empty" (the false-healthy-queue failure mode).
  const claimErr = await expectError(() => claimTask(TENANT, { claimedBy: RUNNER_B }));
  check(checks, 'claim poll during outage errors (never a silent empty queue)', claimErr !== null, claimErr?.message);

  return { phase: 'outage', ok: checks.every(c => c.ok), checks };
}

async function runRecoveryPhase(taskId: string): Promise<PhaseResult> {
  const checks: PhaseResult['checks'] = [];

  docker('start', CONTAINER); // same container, same data — crash recovery from the journal

  // The SAME mongoose connection must heal itself — no disconnect/reconnect
  // call, no process restart. Poll a real task-store read until it succeeds.
  const startedAt = Date.now();
  let recovered: Awaited<ReturnType<typeof getTask>> = null;
  let reconnected = false;
  while (Date.now() - startedAt < RECONNECT_TIMEOUT_MS) {
    try {
      recovered = await getTask(TENANT, taskId);
      reconnected = true;
      break;
    } catch {
      await sleep(1000);
    }
  }
  const elapsedMs = Date.now() - startedAt;
  check(checks, 'gateway connection reconnects without a restart', reconnected, `${elapsedMs}ms`);

  check(checks, 'task survived the crash (not lost)', recovered !== null);
  check(checks, 'task is still working (claim preserved)', recovered?.status === 'working', recovered?.status);
  check(checks, 'task is still claimed by runner-A', recovered?.claimedBy === RUNNER_A, recovered?.claimedBy);
  check(
    checks,
    'retry ledger untouched (a DB outage is not a task failure)',
    recovered?.retryCount === 0,
    String(recovered?.retryCount),
  );

  // No double execution: the task is 'working' under a live lease, so a fresh
  // claim poll finds nothing pending — runner-B cannot pick the same task up.
  const second = await claimTask(TENANT, { claimedBy: RUNNER_B });
  check(checks, 'no double execution — second claim finds nothing', second === null, second?.taskId);

  // Runner-A retries its completion after the outage — succeeds exactly once.
  const done = await updateTask(TENANT, { taskId, status: 'review', notes: 'completed after mongo crash recovery' });
  check(checks, 'runner-A completion succeeds after reconnect', done?.status === 'review', done?.status);

  return { phase: 'recovery', ok: checks.every(c => c.ok), checks };
}

async function runConsistencyPhase(taskId: string): Promise<PhaseResult> {
  const checks: PhaseResult['checks'] = [];

  const all = await listTasks(TENANT, {});
  check(checks, 'exactly one task exists (nothing lost, nothing duplicated)', all.length === 1, String(all.length));
  check(checks, 'the surviving task is the seeded one', all[0]?.taskId === taskId, all[0]?.taskId);

  const counts = await countTasks(TENANT);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  check(checks, 'status counts sum to one', total === 1, JSON.stringify(counts));
  check(checks, 'final status is review (completed exactly once)', counts.review === 1, JSON.stringify(counts));

  const final = await getTask(TENANT, taskId);
  check(checks, 'final retry ledger is clean', final?.retryCount === 0, String(final?.retryCount));

  return { phase: 'consistency', ok: checks.every(c => c.ok), checks };
}

async function main(): Promise<number> {
  if (!CONTAINER) {
    console.log(JSON.stringify({ fatal: 'CHAOS_MONGO_CONTAINER must be set (the wrapper owns the throwaway mongod)' }));
    return 1;
  }
  const results: PhaseResult[] = [];
  try {
    const { result: inFlight, taskId } = await runInFlightPhase();
    results.push(inFlight);
    results.push(await runOutagePhase(taskId));
    results.push(await runRecoveryPhase(taskId));
    results.push(await runConsistencyPhase(taskId));
  } catch (err) {
    for (const r of results) console.log(JSON.stringify(r));
    console.log(JSON.stringify({ fatal: (err as Error).message }));
    return 1;
  }

  for (const r of results) console.log(JSON.stringify(r));
  const allOk = results.every(r => r.ok);
  console.log(JSON.stringify({ result: allOk ? 'PASS' : 'FAIL' }));
  return allOk ? 0 : 1;
}

main()
  .then(async code => {
    await disconnectDB().catch(() => {});
    process.exit(code);
  })
  .catch(async err => {
    console.error('chaos-mongo-drill failed:', err?.message ?? err);
    await disconnectDB().catch(() => {});
    process.exit(1);
  });
