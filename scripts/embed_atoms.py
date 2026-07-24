#!/usr/bin/env python3
"""embed_atoms.py — local fallback vectors for atoms + chunks (embeddings table).

BRAIN_BUILD_PLAN.md draws the hard line at §1: embeddings belong to the
memory/fuzzy-NL side (Atlas HNSW), NOT the code side (deterministic
symbols/refs is enough there — see scan_repo_index.py). This script does NOT
try to replace Atlas: it fills the `embeddings` table with a cheap, stdlib-only
"local-hash-v1" feature-hashing vector so a repo clone with no network / no
Atlas connection still has *some* similarity signal (e.g. `myai brain` running
fully offline, per documentation/BRAIN_OFFLINE.md) instead of none. When Atlas
or a real local model (runtime's LocalEmbeddingProvider,
runtime/src/memory/embeddings.ts) is reachable, that pipeline should write
under a different `provider` value in the same table — this one is the
degraded-mode floor, not the target retrieval path.

Vector: signed feature hashing over word tokens (dim configurable, default 64),
L2-normalized, stored as a packed float32 BLOB. Deterministic: same text always
hashes to the same vector, so re-running only touches rows whose source text
changed (content-hash short-circuit).

Usage
  embed_atoms.py [--db PATH] [--dim 64] [--quiet]

Exit 0 on success; 2 on usage/IO error.
"""
from __future__ import annotations

import argparse
import hashlib
import math
import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "lib"))
from repo_index_schema import connect, set_meta, tokenize  # noqa: E402

PROVIDER = "local-hash-v1"


def _hash_vector(text: str, dim: int) -> list[float]:
    vec = [0.0] * dim
    for term in tokenize(text or ""):
        digest = hashlib.sha256(term.encode("utf-8")).digest()
        idx = int.from_bytes(digest[:4], "big") % dim
        sign = 1.0 if digest[4] & 1 else -1.0
        vec[idx] += sign
    norm = math.sqrt(sum(v * v for v in vec))
    if norm > 0:
        vec = [v / norm for v in vec]
    return vec


def _pack(vec: list[float]) -> bytes:
    return struct.pack(f"<{len(vec)}f", *vec)


def embed(db_path: str, dim: int, quiet: bool = False) -> dict:
    conn = connect(db_path)
    n = 0
    for doc_type, id_col, text_col, table in (
        ("chunk", "id", "text", "chunks"),
        ("atom", "id", "excerpt", "atoms"),
    ):
        rows = conn.execute(f"SELECT {id_col}, {text_col} FROM {table}").fetchall()
        for doc_id, text in rows:
            vec = _hash_vector(text or "", dim)
            conn.execute(
                "INSERT OR REPLACE INTO embeddings(doc_type, doc_id, provider, dim, vector) "
                "VALUES (?, ?, ?, ?, ?)",
                (doc_type, doc_id, PROVIDER, dim, _pack(vec)),
            )
            n += 1

    set_meta(conn, "embeddings_provider", PROVIDER)
    set_meta(conn, "embeddings_dim", str(dim))
    set_meta(conn, "embeddings_count", str(n))
    conn.commit()
    conn.close()

    if not quiet:
        print(f"embed_atoms: {n} vectors written (provider={PROVIDER}, dim={dim})")
    return {"vectors": n, "provider": PROVIDER, "dim": dim}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
    parser.add_argument("--db", default=None)
    parser.add_argument("--dim", type=int, default=64)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    if args.dim <= 0:
        sys.exit("embed_atoms: --dim must be positive")

    root = os.path.abspath(args.repo_root)
    db_path = args.db or os.path.join(root, "state", ".repo_index.sqlite3")
    if not os.path.isfile(db_path):
        sys.exit(f"embed_atoms: no DB at {db_path} — run scan_repo_index.py first")

    embed(db_path, args.dim, quiet=args.quiet)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
