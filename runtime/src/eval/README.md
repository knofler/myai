# RAG recall-quality eval harness

Measures `recall_session` retrieval quality against a hand-labelled query→session
gold set, so **threshold and chunking changes can be measured instead of guessed**
(RAG Phase B).

## Run

```bash
npm run eval:recall         # run + write report + baseline (src/eval/)
npm run eval:recall:check   # run + exit 1 on regression vs the committed baseline
```

The default run uses a deterministic, dependency-free bag-of-words retriever over
an in-memory corpus — no gateway, Mongo, or embedding model needed, so the numbers
are reproducible in CI.

## Files

| file | role |
|---|---|
| `recall-metrics.ts` | pure IR metrics — precision@k, recall@k, MRR, MAP, F1, threshold sweep |
| `recall-dataset.ts` | labelled query→session gold set + synthetic session corpus |
| `recall-eval.ts` | harness (`runRecallEval`), retrievers, markdown report, regression compare |
| `run-recall-eval.ts` | CLI entry — writes `recall-report.md` + `recall-baseline.json` |
| `recall-baseline.json` | **tracked regression baseline** — a >2pt metric drop fails `--check` |
| `recall-report.md` | latest report snapshot (regenerable) |

## Metrics

- **precision@k** — fraction of the top-k hits that are relevant.
- **recall@k** — fraction of all relevant sessions found in the top-k.
- **MRR** — mean reciprocal rank of the first relevant hit (ranking quality).
- **MAP** — mean average precision across the ranked list.
- **threshold sweep** — precision/recall/F1 at each score cut-off; the harness
  recommends the max-F1 operating threshold.

## Measuring the real embedding pipeline

The harness is retriever-agnostic. To score the live vector-store instead of the
lexical baseline, wrap `recallSession` with `recallSessionRetriever` (joins on
`sessionId`) against a populated store — see `recall-eval.ts`.

## Adding labels

When a real recall miss shows up, add the session block to `corpus` and a query
row naming its id to `queries` in `recall-dataset.ts`, then re-run `eval:recall`
to refresh the baseline. Keep the set small and curated — it is a regression
fixture, not the production corpus.

## Enforcement (merge gate)

`npm run eval:recall:check` is a CLI convenience — nothing ran it automatically
until `tests/unit/recall-eval-gate.test.ts` was added. That test runs the same
`compareToBaseline` comparison against the committed `recall-baseline.json` as
a normal vitest case, so it rides the existing runtime test run: `npm test`,
`npm run test:coverage`, `scripts/local-ci.sh`'s `check_runtime_coverage` gate,
and `.github/workflows/tenant-isolation.yml`'s `coverage-gate` job (PR → main)
all execute it. A precision/recall/MRR/MAP/hit-rate drop past the 2-point
tolerance now fails the merge gate instead of silently passing.

### Refreshing the baseline

Refresh only when a metric drop is *expected* (e.g. a deliberate chunking or
threshold change), never to paper over a real regression:

```bash
npm run eval:recall   # regenerates recall-report.md + recall-baseline.json
```

Review the diff in `recall-baseline.json` before committing — every drop
should be explainable by the change that caused it. Commit both files
together with the change that motivated the refresh.
