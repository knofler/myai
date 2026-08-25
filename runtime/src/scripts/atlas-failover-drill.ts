/**
 * atlas-failover-drill.ts — the actual behavioral assertion behind
 * scripts/atlas_failover_drill.sh (Atlas resilience task, on the pattern of
 * ADR-036 §5's restore drill: a scheduled, unattended proof that a
 * documented recovery mechanism actually works, not just a hypothesis).
 *
 * Exercises the REAL connectDB()/db-failover.ts code path end to end against
 * real MongoDB processes (never mocked) in two phases:
 *
 *   Phase 1 — outage: point MONGODB_URI at a deliberately unreachable host
 *   (the wrapper uses a TEST-NET-1 address, RFC 5737 — guaranteed to time
 *   out, never a real service) with MYAI_DB_FAILOVER=local and
 *   MYAI_DB_FAILOVER_URI pointed at a throwaway mongod (the wrapper's
 *   "mirror"). Asserts: connectDB() does NOT throw (degrades, doesn't
 *   error), getDbFailoverState().active is true, a read succeeds, and a
 *   write is rejected with DbReadOnlyError.
 *
 *   Phase 2 — recovery: point MONGODB_URI at a reachable mongod (the
 *   wrapper's DRILL_RECOVERY_URI — simulating "the primary came back").
 *   Asserts: connectDB() connects directly, getDbFailoverState().active is
 *   false, and writes succeed again.
 *
 * Never touches the shared myai-gateway/myai-mongo stack (DEPLOY GUARD) —
 * every URI here points at throwaway containers the wrapper script owns.
 *
 * Exit 0 = both phases passed. Exit 1 = a phase failed its assertions or the
 * script errored. Prints one JSON line per phase plus a final result line.
 */
import { setConfig } from '../shared/config.js';
import { connectDB, disconnectDB, TenantModel } from '../shared/db.js';
import { getDbFailoverState, resetDbFailover, DbReadOnlyError } from '../shared/db-failover.js';
import type { GatewayConfig } from '../shared/types.js';

function reloadConfig(): void {
  setConfig(null as unknown as GatewayConfig);
}

interface PhaseResult {
  phase: 'outage' | 'recovery';
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

function check(checks: PhaseResult['checks'], name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
}

async function attemptDrillWrite(): Promise<{ rejected: boolean; error?: string }> {
  try {
    await TenantModel.updateOne({ tenantId: '__atlas-failover-drill__' }, { $set: { note: 'drill' } });
    return { rejected: false };
  } catch (err) {
    if (err instanceof DbReadOnlyError) return { rejected: true, error: err.message };
    throw err; // an unexpected error is a real bug, not the guard working — surface it
  }
}

async function runOutagePhase(): Promise<PhaseResult> {
  const checks: PhaseResult['checks'] = [];
  const primaryUri = process.env.MONGODB_URI;
  const mirrorUri = process.env.MYAI_DB_FAILOVER_URI;
  if (!primaryUri || !mirrorUri) throw new Error('MONGODB_URI and MYAI_DB_FAILOVER_URI must be set for the outage phase');

  reloadConfig();
  resetDbFailover();

  let connectThrew = false;
  try {
    await connectDB();
  } catch (err) {
    connectThrew = true;
    check(checks, 'connectDB does not throw when failing over', false, (err as Error).message);
  }
  if (!connectThrew) check(checks, 'connectDB does not throw when failing over', true);

  const state = getDbFailoverState();
  check(checks, 'failover state is active', state.active === true, JSON.stringify(state));
  check(checks, 'failover mode is local', state.mode === 'local');

  try {
    await TenantModel.findOne({ tenantId: '__atlas-failover-drill__' });
    check(checks, 'reads succeed while in failover', true);
  } catch (err) {
    check(checks, 'reads succeed while in failover', false, (err as Error).message);
  }

  const write = await attemptDrillWrite();
  check(checks, 'writes are rejected while in failover', write.rejected === true, write.error);

  await disconnectDB();
  return { phase: 'outage', ok: checks.every(c => c.ok), checks };
}

async function runRecoveryPhase(): Promise<PhaseResult> {
  const checks: PhaseResult['checks'] = [];
  const recoveryUri = process.env.DRILL_RECOVERY_URI;
  if (!recoveryUri) throw new Error('DRILL_RECOVERY_URI must be set for the recovery phase');

  resetDbFailover();
  process.env.MONGODB_URI = recoveryUri;
  reloadConfig();

  try {
    await connectDB();
    check(checks, 'connectDB connects directly once primary is reachable', true);
  } catch (err) {
    check(checks, 'connectDB connects directly once primary is reachable', false, (err as Error).message);
  }

  const state = getDbFailoverState();
  check(checks, 'failover state is inactive (recovered)', state.active === false, JSON.stringify(state));

  const write = await attemptDrillWrite();
  check(checks, 'writes succeed again once recovered', write.rejected === false, write.error);

  await disconnectDB();
  return { phase: 'recovery', ok: checks.every(c => c.ok), checks };
}

async function main(): Promise<number> {
  const results: PhaseResult[] = [];
  try {
    results.push(await runOutagePhase());
    results.push(await runRecoveryPhase());
  } catch (err) {
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
    console.error('atlas-failover-drill failed:', err?.message ?? err);
    await disconnectDB().catch(() => {});
    process.exit(1);
  });
