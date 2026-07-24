#!/usr/bin/env python3
"""index_brain_atoms.py — mirror brain (git-versioned memory) atoms into the
repo-local SQLite index.

The brain is a SEPARATE git repo from code (see scripts/lib/brain.sh,
plan/jam/brain-layer.md) — this script never writes to it, only reads its
already-committed atom files and mirrors their frontmatter into the `atoms`
table so retrieval can pre-filter memory the same deterministic way
scan_repo_index.py pre-filters code (`SELECT ... FROM atoms WHERE repo = ? AND
month_bucket = ?` instead of reading every session/handoff file).

Brain dir resolution mirrors brain_dir() in scripts/lib/brain.sh:
  1. $MYAI_BRAIN_DIR                  explicit override
  2. $MYAI_HOME/brain.path            pointer file (first line = path)
  3. $MYAI_HOME/brain                 default ($MYAI_HOME defaults to ~/.myai)

Atom frontmatter (written by runtime/src/core/brain.ts writeAtom()):
  ---
  kind: session|handoff|memory
  repo: <name>|—
  slug: <slug>
  host: <host>
  written: <YYYYMMDDTHHMMSSZ>
  code-repo / code-branch / code-sha / code-commits   (optional provenance)
  ---
  <content>

Scope: repos/<repo>/{sessions,handoffs}/*.md for the named repo, plus the
global memory/*.md atoms (repo == '—' in the frontmatter). No brain repo
found -> reports 0 atoms and exits 0 (indexing is opportunistic, not required).

Usage
  index_brain_atoms.py [--repo NAME] [--brain-dir DIR] [--db PATH] [--quiet]

Exit 0 on success (including "no brain found"); 2 on usage/IO error.
"""
from __future__ import annotations

import argparse
import glob
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "lib"))
from repo_index_schema import connect, month_bucket_of, set_meta  # noqa: E402


def resolve_brain_dir(env: dict) -> str | None:
    explicit = env.get("MYAI_BRAIN_DIR")
    if explicit:
        return explicit
    home = env.get("MYAI_HOME") or os.path.join(env.get("HOME", ""), ".myai")
    pointer = os.path.join(home, "brain.path")
    if os.path.isfile(pointer):
        with open(pointer, encoding="utf-8") as fh:
            first = fh.readline().strip()
        if first:
            return first
    return os.path.join(home, "brain")


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 4)
    if end == -1:
        return {}, text
    block = text[4:end]
    body = text[end + 4:].lstrip("\n")
    meta: dict[str, str] = {}
    for line in block.splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip()
    return meta, body


def _slugify(repo: str) -> str:
    import re

    s = re.sub(r"[^a-z0-9]+", "-", repo.lower()).strip("-")
    return s


def index_atoms(brain_dir: str, repo: str | None, db_path: str, quiet: bool = False) -> dict:
    conn = connect(db_path)
    conn.execute("DELETE FROM atoms")

    patterns = [os.path.join(brain_dir, "memory", "*.md")]
    if repo:
        ns = _slugify(repo)
        patterns.append(os.path.join(brain_dir, "repos", ns, "sessions", "*.md"))
        patterns.append(os.path.join(brain_dir, "repos", ns, "handoffs", "*.md"))
    else:
        patterns.append(os.path.join(brain_dir, "repos", "*", "sessions", "*.md"))
        patterns.append(os.path.join(brain_dir, "repos", "*", "handoffs", "*.md"))

    count = 0
    for pattern in patterns:
        for path in sorted(glob.glob(pattern)):
            try:
                with open(path, encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except OSError:
                continue
            meta, body = _parse_frontmatter(text)
            rel = os.path.relpath(path, brain_dir)
            filename = os.path.basename(path)
            sha8 = filename.rsplit("-", 1)[-1].removesuffix(".md") if "-" in filename else None
            written = meta.get("written", "")
            excerpt = " ".join(body.split())[:280]
            conn.execute(
                "INSERT OR REPLACE INTO atoms"
                "(atom_path, kind, repo, slug, host, written, month_bucket, sha8, "
                " token_count, tombstone, supersedes, excerpt) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)",
                (
                    rel,
                    meta.get("kind", "unknown"),
                    meta.get("repo"),
                    meta.get("slug"),
                    meta.get("host"),
                    written,
                    month_bucket_of(written) if written else None,
                    sha8,
                    len(body.split()),
                    excerpt,
                ),
            )
            count += 1

    set_meta(conn, "brain_dir", brain_dir)
    set_meta(conn, "brain_atoms_indexed", str(count))
    conn.commit()
    conn.close()

    if not quiet:
        print(f"index_brain_atoms: {count} atoms indexed from {brain_dir}")
    return {"atoms": count, "brain_dir": brain_dir}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=None, help="repo namespace under repos/<repo>/ (default: all repos)")
    parser.add_argument("--brain-dir", default=None)
    parser.add_argument("--repo-root", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
    parser.add_argument("--db", default=None)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    root = os.path.abspath(args.repo_root)
    db_path = args.db or os.path.join(root, "state", ".repo_index.sqlite3")
    os.makedirs(os.path.dirname(db_path), exist_ok=True)

    brain_dir = args.brain_dir or resolve_brain_dir(dict(os.environ))
    if not brain_dir or not os.path.isdir(os.path.join(brain_dir, ".git")) or not os.path.isfile(os.path.join(brain_dir, "BRAIN.md")):
        if not args.quiet:
            print(f"index_brain_atoms: no brain repo at {brain_dir} — skipping (0 atoms)")
        connect(db_path).close()
        return 0

    index_atoms(brain_dir, args.repo, db_path, quiet=args.quiet)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
