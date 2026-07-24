#!/usr/bin/env python3
"""code_graph.py — typed, resolved code-edge graph + traversal (BRAIN B-1.5).

Graphify prior-art adoption (plan/BRAIN_BUILD_PLAN.md §8): the shipped B-1 index
only has a flat `refs` cheap-hint (raw import specs, unresolved, no call graph).
This module resolves those specs into an actual file-level graph and layers
`calls` (regex-matched, symbol-table-resolved) and `tests_of` (from the `tests`
table's test->source guess) on top — three typed edges:

  import    file A imports file B (resolved via relative-path / dotted-module
            lookup against the known file set; bare/package specs that don't
            resolve to a tracked file get dst_file = NULL, kept as a record of
            an external dependency)
  calls     file A (inside a named symbol) calls a name that resolves to a
            known symbol elsewhere (regex `name(` matched against `symbols`,
            same-file matches preferred over cross-file to avoid noisy fan-out
            on common helper names)
  tests_of  test file -> source file, straight from the `tests` table
            scan_repo_index.py already populated (test-name heuristics live
            there, not duplicated here)

Rebuilds are full (DELETE + re-insert), same posture as build_sparse_index.py —
run scan_repo_index.py first so symbols/refs/chunks/tests are current.

Public interface (importable — do not change these signatures):
    build(db_path, quiet=False) -> dict            # {"import": n, "calls": n, "tests_of": n}
    get_neighbors(db_path, node, edge_types=None, direction="out") -> list[dict]
    shortest_path(db_path, src, dst, edge_types=None) -> list[str] | None
  `node`/`src`/`dst` are repo-relative file paths (as stored in `symbols.file`/
  `chunks.file`). `edge_types` is an iterable subset of ("import", "calls",
  "tests_of"); default is all three. `direction` for get_neighbors is one of
  "out" (this file's outgoing edges), "in" (incoming), "both".

Usage
  code_graph.py build [--quiet]
  code_graph.py neighbors <file> [--direction out|in|both] [--edge-types import,calls,tests_of] [--json]
  code_graph.py shortest-path <src> <dst> [--edge-types ...] [--json]

Exit 0 on success; 2 on usage/missing-DB error.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import deque

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "lib"))
from repo_index_schema import connect  # noqa: E402

ALL_EDGE_TYPES = ("import", "calls", "tests_of")

_EXT_BY_LANG = {
    "typescript": (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"),
    "javascript": (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"),
}

_LANG_BY_EXT = {
    ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python",
    ".sh": "bash",
}

_CALL_RE = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(")

_CALL_KEYWORDS = {
    "if", "for", "while", "switch", "catch", "function", "return", "typeof",
    "new", "instanceof", "in", "of", "else", "do", "with", "try", "await",
    "yield", "class", "import", "export", "from", "as", "const", "let", "var",
    "def", "elif", "except", "lambda", "print", "super", "async",
}

# bound cross-file fan-out for very common helper names (e.g. "get", "run")
_MAX_CROSS_FILE_TARGETS = 20


def _lang_from_ext(file: str) -> str | None:
    return _LANG_BY_EXT.get(os.path.splitext(file)[1])


def _resolve_import(spec: str, src_file: str, known_files: set[str], lang: str | None) -> str | None:
    if lang in ("typescript", "javascript"):
        if not spec.startswith("."):
            return None  # bare package spec — external, not in this repo
        base_dir = os.path.dirname(src_file)
        candidate = os.path.normpath(os.path.join(base_dir, spec)).replace(os.sep, "/")
        for ext in ("", *_EXT_BY_LANG["typescript"]):
            c = candidate + ext
            if c in known_files:
                return c
        for ext in _EXT_BY_LANG["typescript"]:
            c = f"{candidate}/index{ext}"
            if c in known_files:
                return c
        return None
    if lang == "python":
        path_guess = spec.replace(".", "/")
        c = f"{path_guess}.py"
        if c in known_files:
            return c
        c = f"{path_guess}/__init__.py"
        if c in known_files:
            return c
        # local sys.path-hack pattern: "from lib import x" resolved relative to src dir
        base_dir = os.path.dirname(src_file)
        c2 = os.path.normpath(os.path.join(base_dir, f"{path_guess}.py")).replace(os.sep, "/")
        if c2 in known_files:
            return c2
        return None
    return None


def build(db_path: str, quiet: bool = False) -> dict:
    conn = connect(db_path)
    conn.execute("DELETE FROM edges")

    known_files = {r[0] for r in conn.execute("SELECT DISTINCT file FROM chunks")}

    symbol_rows = conn.execute("SELECT id, file, name FROM symbols").fetchall()
    name_index: dict[str, list[tuple[str, int]]] = {}
    name_by_id: dict[int, str] = {}
    lang_by_file: dict[str, str] = {}
    for sid, file, name in symbol_rows:
        name_index.setdefault(name, []).append((file, sid))
        name_by_id[sid] = name
    for file, lang in conn.execute("SELECT DISTINCT file, lang FROM symbols"):
        lang_by_file.setdefault(file, lang)

    n_import = n_calls = n_tests = 0

    for file, line, spec in conn.execute("SELECT file, line, name FROM refs WHERE kind = 'import'"):
        lang = lang_by_file.get(file) or _lang_from_ext(file)
        dst = _resolve_import(spec, file, known_files, lang)
        conn.execute(
            "INSERT OR IGNORE INTO edges(src_file, src_symbol_id, dst_file, dst_symbol_id, edge_type, line) "
            "VALUES (?, NULL, ?, NULL, 'import', ?)",
            (file, dst, line),
        )
        n_import += 1

    for file, start_line, symbol_id, text in conn.execute(
        "SELECT file, start_line, symbol_id, text FROM chunks WHERE symbol_id IS NOT NULL"
    ):
        own_name = name_by_id.get(symbol_id)
        for offset, line_text in enumerate(text.split("\n")):
            for m in _CALL_RE.finditer(line_text):
                name = m.group(1)
                if name in _CALL_KEYWORDS:
                    continue
                if offset == 0 and name == own_name:
                    continue  # the def/class signature line itself, not a call
                matches = name_index.get(name)
                if not matches:
                    continue
                same_file = [(f, i) for f, i in matches if f == file]
                targets = same_file if same_file else matches[:_MAX_CROSS_FILE_TARGETS]
                for dst_file, dst_symbol_id in targets:
                    conn.execute(
                        "INSERT OR IGNORE INTO edges(src_file, src_symbol_id, dst_file, dst_symbol_id, edge_type, line) "
                        "VALUES (?, ?, ?, ?, 'calls', ?)",
                        (file, symbol_id, dst_file, dst_symbol_id, start_line + offset),
                    )
                    n_calls += 1

    for test_file, source_file in conn.execute(
        "SELECT DISTINCT test_file, source_file FROM tests WHERE source_file IS NOT NULL"
    ):
        conn.execute(
            "INSERT OR IGNORE INTO edges(src_file, src_symbol_id, dst_file, dst_symbol_id, edge_type, line) "
            "VALUES (?, NULL, ?, NULL, 'tests_of', NULL)",
            (test_file, source_file),
        )
        n_tests += 1

    conn.commit()
    conn.close()

    stats = {"import": n_import, "calls": n_calls, "tests_of": n_tests}
    if not quiet:
        print(f"code_graph: {stats['import']} import, {stats['calls']} calls, {stats['tests_of']} tests_of edges")
    return stats


def _edge_types_or_default(edge_types) -> tuple[str, ...]:
    return tuple(edge_types) if edge_types else ALL_EDGE_TYPES


def get_neighbors(db_path: str, node: str, edge_types=None, direction: str = "out") -> list[dict]:
    if direction not in ("out", "in", "both"):
        raise ValueError(f"direction must be 'out', 'in', or 'both', got {direction!r}")
    types = _edge_types_or_default(edge_types)
    placeholders = ",".join("?" for _ in types)

    conn = connect(db_path)
    try:
        results: list[dict] = []
        if direction in ("out", "both"):
            rows = conn.execute(
                f"SELECT edge_type, dst_file, src_symbol_id, dst_symbol_id, line FROM edges "
                f"WHERE src_file = ? AND edge_type IN ({placeholders}) AND dst_file IS NOT NULL",
                (node, *types),
            ).fetchall()
            for edge_type, dst_file, src_symbol_id, dst_symbol_id, line in rows:
                results.append({
                    "direction": "out", "edge_type": edge_type, "node": dst_file,
                    "src_symbol_id": src_symbol_id, "dst_symbol_id": dst_symbol_id, "line": line,
                })
        if direction in ("in", "both"):
            rows = conn.execute(
                f"SELECT edge_type, src_file, src_symbol_id, dst_symbol_id, line FROM edges "
                f"WHERE dst_file = ? AND edge_type IN ({placeholders})",
                (node, *types),
            ).fetchall()
            for edge_type, src_file, src_symbol_id, dst_symbol_id, line in rows:
                results.append({
                    "direction": "in", "edge_type": edge_type, "node": src_file,
                    "src_symbol_id": src_symbol_id, "dst_symbol_id": dst_symbol_id, "line": line,
                })
        return results
    finally:
        conn.close()


def shortest_path(db_path: str, src: str, dst: str, edge_types=None) -> list[str] | None:
    if src == dst:
        return [src]
    types = _edge_types_or_default(edge_types)
    placeholders = ",".join("?" for _ in types)

    conn = connect(db_path)
    try:
        visited = {src}
        parent: dict[str, str] = {}
        queue = deque([src])
        while queue:
            cur = queue.popleft()
            rows = conn.execute(
                f"SELECT DISTINCT dst_file FROM edges "
                f"WHERE src_file = ? AND edge_type IN ({placeholders}) AND dst_file IS NOT NULL",
                (cur, *types),
            ).fetchall()
            for (nxt,) in rows:
                if nxt in visited:
                    continue
                visited.add(nxt)
                parent[nxt] = cur
                if nxt == dst:
                    path = [dst]
                    while path[-1] != src:
                        path.append(parent[path[-1]])
                    path.reverse()
                    return path
                queue.append(nxt)
        return None
    finally:
        conn.close()


def _parse_edge_types(csv: str | None) -> tuple[str, ...] | None:
    if not csv:
        return None
    types = tuple(t.strip() for t in csv.split(",") if t.strip())
    for t in types:
        if t not in ALL_EDGE_TYPES:
            raise ValueError(f"unknown edge type {t!r}, must be one of {ALL_EDGE_TYPES}")
    return types or None


def _format_neighbors(results: list[dict]) -> str:
    if not results:
        return "code_graph: no neighbors"
    lines = []
    for r in results:
        arrow = "->" if r["direction"] == "out" else "<-"
        lines.append(f"  {arrow} [{r['edge_type']}] {r['node']} (line {r['line']})")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo-root", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
    parser.add_argument("--db", default=None)
    sub = parser.add_subparsers(dest="command", required=True)

    p_build = sub.add_parser("build")
    p_build.add_argument("--quiet", action="store_true")

    p_nb = sub.add_parser("neighbors")
    p_nb.add_argument("file")
    p_nb.add_argument("--direction", choices=["out", "in", "both"], default="out")
    p_nb.add_argument("--edge-types", default=None, help="comma-separated subset of: import,calls,tests_of")
    p_nb.add_argument("--json", action="store_true")

    p_sp = sub.add_parser("shortest-path")
    p_sp.add_argument("src")
    p_sp.add_argument("dst")
    p_sp.add_argument("--edge-types", default=None, help="comma-separated subset of: import,calls,tests_of")
    p_sp.add_argument("--json", action="store_true")

    args = parser.parse_args(argv)

    root = os.path.abspath(args.repo_root)
    db_path = args.db or os.path.join(root, "state", ".repo_index.sqlite3")

    if args.command == "build":
        if not os.path.isfile(db_path):
            print(f"code_graph: no DB at {db_path} — run scan_repo_index.py first", file=sys.stderr)
            return 2
        build(db_path, quiet=args.quiet)
        return 0

    if not os.path.isfile(db_path):
        print(f"code_graph: no DB at {db_path} — run scan_repo_index.py + code_graph.py build first", file=sys.stderr)
        return 2

    try:
        edge_types = _parse_edge_types(args.edge_types)
    except ValueError as e:
        parser.error(str(e))
        return 2

    if args.command == "neighbors":
        results = get_neighbors(db_path, args.file, edge_types=edge_types, direction=args.direction)
        print(json.dumps(results, indent=2) if args.json else _format_neighbors(results))
        return 0

    if args.command == "shortest-path":
        path = shortest_path(db_path, args.src, args.dst, edge_types=edge_types)
        if args.json:
            print(json.dumps({"path": path}))
        else:
            print(" -> ".join(path) if path else "code_graph: no path found")
        return 0

    parser.error(f"unknown command {args.command!r}")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
