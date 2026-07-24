"""repo_index_schema.py — shared SQLite schema for the repo-local BRAIN B-1 index.

One schema, five tables, used by the four indexer scripts (scan_repo_index.py,
index_brain_atoms.py, build_sparse_index.py, embed_atoms.py) so retrieval can
pre-filter with plain SQL instead of re-reading files or re-embedding on every
query. Deterministic, stdlib-only (sqlite3 is in the Python standard library) —
no network, no ML deps. See plan/BRAIN_BUILD_PLAN.md B-1.

Tables
  meta          key/value store (schema_version, last_scan_*)
  symbols       one row per function/class/const found by scan_repo_index.py
  refs          import statements + known-symbol usages (cheap call-graph hint)
  chunks        retrievable text spans (one per symbol, or fixed windows for
                the rest of a file) — what a retriever actually fetches
  tests         test-file -> best-guess source-file mapping
  atoms         brain (git-versioned memory) atoms mirrored in by
                index_brain_atoms.py, keyed by their brain-relative path
  sparse_terms  inverted index (term -> doc) built by build_sparse_index.py
  doc_stats     per-doc token length, for BM25-style scoring against sparse_terms
  embeddings    local fallback vectors built by embed_atoms.py
  bandit_arms   contextual-bandit arm statistics (pulls, reward_sum) per
                (context, retrieval-config arm) — written by
                retrieval_bandit.py (BRAIN B-7 retrieval-config tuning)
  edges         typed, resolved code-edge graph (import/calls/tests_of) built
                by code_graph.py (BRAIN B-1.5) over symbols/refs/chunks/tests —
                what get_neighbors()/shortest_path() traverse

All tables are rebuildable from source (git-tracked files + the brain store),
so the database file itself is never committed — see .gitignore.
"""
from __future__ import annotations

import sqlite3

SCHEMA_VERSION = "1"

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file       TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  lang       TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end   INTEGER NOT NULL,
  signature  TEXT,
  UNIQUE(file, name, line_start)
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);

CREATE TABLE IF NOT EXISTS refs (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  UNIQUE(file, line, name, kind)
);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);

CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file        TEXT NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  symbol_id   INTEGER REFERENCES symbols(id),
  token_count INTEGER NOT NULL,
  text        TEXT NOT NULL,
  UNIQUE(file, start_line, end_line)
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file);

CREATE TABLE IF NOT EXISTS tests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  test_file   TEXT NOT NULL,
  source_file TEXT,
  name        TEXT NOT NULL,
  UNIQUE(test_file, name)
);
CREATE INDEX IF NOT EXISTS idx_tests_source ON tests(source_file);

CREATE TABLE IF NOT EXISTS atoms (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  atom_path    TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL,
  repo         TEXT,
  slug         TEXT,
  host         TEXT,
  written      TEXT,
  month_bucket TEXT,
  sha8         TEXT,
  token_count  INTEGER,
  tombstone    INTEGER NOT NULL DEFAULT 0,
  supersedes   TEXT,
  excerpt      TEXT
);
CREATE INDEX IF NOT EXISTS idx_atoms_repo ON atoms(repo);
CREATE INDEX IF NOT EXISTS idx_atoms_month ON atoms(month_bucket);

CREATE TABLE IF NOT EXISTS sparse_terms (
  term    TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  doc_id  INTEGER NOT NULL,
  tf      INTEGER NOT NULL,
  PRIMARY KEY (term, doc_type, doc_id)
);
CREATE INDEX IF NOT EXISTS idx_sparse_term ON sparse_terms(term);

CREATE TABLE IF NOT EXISTS doc_stats (
  doc_type TEXT NOT NULL,
  doc_id   INTEGER NOT NULL,
  length   INTEGER NOT NULL,
  PRIMARY KEY (doc_type, doc_id)
);

CREATE TABLE IF NOT EXISTS embeddings (
  doc_type TEXT NOT NULL,
  doc_id   INTEGER NOT NULL,
  provider TEXT NOT NULL,
  dim      INTEGER NOT NULL,
  vector   BLOB NOT NULL,
  PRIMARY KEY (doc_type, doc_id, provider)
);

CREATE TABLE IF NOT EXISTS bandit_arms (
  context    TEXT NOT NULL,
  arm        TEXT NOT NULL,
  pulls      INTEGER NOT NULL DEFAULT 0,
  reward_sum REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (context, arm)
);

CREATE TABLE IF NOT EXISTS edges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  src_file      TEXT NOT NULL,
  src_symbol_id INTEGER REFERENCES symbols(id),
  dst_file      TEXT,
  dst_symbol_id INTEGER REFERENCES symbols(id),
  edge_type     TEXT NOT NULL, -- 'import' | 'calls' | 'tests_of'
  line          INTEGER,
  UNIQUE(src_file, src_symbol_id, dst_file, dst_symbol_id, edge_type, line)
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_file, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_file, edge_type);
"""


def connect(db_path: str) -> sqlite3.Connection:
    """Open (creating if needed) the repo index DB with the schema applied."""
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA_SQL)
    set_meta(conn, "schema_version", SCHEMA_VERSION)
    conn.commit()
    return conn


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def get_meta(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else default


def month_bucket_of(iso_ts: str) -> str | None:
    """Derive a YYYY-MM bucket from a brain UTC stamp (YYYYMMDDTHHMMSSZ) or ISO date."""
    digits = "".join(ch for ch in iso_ts if ch.isdigit())
    if len(digits) < 6:
        return None
    return f"{digits[0:4]}-{digits[4:6]}"


def tokenize(text: str) -> list[str]:
    """Lowercase word tokenizer shared by build_sparse_index.py and embed_atoms.py."""
    import re

    return re.findall(r"[a-z0-9_]+", text.lower())
