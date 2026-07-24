#!/usr/bin/env python3
"""scan_repo_index.py — deterministic code scan into the repo-local SQLite index.

Walks every git-tracked source file (`git ls-files` — respects .gitignore for
free, zero-dep) and populates the symbols/refs/chunks/tests tables defined in
scripts/lib/repo_index_schema.py. This is the "rg + AST-ish + ctags-lite"
deterministic pre-filter BRAIN_BUILD_PLAN.md B-1 calls for: no embeddings, no
LLM calls, just regex/indent-based symbol extraction so a retriever can do
`SELECT file, line_start FROM symbols WHERE name = ?` instead of grepping the
whole tree or reading whole files into context.

Supported languages: TypeScript/JavaScript (.ts .tsx .js .jsx .mjs .cjs),
Python (.py), Bash (.sh). Extraction is intentionally simple (regex + brace/
indent heuristics) — good enough to narrow a retrieval candidate set, not a
real compiler. Re-running is a full re-scan of tracked files (idempotent:
existing rows for changed files are replaced, deleted files are pruned).

Usage
  scan_repo_index.py [--repo-root DIR] [--db PATH] [--quiet]

Exit 0 on success; 2 on usage/IO error.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "lib"))
from repo_index_schema import connect, set_meta  # noqa: E402

EXTENSIONS = {
    ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python",
    ".sh": "bash",
}

EXCLUDE_DIR_PARTS = {"node_modules", "dist", "build", ".git", "coverage", "__pycache__"}

MAX_CHUNK_LINES = 200  # cap for file regions with no matched symbol (whole-file fallback)

# ── language-specific symbol patterns ────────────────────────────────────────

_TS_SYMBOL = re.compile(
    r"^\s*export\s+(?:default\s+)?"
    r"(?:async\s+)?(?:function\*?\s+(?P<fn>[A-Za-z_$][\w$]*)"
    r"|class\s+(?P<cls>[A-Za-z_$][\w$]*)"
    r"|interface\s+(?P<iface>[A-Za-z_$][\w$]*)"
    r"|(?:const|function\s+(?!\*))\s*(?P<const>[A-Za-z_$][\w$]*)\s*[:=])"
    r"|^\s*(?:async\s+)?function\*?\s+(?P<fn2>[A-Za-z_$][\w$]*)\s*\("
    r"|^\s*class\s+(?P<cls2>[A-Za-z_$][\w$]*)"
)
_PY_SYMBOL = re.compile(r"^(?P<indent>\s*)(?:async\s+)?def\s+(?P<fn>\w+)\s*\(|^(?P<indent2>\s*)class\s+(?P<cls>\w+)\s*[:(]")
_SH_SYMBOL = re.compile(r"^\s*(?:function\s+)?(?P<fn>[A-Za-z_][\w-]*)\s*\(\)\s*\{")

_TS_IMPORT = re.compile(r"^\s*import\s+.*?\bfrom\s+['\"](?P<spec>[^'\"]+)['\"]|^\s*(?:const|import)\s+.*?require\(\s*['\"](?P<spec2>[^'\"]+)['\"]\s*\)")
_PY_IMPORT = re.compile(r"^\s*(?:from\s+(?P<mod>[\w.]+)\s+import|import\s+(?P<mod2>[\w.]+))")


def _tracked_files(root: str) -> list[str]:
    out = subprocess.run(
        ["git", "-C", root, "ls-files"], capture_output=True, text=True, check=True,
    ).stdout
    files = []
    for rel in out.splitlines():
        ext = os.path.splitext(rel)[1]
        if ext not in EXTENSIONS:
            continue
        parts = set(rel.split("/"))
        if parts & EXCLUDE_DIR_PARTS:
            continue
        files.append(rel)
    return files


def _brace_end(lines: list[str], start_idx: int) -> int:
    """Best-effort matching-brace end line (0-based, inclusive) for a JS/TS block."""
    depth = 0
    seen_open = False
    for i in range(start_idx, len(lines)):
        for ch in lines[i]:
            if ch == "{":
                depth += 1
                seen_open = True
            elif ch == "}":
                depth -= 1
        if seen_open and depth <= 0:
            return i
    return min(start_idx + 40, len(lines) - 1)  # no brace found — bounded fallback span


def _indent_end(lines: list[str], start_idx: int, indent: int) -> int:
    """End line (0-based, inclusive) of a Python block: next non-blank line at <= indent."""
    for i in range(start_idx + 1, len(lines)):
        stripped = lines[i].strip()
        if not stripped:
            continue
        cur_indent = len(lines[i]) - len(lines[i].lstrip(" "))
        if cur_indent <= indent:
            return i - 1
    return len(lines) - 1


def _extract_ts(lines: list[str]) -> list[dict]:
    symbols = []
    for i, line in enumerate(lines):
        m = _TS_SYMBOL.match(line)
        if not m:
            continue
        name = m.group("fn") or m.group("cls") or m.group("iface") or m.group("const") or m.group("fn2") or m.group("cls2")
        if not name:
            continue
        kind = "class" if (m.group("cls") or m.group("cls2")) else "interface" if m.group("iface") else "function" if (m.group("fn") or m.group("fn2")) else "const"
        end = _brace_end(lines, i) if "{" in line or kind in ("function", "class") else min(i + 1, len(lines) - 1)
        symbols.append({"name": name, "kind": kind, "line_start": i + 1, "line_end": end + 1, "signature": line.strip()[:200]})
    return symbols


def _extract_py(lines: list[str]) -> list[dict]:
    symbols = []
    for i, line in enumerate(lines):
        m = _PY_SYMBOL.match(line)
        if not m:
            continue
        name = m.group("fn") or m.group("cls")
        indent_str = m.group("indent") if m.group("fn") else m.group("indent2")
        indent = len(indent_str) if indent_str else 0
        kind = "function" if m.group("fn") else "class"
        end = _indent_end(lines, i, indent)
        symbols.append({"name": name, "kind": kind, "line_start": i + 1, "line_end": end + 1, "signature": line.strip()[:200]})
    return symbols


def _extract_sh(lines: list[str]) -> list[dict]:
    symbols = []
    for i, line in enumerate(lines):
        m = _SH_SYMBOL.match(line)
        if not m:
            continue
        end = _brace_end(lines, i)
        symbols.append({"name": m.group("fn"), "kind": "function", "line_start": i + 1, "line_end": end + 1, "signature": line.strip()[:200]})
    return symbols


def _extract_imports(lines: list[str], lang: str) -> list[tuple[int, str]]:
    pattern = _TS_IMPORT if lang in ("typescript", "javascript") else _PY_IMPORT if lang == "python" else None
    if not pattern:
        return []
    out = []
    for i, line in enumerate(lines):
        m = pattern.match(line)
        if not m:
            continue
        spec = next((g for g in m.groups() if g), None)
        if spec:
            out.append((i + 1, spec))
    return out


def scan(root: str, db_path: str, quiet: bool = False) -> dict:
    conn = connect(db_path)
    files = _tracked_files(root)

    conn.execute("DELETE FROM symbols")
    conn.execute("DELETE FROM refs")
    conn.execute("DELETE FROM chunks")
    conn.execute("DELETE FROM tests")

    n_symbols = n_refs = n_chunks = n_tests = 0

    for rel in files:
        abs_path = os.path.join(root, rel)
        ext = os.path.splitext(rel)[1]
        lang = EXTENSIONS[ext]
        try:
            with open(abs_path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            continue
        lines = text.split("\n")

        if lang in ("typescript", "javascript"):
            symbols = _extract_ts(lines)
        elif lang == "python":
            symbols = _extract_py(lines)
        else:
            symbols = _extract_sh(lines)

        symbol_ids_by_span: list[tuple[int, int, int]] = []  # (line_start, line_end, symbol_id)
        for sym in symbols:
            cur = conn.execute(
                "INSERT OR REPLACE INTO symbols(file, name, kind, lang, line_start, line_end, signature) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (rel, sym["name"], sym["kind"], lang, sym["line_start"], sym["line_end"], sym["signature"]),
            )
            n_symbols += 1
            symbol_ids_by_span.append((sym["line_start"], sym["line_end"], cur.lastrowid))

        for line_no, spec in _extract_imports(lines, lang):
            conn.execute(
                "INSERT OR IGNORE INTO refs(file, line, name, kind) VALUES (?, ?, ?, 'import')",
                (rel, line_no, spec),
            )
            n_refs += 1

        # chunks: one per symbol span, plus fixed-size windows over any leftover lines
        covered = [False] * (len(lines) + 1)
        for start, end, sym_id in symbol_ids_by_span:
            chunk_text = "\n".join(lines[start - 1:end])
            conn.execute(
                "INSERT OR REPLACE INTO chunks(file, start_line, end_line, symbol_id, token_count, text) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (rel, start, end, sym_id, len(chunk_text.split()), chunk_text),
            )
            n_chunks += 1
            for ln in range(start, min(end, len(lines)) + 1):
                if ln <= len(lines):
                    covered[ln] = True

        if not symbol_ids_by_span:
            for win_start in range(0, len(lines), MAX_CHUNK_LINES):
                win_end = min(win_start + MAX_CHUNK_LINES, len(lines))
                chunk_text = "\n".join(lines[win_start:win_end])
                if not chunk_text.strip():
                    continue
                conn.execute(
                    "INSERT OR REPLACE INTO chunks(file, start_line, end_line, symbol_id, token_count, text) "
                    "VALUES (?, ?, ?, NULL, ?, ?)",
                    (rel, win_start + 1, win_end, len(chunk_text.split()), chunk_text),
                )
                n_chunks += 1

        base = os.path.basename(rel)
        is_test = (
            re.search(r"\.test\.[jt]sx?$", base)
            or re.search(r"\.spec\.[jt]sx?$", base)
            or base.startswith("test_")
            or "/tests/" in rel
            or rel.startswith("tests/")
        )
        if is_test:
            guess = base
            guess = re.sub(r"\.test(\.[jt]sx?)$", r"\1", guess)
            guess = re.sub(r"\.spec(\.[jt]sx?)$", r"\1", guess)
            guess = re.sub(r"^test_", "", guess)
            guess = re.sub(r"\.py$", "", guess)
            source_guess = None
            row = conn.execute(
                "SELECT file FROM symbols WHERE file LIKE ? LIMIT 1", (f"%{guess}%",)
            ).fetchone()
            if row:
                source_guess = row[0]
            names = re.findall(r"""\b(?:it|test|describe)\(\s*['"`]([^'"`]+)['"`]""", text)
            names += re.findall(r"^\s*def\s+(test_\w+)", text, re.MULTILINE)
            if not names:
                names = [base]
            for name in names:
                conn.execute(
                    "INSERT OR IGNORE INTO tests(test_file, source_file, name) VALUES (?, ?, ?)",
                    (rel, source_guess, name[:200]),
                )
                n_tests += 1

    set_meta(conn, "last_scan_epoch", str(int(time.time())))
    set_meta(conn, "last_scan_files", str(len(files)))
    conn.commit()
    conn.close()

    if not quiet:
        print(f"scan_repo_index: {len(files)} files -> {n_symbols} symbols, {n_refs} refs, {n_chunks} chunks, {n_tests} tests")
    return {"files": len(files), "symbols": n_symbols, "refs": n_refs, "chunks": n_chunks, "tests": n_tests}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
    parser.add_argument("--db", default=None)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    root = os.path.abspath(args.repo_root)
    db_path = args.db or os.path.join(root, "state", ".repo_index.sqlite3")
    os.makedirs(os.path.dirname(db_path), exist_ok=True)

    try:
        scan(root, db_path, quiet=args.quiet)
    except subprocess.CalledProcessError as e:
        sys.exit(f"scan_repo_index: git ls-files failed: {e.stderr.strip() if e.stderr else e}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
