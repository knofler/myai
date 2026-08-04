#!/usr/bin/env python3
"""hybrid_retrieve.py — deterministic hybrid retrieval + RRF fusion (BRAIN B-4).

The first *consumer* of the B-1 index substrate. build_sparse_index.py and
embed_atoms.py populate the lexical (`sparse_terms`/`doc_stats`) and dense
(`embeddings`) tables; nothing read them back until now. This module fuses both
signals into one ranked result list — the retrieval half of BRAIN_BUILD_PLAN.md
§1/§2/§4 B-4. Stdlib-only, deterministic (no network, no ML deps): the same DB +
query always yields the same ordering.

Two signals, one fusion:

  1. Lexical (BM25) over sparse_terms/doc_stats. idf is computed at *query time*
     from COUNT(DISTINCT doc_id) per term (exactly as build_sparse_index.py's
     header specifies — the postings table therefore never goes stale relative
     to corpus churn). k1=1.5, b=0.75, avgdl from doc_stats.
  2. Dense (cosine) of the query's `local-hash-v1` vector against the
     `embeddings` table. The query vector is produced by embed_atoms._hash_vector
     — IMPORTED, never reimplemented, so query and corpus vectors live in the
     same hash space and actually compare. dim comes from meta `embeddings_dim`.
  3. Reciprocal Rank Fusion merges the two ranked lists:
         score(d) = sum over lists of 1 / (RRF_K + rank_d),  RRF_K = 60
     Sort desc, return top-k. The RRF order IS the deterministic reranker.

Reranker hook (DEFAULT-OFF)
  A future learned cross-encoder (SPLADE / ColBERT / a real cross-encoder) is
  the eventual upgrade path for step 4, gated exactly like B-5's embed/index
  hooks ($MYAI_BRAIN_EMBED_CMD / $MYAI_BRAIN_INDEX_CMD in scripts/lib/brain.sh):
  read env `MYAI_RERANK_CMD`; when it is UNSET (the default) we skip entirely
  and the deterministic RRF order stands. This module does NOT implement any
  reranking model itself — only the plumbing that lets one plug in. See
  _maybe_rerank. scripts/rerank_lexical.py is the first real backend for this
  hook (a stdlib-only lexical-overlap cross-encoder-STYLE scorer, not a
  learned model — the cheap first cut ahead of an eventual SPLADE/ColBERT/
  real cross-encoder); it is NOT wired in by default here, matching the
  hook's opt-in contract — set `$MYAI_RERANK_CMD` to activate it.

Public interface (B-3 imports this — do not change the signature):
    retrieve(db_path, query, k=10, doc_types=None) -> list[dict]
  Each result dict:
    {"doc_type": "chunk"|"atom", "doc_id": int, "ref": str,
     "score": float, "snippet": str}

Usage
  hybrid_retrieve.py --query "..." [--k 10] [--db PATH]
                     [--doc-types chunk,atom] [--json]

Exit 0 on success; 2 on usage / missing-DB error.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import struct
import subprocess
import sys
from collections import defaultdict

# scripts/ (for embed_atoms) + scripts/lib (for repo_index_schema) on the path,
# so this works both as a CLI and when B-3 imports it as a module.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.join(_HERE, "lib"))
from repo_index_schema import connect, get_meta, tokenize  # noqa: E402
from embed_atoms import PROVIDER, _hash_vector  # noqa: E402  (reuse — do NOT reimplement)

# BM25 knobs (BRAIN_BUILD_PLAN.md B-4).
K1 = 1.5
B = 0.75
# Reciprocal Rank Fusion constant.
RRF_K = 60
# How many fused candidates to materialise before (optional) reranking / top-k.
# Bounds work at scale while giving a future reranker a pool wider than k.
_CANDIDATE_WINDOW = 50

_DOC_TYPES = ("chunk", "atom")


def _resolve_doc_types(doc_types: list[str] | None) -> tuple[str, ...]:
    """Normalise the caller's doc_types filter to the known set, preserving order."""
    if not doc_types:
        return _DOC_TYPES
    return tuple(dt for dt in _DOC_TYPES if dt in set(doc_types))


