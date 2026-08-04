/**
 * One-shot Atlas Vector Search index provisioning / verification.
 *
 * The gateway runs the same ensure on every boot (core/index.ts), so this
 * script exists for ops: re-provision after a cluster rebuild WITHOUT waiting
 * for a gateway restart, or verify the live index state. Wrapper for the host:
 * `scripts/atlas_vector_index.sh` (runs this inside the gateway container so
 * no host node is needed and MONGODB_URI comes from the container env).
 *
 *   node dist/scripts/ensure-vector-index.js            # create/repair
 *   node dist/scripts/ensure-vector-index.js --check    # report only, no writes
 *
 * Exit codes: 0 = index ok/created/updated, 1 = failed, 2 = skipped (not Atlas).
 */
import { connectDB, disconnectDB, VectorModel } from '../shared/db.js';
import { detectVectorBackend } from '../memory/vector-index.js';
import {
  ensureAtlasVectorSearchIndex,
  buildVectorSearchIndexDefinition,
  diffVectorSearchIndex,
  type VectorSearchIndexField,
} from '../memory/atlas-search-index.js';
import { atlasVectorIndexName } from '../memory/vector-index.js';

const checkOnly = process.argv.includes('--check');

async function main(): Promise<number> {
  await connectDB();

  if (detectVectorBackend() !== 'atlas') {
    console.log(JSON.stringify({ action: 'skipped', reason: 'backend is local (set VECTOR_BACKEND=atlas or point MONGODB_URI at Atlas)' }));
    return 2;
  }

  if (checkOnly) {
    const name = atlasVectorIndexName();
    const coll = VectorModel.collection;
    const indexes = await coll.listSearchIndexes().toArray() as Array<Record<string, unknown>>;
    const existing = indexes.find(ix => ix.name === name);
    const desired = buildVectorSearchIndexDefinition();
    const liveDef = existing
      ? ((existing.latestDefinition ?? existing.definition) as { fields?: VectorSearchIndexField[] })
      : undefined;
    const problems = existing ? diffVectorSearchIndex(liveDef, desired) : ['index does not exist'];
    console.log(JSON.stringify({
      action: 'check',
      index: name,
      exists: Boolean(existing),
      type: existing?.type ?? null,
      status: existing?.status ?? null,
      queryable: existing?.queryable ?? false,
      problems,
    }, null, 2));
    return problems.length === 0 ? 0 : 1;
  }

  const result = await ensureAtlasVectorSearchIndex();
  console.log(JSON.stringify(result, null, 2));
  return result.action === 'failed' ? 1 : result.action === 'skipped' ? 2 : 0;
}

main()
  .then(async code => { await disconnectDB(); process.exit(code); })
  .catch(async err => {
    console.error('ensure-vector-index failed:', err?.message ?? err);
    await disconnectDB().catch(() => {});
    process.exit(1);
  });
