# recall_session recall-quality eval

Queries: **10** · cut-off: **k=5**

## Aggregate metrics

| metric | value |
|---|---|
| precision@5 | 22.0% |
| recall@5 | 100.0% |
| MRR | 1.000 |
| MAP | 1.000 |
| hit-rate@5 | 100.0% |

## Threshold sweep

Recommended operating threshold (max mean-F1): **0**

| threshold | precision | recall | F1 |
|---|---|---|---|
| 0 | 22.0% | 100.0% | 0.361 ⬅ |
| 0.1 | 22.0% | 100.0% | 0.361 |
| 0.2 | 22.0% | 100.0% | 0.361 |
| 0.3 | 20.0% | 95.0% | 0.330 |
| 0.4 | 16.0% | 75.0% | 0.264 |
| 0.5 | 8.0% | 40.0% | 0.133 |
| 0.6 | 0.0% | 0.0% | 0.000 |
| 0.7 | 0.0% | 0.0% | 0.000 |
| 0.8 | 0.0% | 0.0% | 0.000 |
| 0.9 | 0.0% | 0.0% | 0.000 |

## Per-query

| query | P@k | R@k | RR | top hit |
|---|---|---|---|---|
| redoc openapi api reference documentation | 20.0% | 100.0% | 1.00 | sess-pr347-redoc (0.395) |
| public status page uptime health history | 20.0% | 100.0% | 1.00 | sess-status-page (0.596) |
| MRR ARR churn revenue dashboard stripe | 20.0% | 100.0% | 1.00 | sess-revenue-dashboard (0.5) |
| STATE.md hot cold tier rotation archive | 20.0% | 100.0% | 1.00 | sess-two-tier-state (0.54) |
| vector store ANN index cosine recall performance | 40.0% | 100.0% | 1.00 | sess-vector-ann (0.429) |
| atlas vectorSearch tenant isolation | 20.0% | 100.0% | 1.00 | sess-atlas-vector-search (0.464) |
| schedule runner queue reprioritize fable window | 20.0% | 100.0% | 1.00 | sess-schedule-runner (0.426) |
| zero prompt permissions bypass safety rails hooks | 20.0% | 100.0% | 1.00 | sess-zero-prompt (0.364) |
| RAG recall eval precision MRR baseline | 20.0% | 100.0% | 1.00 | sess-handoff-current (0.48) |
| CI thrift vercel deploy local-ci fallback | 20.0% | 100.0% | 1.00 | sess-ci-thrift (0.566) |
