#!/usr/bin/env python3
"""rerank_lexical.py — lightweight local reranker for the BRAIN B-4
$MYAI_RERANK_CMD hook (plan/BRAIN_BUILD_PLAN.md B-4).

B-4 shipped hybrid_retrieve.py's BM25 + dense-cosine RRF fusion but left the
*learned* reranker step as a documented no-op: "$MYAI_RERANK_CMD ... This
module does NOT implement any learned model — only the plumbing that lets one
plug in later." This is that plug-in — the cheap first cut named in the
follow-up (a hash/lexical-overlap reranker), not a SPLADE/ColBERT/real
cross-encoder. Swapping in an actual learned model later means writing a new
script with the same stdin/stdout contract and repointing $MYAI_RERANK_CMD at
it; hybrid_retrieve.py itself needs no change.

Why this beats re-sorting by the RRF score it was already given: RRF fuses two
*independent* per-list ranks (BM25 rank, cosine rank) — neither signal ever
looks at query and document text jointly. This script scores each (query,
snippet) PAIR directly — the defining trait of a cross-encoder, just without
the learned model — using signals RRF can't see:
  - unique query-term coverage in the snippet
  - bigram overlap (rewards matching word ORDER/adjacency, which bag-of-words
    BM25 ignores — "auth token" scores higher than a snippet with "auth" and
    "token" far apart)
  - an exact-phrase substring bonus
  - matched-term density (concentration, not just presence)
Stdlib-only, deterministic: same (query, results) in -> same order out.

Hook contract (see hybrid_retrieve.py::_maybe_rerank): stdin is
{"query": str, "results": [{"ref": str, "snippet": str, ...}, ...]}; stdout
must be a JSON array of `ref` strings in the new order. Any exception here is
the caller's problem to catch (it falls back to RRF order on failure) — this
script exits 2 on bad input so the failure is visible when run standalone.

Usage as the hook:
    export MYAI_RERANK_CMD="python3 /path/to/scripts/rerank_lexical.py"
Usage standalone (for debugging / the test suite):
    echo '{"query": "...", "results": [...]}' | python3 rerank_lexical.py
"""
from __future__ import annotations

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "lib"))
from repo_index_schema import tokenize  # noqa: E402  (reuse — do NOT reimplement)

# Signal weights. Coverage dominates (a candidate missing most query terms
# should never outrank one that has them all); bigram overlap is the main
# "joint" signal a bag-of-words fusion can't provide; phrase + density are
# smaller tie-breaking nudges.
_W_COVERAGE = 4.0
_W_BIGRAM = 3.0
_W_PHRASE = 2.0
_W_DENSITY = 1.0


def _bigrams(tokens: list[str]) -> set[tuple[str, str]]:
    return {(tokens[i], tokens[i + 1]) for i in range(len(tokens) - 1)}


def score_pair(query: str, snippet: str) -> float:
    """Cross-encoder-style relevance score for one (query, snippet) pair.

    Bounded roughly to [0, _W_COVERAGE + _W_BIGRAM + _W_PHRASE + _W_DENSITY]
    (~10.0); callers only care about relative order, not the scale.
    """
    q_tokens = tokenize(query)
    if not q_tokens:
        return 0.0
    d_tokens = tokenize(snippet)
    if not d_tokens:
        return 0.0

    q_unique = set(q_tokens)
    d_counts: dict[str, int] = {}
    for t in d_tokens:
        d_counts[t] = d_counts.get(t, 0) + 1

    matched = q_unique & set(d_counts)
    coverage = len(matched) / len(q_unique)

    q_bg = _bigrams(q_tokens)
    d_bg = _bigrams(d_tokens)
    bigram_overlap = (len(q_bg & d_bg) / len(q_bg)) if q_bg else 0.0

    norm_query = " ".join(q_tokens)
    norm_snippet = " ".join(d_tokens)
    phrase_bonus = 1.0 if norm_query and norm_query in norm_snippet else 0.0

    matched_count = sum(d_counts.get(t, 0) for t in matched)
    density = min(1.0, matched_count / max(1, len(d_tokens)) * 5.0)

    return (
        _W_COVERAGE * coverage
        + _W_BIGRAM * bigram_overlap
        + _W_PHRASE * phrase_bonus
        + _W_DENSITY * density
    )


def rerank(query: str, results: list[dict]) -> list[str]:
    """Return `ref`s of `results` sorted best-first by score_pair.

    Stable sort: candidates that tie keep their incoming (RRF) relative order
    — this is what makes the hook a pure re-ranking of the given candidates
    rather than an independent, potentially-flaky ordering.
    """
    scored = [
        (i, r.get("ref"), score_pair(query, r.get("snippet") or ""))
        for i, r in enumerate(results)
    ]
    scored.sort(key=lambda t: (-t[2], t[0]))
    return [ref for _i, ref, _s in scored if ref is not None]


def main(argv: list[str]) -> int:
    del argv
    try:
        payload = json.load(sys.stdin)
        query = payload["query"]
        results = payload["results"]
        if not isinstance(results, list):
            raise ValueError("results must be a list")
    except Exception as exc:  # noqa: BLE001 — CLI boundary, report and exit
        print(f"rerank_lexical: bad input: {exc}", file=sys.stderr)
        return 2

    print(json.dumps(rerank(query, results)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