def _bm25_scores(conn, query_terms: list[str], types: tuple[str, ...]) -> dict:
    """BM25 score per (doc_type, doc_id) over sparse_terms/doc_stats.

    idf(term) is derived at query time from COUNT(DISTINCT doc_id) among the
    scoped postings — the build script keeps only tf/length, never a stale idf.
    """
    if not types:
        return {}
    placeholders = ",".join("?" for _ in types)

    # Corpus stats, scoped to the requested doc types.
    lengths: dict = {}
    for dt, did, length in conn.execute(
        f"SELECT doc_type, doc_id, length FROM doc_stats WHERE doc_type IN ({placeholders})",
        types,
    ):
        lengths[(dt, did)] = length
    n_docs = len(lengths)
    if n_docs == 0:
        return {}
    avgdl = sum(lengths.values()) / n_docs
    if avgdl == 0:
        return {}

    scores: dict = defaultdict(float)
    for term in dict.fromkeys(query_terms):  # unique terms, stable order
        postings = conn.execute(
            f"SELECT doc_type, doc_id, tf FROM sparse_terms "
            f"WHERE term = ? AND doc_type IN ({placeholders})",
            (term, *types),
        ).fetchall()
        n_t = len(postings)  # COUNT(DISTINCT doc_id): PK guarantees one row/doc
        if n_t == 0:
            continue
        idf = math.log(1.0 + (n_docs - n_t + 0.5) / (n_t + 0.5))
        for dt, did, tf in postings:
            dl = lengths.get((dt, did), 0)
            denom = tf + K1 * (1.0 - B + B * (dl / avgdl))
            if denom <= 0:
                continue
            scores[(dt, did)] += idf * (tf * (K1 + 1.0)) / denom
    return scores


def _cosine(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


def _dense_scores(conn, query: str, types: tuple[str, ...]) -> dict:
    """Cosine similarity of the query's local-hash-v1 vector vs the embeddings table.

    Only docs that share at least one hashed feature (cosine > 0) are candidates,
    mirroring the lexical side (only term-matching docs score). Determinism: the
    query vector is embed_atoms._hash_vector, identical to how the corpus was
    embedded.
    """
    if not types:
        return {}

    dim_meta = get_meta(conn, "embeddings_dim")
    if dim_meta is not None:
        try:
            dim = int(dim_meta)
        except ValueError:
            dim = 0
    else:
        row = conn.execute(
            "SELECT dim FROM embeddings WHERE provider = ? LIMIT 1", (PROVIDER,)
        ).fetchone()
        dim = int(row[0]) if row else 0
    if dim <= 0:
        return {}

    qvec = _hash_vector(query, dim)
    if not any(qvec):  # query has no indexable tokens
        return {}

    placeholders = ",".join("?" for _ in types)
    scores: dict = {}
    for dt, did, row_dim, blob in conn.execute(
        f"SELECT doc_type, doc_id, dim, vector FROM embeddings "
        f"WHERE provider = ? AND doc_type IN ({placeholders})",
        (PROVIDER, *types),
    ):
        if row_dim != dim:
            continue
        vec = list(struct.unpack(f"<{row_dim}f", blob))
        sim = _cosine(qvec, vec)
        if sim > 0.0:
            scores[(dt, did)] = sim
    return scores


def _rank_map(scores: dict) -> dict:
    """1-based rank per doc, sorted by score desc with a deterministic tiebreak
    on (doc_type, doc_id)."""
    ordered = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0][0], kv[0][1]))
    return {doc: i + 1 for i, (doc, _score) in enumerate(ordered)}


def _rrf(lex_ranks: dict, dense_ranks: dict) -> dict:
    """Reciprocal Rank Fusion over the two rank maps."""
    fused: dict = defaultdict(float)
    for ranks in (lex_ranks, dense_ranks):
        for doc, rank in ranks.items():
            fused[doc] += 1.0 / (RRF_K + rank)
    return fused


def _ref_and_snippet(conn, doc_type: str, doc_id: int) -> tuple[str, str]:
    """ref + ~200-char snippet for a fused doc.
    chunk -> "<file>:<start_line>" + chunk text; atom -> atom_path + excerpt."""
    if doc_type == "chunk":
        row = conn.execute(
            "SELECT file, start_line, text FROM chunks WHERE id = ?", (doc_id,)
        ).fetchone()
        if not row:
            return (f"chunk#{doc_id}", "")
        file, start_line, text = row
        return (f"{file}:{start_line}", _snippet(text))
    row = conn.execute(
        "SELECT atom_path, excerpt FROM atoms WHERE id = ?", (doc_id,)
    ).fetchone()
    if not row:
        return (f"atom#{doc_id}", "")
    atom_path, excerpt = row
    return (atom_path, _snippet(excerpt))


def _snippet(text: str | None) -> str:
    return " ".join((text or "").split())[:200]


