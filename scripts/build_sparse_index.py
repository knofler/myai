#!/usr/bin/env python3
"""build_sparse_index.py — inverted term index over chunks + atoms.

The lexical half of BRAIN_BUILD_PLAN.md B-1/B-4: a plain term -> {doc_type,
doc_id, tf} posting list (sparse_terms) plus per-doc length (doc_stats), built
straight from the `chunks` and `atoms` tables scan_repo_index.py and
index_brain_atoms.py already populated. Stdlib-only tokenizer (lowercase
`[a-z0-9_]+` words) — no SPLADE/BM25 model, just the postings a BM25 scorer
needs at query time:

  score(doc, query) = sum over query terms of:
    tf(term, doc) * idf(term)              -- idf computed at query time from
                                               COUNT(DISTINCT doc) per term,
                                               so this table never goes stale
                                               relative to corpus size churn.

Rebuilds are full (DELETE + re-insert) — cheap enough at repo scale and avoids
drift between chunks/atoms and their postings after a re-scan.

Usage
  build_sparse_index.py [--db PATH] [--quiet]

Exit 0 on success; 2 on usage/IO error.
"""
from __future__ import annotations

import argparse
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "lib"))
from repo_index_schema import connect, set_meta, tokenize  # noqa: E402


def build(db_path: str, quiet: bool = False) -> dict:
    conn = connect(db_path)
    conn.execute("DELETE FROM sparse_terms")
    conn.execute("DELETE FROM doc_stats")

    n_docs = 0
    n_postings = 0

    for doc_type, id_col, text_col, table in (
        ("chunk", "id", "text", "chunks"),
        ("atom", "id", "excerpt", "atoms"),
    ):
        rows = conn.execute(f"SELECT {id_col}, {text_col} FROM {table}").fetchall()
        for doc_id, text in rows:
            terms = tokenize(text or "")
            if not terms:
                continue
            counts = Counter(terms)
            conn.executemany(
                "INSERT OR REPLACE INTO sparse_terms(term, doc_type, doc_id, tf) VALUES (?, ?, ?, ?)",
                [(term, doc_type, doc_id, tf) for term, tf in counts.items()],
            )
            conn.execute(
                "INSERT OR REPLACE INTO doc_stats(doc_type, doc_id, length) VALUES (?, ?, ?)",
                (doc_type, doc_id, len(terms)),
            )
            n_docs += 1
            n_postings += len(counts)

    set_meta(conn, "sparse_docs", str(n_docs))
    set_meta(conn, "sparse_postings", str(n_postings))
    conn.commit()
    conn.close()

    if not quiet:
        print(f"build_sparse_index: {n_docs} docs -> {n_postings} postings")
    return {"docs": n_docs, "postings": n_postings}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
    parser.add_argument("--db", default=None)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    root = os.path.abspath(args.repo_root)
    db_path = args.db or os.path.join(root, "state", ".repo_index.sqlite3")
    if not os.path.isfile(db_path):
        sys.exit(f"build_sparse_index: no DB at {db_path} — run scan_repo_index.py first")

    build(db_path, quiet=args.quiet)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
