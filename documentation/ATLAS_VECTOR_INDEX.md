# Atlas Vector Search Index — `vector_index` on `vectors`

The RAG retrieval path (`memory_search` / `recall_session` MCP tools →
`searchVectors` in `runtime/src/memory/vector-store.ts`) runs server-side ANN
via the Atlas `$vectorSearch` aggregation stage whenever the gateway's
`MONGODB_URI` points at Atlas. That stage depends on an **Atlas Search index of
type `vectorSearch`** existing on the `vectors` collection — and a missing or
misconfigured index returns `[]` **without throwing**, which is exactly how
recall silently died before PR #390 (fallback) and PR for task-b875cf92 (this
provisioning).

## The canonical definition

One index, named `vector_index` (override: `VECTOR_SEARCH_INDEX`), on
collection `vectors`:

```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 384, "similarity": "cosine" },
    { "type": "filter", "path": "tenantId" },
    { "type": "filter", "path": "repo" },
    { "type": "filter", "path": "source" },
    { "type": "filter", "path": "tags" },
    { "type": "filter", "path": "createdAt" }
  ]
}
```

Why each piece matters:

- **384 dims, cosine** — embeddings come from the local MiniLM provider
  (`all-MiniLM-L6-v2`, normalized, `config.memory.embedding.dimensions = 384`).
  A dims mismatch makes every query return empty.
- **`tenantId` as a `filter` field** — tenant isolation is pinned in the
  `$vectorSearch.filter` PRE-filter (ADR-010 §1.5 #3). Atlas only allows
  filtering on paths registered as `filter` fields; an index without `tenantId`
  makes every tenant-scoped query return zero rows.
- The remaining filter paths mirror everything
  `buildAtlasVectorSearchPipeline` (`runtime/src/memory/vector-index.ts`) may
  pin: `repo`, `source`, `tags` (`$in`), `createdAt` (`$gte`).

The definition lives in code as the single source of truth:
`buildVectorSearchIndexDefinition()` in
`runtime/src/memory/atlas-search-index.ts`.

## How it's provisioned (survives cluster rebuilds)

1. **Boot-time self-heal (primary).** On every gateway start,
   `ensureAtlasVectorSearchIndex()` runs (see `core/index.ts`): creates the
   index if missing, repairs the definition in place (`updateSearchIndex`) if
   it drifted (wrong dims, missing filter field), and drops+recreates if a
   same-named index has the wrong type (`search` vs `vectorSearch`). No-op on
   local mongo; non-fatal always.
2. **Ops script (between boots / after a cluster rebuild):**

   ```bash
   scripts/atlas_vector_index.sh            # create/repair now
   scripts/atlas_vector_index.sh --check    # report-only: exists? queryable? problems?
   ```

   Runs `dist/scripts/ensure-vector-index.js` inside the running gateway
   container (Docker-only policy; uses the container's real `MONGODB_URI`).

## Verification

```bash
scripts/atlas_vector_index.sh --check
# expect: exists: true, type: vectorSearch, status: READY, problems: []
```

Then the PR #390-style end-to-end check — both must return ranked, non-empty
results, and the gateway log must NOT show
`Atlas $vectorSearch returned 0 results — falling back`:

```bash
# via the gateway MCP (x-gateway-local-token header required off-loopback)
memory_search  { "query": "memory_search vector retrieval fix", "limit": 3 }
recall_session { "query": "what did we do for PR #390", "k": 3 }
docker logs myai-gateway --since 5m | grep -i "falling back"   # expect empty
```

## Notes / limits

- A freshly created or updated index takes **~1 minute** to become queryable;
  during that window `$vectorSearch` still returns `[]` and the PR #390
  fallback (empty Atlas result → embedded local ANN) keeps recall alive.
- **M0 free tier allows max 3 search indexes** per cluster — `vector_index` is
  the only one this repo provisions on `vectors`.
- Belt-and-suspenders remains: `VECTOR_BACKEND=local` forces the embedded ANN
  path outright if Atlas Search ever misbehaves (`detectVectorBackend`).
- Provisioned live on the production cluster (cluster0…/myai) on 2026-07-26;
  verified READY with self-hit score 1.0 and tenant-filtered hits.