def _maybe_rerank(query: str, results: list[dict]) -> list[dict]:
    """DEFAULT-OFF pluggable hook for a future *learned* reranker.

    Gated exactly like B-5's embed/index hooks (scripts/lib/brain.sh): when the
    env var $MYAI_RERANK_CMD is UNSET — the default — this is a no-op and the
    deterministic RRF order stands. This module intentionally does NOT implement
    SPLADE / ColBERT / a cross-encoder; that is the future learned upgrade. Only
    the plumbing lives here.

    Contract when set: the command is run through the shell, receives
    {"query": ..., "results": [...]} as JSON on stdin, and must print a JSON
    array of `ref` strings in the desired new order on stdout. Refs it omits are
    appended in RRF order; unknown refs are ignored. ANY failure (non-zero exit,
    bad JSON, timeout) falls back to the RRF order — retrieval never breaks.
    """
    cmd = os.environ.get("MYAI_RERANK_CMD")
    if not cmd:
        return results  # default: skip (no-op), RRF order is the reranker
    try:
        payload = json.dumps({"query": query, "results": results})
        proc = subprocess.run(
            cmd,
            shell=True,
            input=payload,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if proc.returncode != 0:
            return results
        order = json.loads(proc.stdout)
        if not isinstance(order, list):
            return results
        by_ref = {r["ref"]: r for r in results}
        reranked: list[dict] = []
        seen: set = set()
        for ref in order:
            r = by_ref.get(ref)
            if r is not None and ref not in seen:
                reranked.append(r)
                seen.add(ref)
        for r in results:  # keep anything the reranker dropped, in RRF order
            if r["ref"] not in seen:
                reranked.append(r)
        return reranked
    except Exception:
        return results  # defensive: a broken reranker must not break retrieval


def retrieve(
    db_path: str, query: str, k: int = 10, doc_types: list[str] | None = None
) -> list[dict]:
    """Hybrid (lexical BM25 + dense cosine) retrieval fused with RRF.

    Returns up to `k` result dicts sorted best-first:
        {"doc_type", "doc_id", "ref", "score", "snippet"}
    `doc_types` optionally restricts to a subset of ("chunk", "atom").
    """
    types = _resolve_doc_types(doc_types)
    query_terms = tokenize(query)

    conn = connect(db_path)
    try:
        lex = _bm25_scores(conn, query_terms, types)
        dense = _dense_scores(conn, query, types)
        fused = _rrf(_rank_map(lex), _rank_map(dense))
        if not fused:
            return []

        ordered = sorted(
            fused.items(), key=lambda kv: (-kv[1], kv[0][0], kv[0][1])
        )
        # Materialise a bounded candidate window (>= k) so the optional reranker
        # sees more than the final cut, then trim to k after reranking.
        window = ordered[: max(k, _CANDIDATE_WINDOW)]
        results: list[dict] = []
        for (doc_type, doc_id), score in window:
            ref, snippet = _ref_and_snippet(conn, doc_type, doc_id)
            results.append(
                {
                    "doc_type": doc_type,
                    "doc_id": doc_id,
                    "ref": ref,
                    "score": score,
                    "snippet": snippet,
                }
            )
    finally:
        conn.close()

    results = _maybe_rerank(query, results)
    return results[:k]


def _format_human(results: list[dict]) -> str:
    if not results:
        return "hybrid_retrieve: no matches"
    lines = []
    for i, r in enumerate(results, 1):
        lines.append(
            f"{i:>3}. [{r['doc_type']:<5}] {r['score']:.6f}  {r['ref']}"
        )
        if r["snippet"]:
            lines.append(f"      {r['snippet']}")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
    )
    parser.add_argument("--db", default=None)
    parser.add_argument("--query", required=True)
    parser.add_argument("--k", type=int, default=10)
    parser.add_argument(
        "--doc-types",
        default=None,
        help="comma-separated subset of: chunk,atom (default: both)",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    if args.k <= 0:
        parser.error("--k must be positive")

    root = os.path.abspath(args.repo_root)
    db_path = args.db or os.path.join(root, "state", ".repo_index.sqlite3")
    if not os.path.isfile(db_path):
        print(
            f"hybrid_retrieve: no DB at {db_path} — run scan_repo_index.py first",
            file=sys.stderr,
        )
        return 2

    doc_types = None
    if args.doc_types:
        doc_types = [d.strip() for d in args.doc_types.split(",") if d.strip()] or None

    results = retrieve(db_path, args.query, k=args.k, doc_types=doc_types)

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print(_format_human(results))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
