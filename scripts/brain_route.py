#!/usr/bin/env python3
"""brain_route.py — the BRAIN B-3 three-plane router/dispatcher (deterministic).

Implements the live retrieval control flow from BRAIN_BUILD_PLAN.md §2:

    classify -> route -> locate (SQL over the repo index / vector via sibling)
             -> return LOCATORS not bodies -> (narrow to top-1) -> fetch ONE atom.

DETERMINISTIC-FIRST. This is the "dispatcher, not an answerer" of the §2 policy
plane, built entirely from stdlib + the repo-local SQLite index
(scripts/lib/repo_index_schema.py). The LLM / LoRA-trained router of §2 (policy
plane) and B-7 stays GATED — the B-7.1 spike measured route@1 0.0 / route@3 0.2
on the git-grep baseline and correctly failed the promotion gate (route@1 >= 0.85,
route@3 >= 0.97), so no learned model is wired in here. When that adapter is
trained and clears the gate it can supersede `classify()`; until then the
deterministic heuristic below IS the router.

Two planes, one dispatcher:
  * CODE plane   — exact symbol/ref lookup over the `symbols`/`refs` tables, then
                   the `chunks` row for the best symbol. Returns file:line +
                   symbol name + kind LOCATORS, never file bodies (§2 data plane).
  * MEMORY plane — semantic atom recall via the sibling `hybrid_retrieve.retrieve`
                   (coded against its exact interface); degrades to a direct
                   sparse-only BM25 query over the same DB if that module is not
                   importable at runtime (never crashes — see `_retrieve_atoms`).
  * MIXED        — do both, normalize per-plane scores, merge, cap to k.

`fetch` (the §2 "fetch ONE atom/span" step) is populated ONLY when the candidate
set narrows to a clear top-1; otherwise it is None and the caller chooses from
the returned locators.

Usage
  brain_route.py --query "..." [--k 5] [--db PATH] [--json]

Default db: <repo-root>/state/.repo_index.sqlite3. Missing DB -> exit 2.

Env
  BRAIN_ROUTE_NO_HYBRID=1   force the sparse-only fallback (skip importing the
                            sibling hybrid_retrieve) — used by the test harness
                            to exercise the graceful-degradation path.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys

# ── sibling / shared imports ──────────────────────────────────────────────────
# scripts/ dir first so the sibling `hybrid_retrieve` resolves when present.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))

try:  # shared tokenizer keeps our fallback BM25 terms identical to the indexed ones
    from repo_index_schema import tokenize  # type: ignore
except Exception:  # pragma: no cover - defensive; repo_index_schema is stdlib-only
    def tokenize(text: str) -> list[str]:
        return re.findall(r"[a-z0-9_]+", (text or "").lower())

_HAVE_HYBRID = False
_hybrid_retrieve = None
if not os.environ.get("BRAIN_ROUTE_NO_HYBRID"):
    try:
        from hybrid_retrieve import retrieve as _hybrid_retrieve  # type: ignore
        _HAVE_HYBRID = True
    except Exception:
        _HAVE_HYBRID = False
        _hybrid_retrieve = None


# ── classify ─────────────────────────────────────────────────────────────────

_CODE_KEYWORDS = (
    "function", "class", "import", "def", "const", "interface",
    "export", "async", "return", "var", "let", "type", "enum", "struct",
)
_CODE_EXTENSIONS = (
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "sh", "go", "rs",
    "java", "rb", "c", "cpp", "h", "css", "html", "json", "yml", "yaml",
    "md", "toml", "sql",
)
# temporal / episodic memory phrasing
_MEMORY_PHRASES = (
    "when did i", "when did we", "what changed", "last time", "why did we",
    "why did i", "how did we", "we decided", "we chose", "i decided",
    "previously", "earlier", "yesterday", "remember when", "used to",
    "history of", "back when",
)
_MEMORY_KEYWORDS = ("decision", "decided", "adr", "recall", "remember", "rationale")

_CAMEL_RE = re.compile(r"\b[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*\b")   # camelCase / PascalCase with internal cap
_SNAKE_RE = re.compile(r"\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b")        # snake_case
_PATH_RE = re.compile(r"[\w.\-]+/[\w./\-]+")                     # a/b path-ish token
_EXT_RE = re.compile(r"\b[\w\-]+\.(" + "|".join(_CODE_EXTENSIONS) + r")\b")
_DATE_RE = re.compile(r"\b\d{4}-\d{2}(?:-\d{2})?\b|\bpr\s*#?\d+\b|\b#\d+\b")


def classify(query: str) -> dict:
    """Deterministic plane classifier. Returns {"plane", "signals"}.

    CODE signals: file-extension tokens, path separators, CamelCase/snake_case
    identifiers, code keywords (function/class/import/def/const/interface/...).
    MEMORY signals: temporal/episodic phrasing, dates, decision/ADR keywords.
    Both fire -> "mixed"; neither -> "mixed" (hedge by doing both planes).
    """
    q = query or ""
    ql = q.lower()
    signals: list[str] = []

    # ── code signals ──
    for m in _EXT_RE.finditer(q):
        signals.append(f"code:extension:.{m.group(1)}")
    if _PATH_RE.search(q):
        # avoid firing on dates like 2026-07; require a real slash-joined path
        signals.append("code:path")
    for m in _CAMEL_RE.finditer(q):
        signals.append(f"code:identifier:{m.group(0)}")
    for m in _SNAKE_RE.finditer(q):
        signals.append(f"code:identifier:{m.group(0)}")
    for kw in _CODE_KEYWORDS:
        if re.search(rf"\b{re.escape(kw)}\b", ql):
            signals.append(f"code:keyword:{kw}")

    # ── memory signals ──
    for phrase in _MEMORY_PHRASES:
        if phrase in ql:
            signals.append(f"memory:temporal:{phrase}")
    for kw in _MEMORY_KEYWORDS:
        if re.search(rf"\b{re.escape(kw)}\b", ql):
            signals.append(f"memory:keyword:{kw}")
    if _DATE_RE.search(ql):
        signals.append("memory:date")

    has_code = any(s.startswith("code:") for s in signals)
    has_mem = any(s.startswith("memory:") for s in signals)

    if has_code and has_mem:
        plane = "mixed"
    elif has_code:
        plane = "code"
    elif has_mem:
        plane = "memory"
    else:
        plane = "mixed"
        signals.append("default:no-signal")

    return {"plane": plane, "signals": signals}


# ── locate helpers ─────────────────────────────────────────────────────────────

def _subtokens(name: str) -> set[str]:
    """Split an identifier into lowercase sub-tokens (camelCase + snake_case)."""
    out: set[str] = set()
    for part in re.split(r"[_\-.]+", name):
        for seg in re.findall(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z0-9]+|[A-Z]+", part):
            if seg:
                out.add(seg.lower())
    return out


def _score_name(name: str, qtokens: list[str]) -> float:
    nl = name.lower()
    subs = _subtokens(name)
    score = 0.0
    for t in qtokens:
        if not t:
            continue
        if t == nl:
            score += 10.0
        elif t in subs:
            score += 3.0
        elif len(t) >= 3 and (t in nl or nl in t):
            score += 1.0
    return score


def _code_candidates(conn: sqlite3.Connection, query: str, k: int) -> list[dict]:
    """Symbol + ref locators by deterministic token match. No file bodies."""
    qtokens = tokenize(query)
    if not qtokens:
        return []

    # gather candidate symbol rows via cheap LIKE pre-filter, score in Python
    rows_by_id: dict[int, tuple] = {}
    for t in set(qtokens):
        if len(t) >= 3:
            cur = conn.execute(
                "SELECT id, file, name, kind, line_start, line_end "
                "FROM symbols WHERE lower(name) LIKE ?",
                (f"%{t}%",),
            )
        else:  # short tokens: exact-name only, to avoid LIKE noise
            cur = conn.execute(
                "SELECT id, file, name, kind, line_start, line_end "
                "FROM symbols WHERE lower(name) = ?",
                (t,),
            )
        for r in cur:
            rows_by_id[r[0]] = r

    sym_cands: list[dict] = []
    for sid, file, name, kind, line_start, line_end in rows_by_id.values():
        sc = _score_name(name, qtokens)
        if sc <= 0:
            continue
        sym_cands.append({
            "plane": "code", "doc_type": "symbol", "doc_id": sid,
            "ref": f"{file}:{line_start}", "file": file, "line": line_start,
            "name": name, "kind": kind, "score": sc,
        })
    sym_cands.sort(key=lambda c: (-c["score"], len(c["name"]), c["ref"]))

    # refs are a weaker hint (import specs / usages) — appended after symbols
    ref_seen: set[tuple] = set()
    ref_cands: list[dict] = []
    for t in set(qtokens):
        if len(t) < 3:
            continue
        cur = conn.execute(
            "SELECT file, line, name, kind FROM refs WHERE lower(name) LIKE ?",
            (f"%{t}%",),
        )
        for file, line, name, kind in cur:
            key = (file, line, name)
            if key in ref_seen:
                continue
            ref_seen.add(key)
            sc = _score_name(name, qtokens)
            if sc <= 0:
                continue
            ref_cands.append({
                "plane": "code", "doc_type": "ref", "doc_id": None,
                "ref": f"{file}:{line}", "file": file, "line": line,
                "name": name, "kind": kind or "import", "score": sc * 0.5,
            })
    ref_cands.sort(key=lambda c: (-c["score"], c["ref"]))

    return (sym_cands + ref_cands)[:k]


def _fetch_symbol_chunk(conn: sqlite3.Connection, cand: dict) -> dict | None:
    """The §2 single-span fetch: ONE chunk body for the winning symbol."""
    row = conn.execute(
        "SELECT id, start_line, end_line, text FROM chunks "
        "WHERE symbol_id = ? ORDER BY start_line LIMIT 1",
        (cand["doc_id"],),
    ).fetchone()
    if not row:
        return None
    cid, start, end, text = row
    return {
        "plane": "code", "doc_type": "chunk", "doc_id": cid,
        "ref": f"{cand['file']}:{start}-{end}",
        "name": cand.get("name"), "kind": cand.get("kind"), "text": text,
    }


# ── memory plane retrieval (sibling hybrid_retrieve, with sparse fallback) ──────

def _sparse_retrieve_atoms(db_path: str, query: str, k: int) -> list[dict]:
    """Direct sparse-only BM25 over `atoms` — the graceful degradation path.

    Mirrors the hybrid_retrieve output contract exactly:
      {"doc_type","doc_id","ref","score","snippet"}
    so callers are backend-agnostic. Uses the same tokenizer build_sparse_index.py
    used, so query terms line up with the indexed postings.
    """
    import math

    qterms = [t for t in tokenize(query)]
    if not qterms:
        return []
    conn = sqlite3.connect(db_path)
    try:
        n_row = conn.execute(
            "SELECT COUNT(*) FROM doc_stats WHERE doc_type = 'atom'"
        ).fetchone()
        N = n_row[0] if n_row else 0
        if not N:
            return []
        avg_row = conn.execute(
            "SELECT AVG(length) FROM doc_stats WHERE doc_type = 'atom'"
        ).fetchone()
        avgdl = (avg_row[0] or 1.0) if avg_row else 1.0

        k1, b = 1.5, 0.75
        scores: dict[int, float] = {}
        for term in set(qterms):
            postings = conn.execute(
                "SELECT doc_id, tf FROM sparse_terms "
                "WHERE term = ? AND doc_type = 'atom'",
                (term,),
            ).fetchall()
            df = len(postings)
            if df == 0:
                continue
            idf = math.log((N - df + 0.5) / (df + 0.5) + 1.0)
            for doc_id, tf in postings:
                dl_row = conn.execute(
                    "SELECT length FROM doc_stats WHERE doc_type = 'atom' AND doc_id = ?",
                    (doc_id,),
                ).fetchone()
                dl = dl_row[0] if dl_row else avgdl
                denom = tf + k1 * (1 - b + b * (dl / avgdl))
                scores[doc_id] = scores.get(doc_id, 0.0) + idf * (tf * (k1 + 1)) / denom

        ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))[:k]
        out: list[dict] = []
        for doc_id, score in ranked:
            row = conn.execute(
                "SELECT atom_path, excerpt FROM atoms WHERE id = ?", (doc_id,)
            ).fetchone()
            atom_path = row[0] if row else str(doc_id)
            excerpt = (row[1] if row and row[1] else "")
            out.append({
                "doc_type": "atom", "doc_id": doc_id, "ref": atom_path,
                "score": round(score, 6), "snippet": excerpt[:200],
            })
        return out
    finally:
        conn.close()


def _retrieve_atoms(db_path: str, query: str, k: int) -> tuple[list[dict], str]:
    """Return (atom_hits, backend). Prefer the sibling; degrade gracefully."""
    if _HAVE_HYBRID and _hybrid_retrieve is not None:
        try:
            hits = _hybrid_retrieve(db_path, query, k=k, doc_types=["atom"])
            return list(hits or []), "hybrid"
        except Exception as exc:  # sibling present but broke — degrade, don't crash
            hits = _sparse_retrieve_atoms(db_path, query, k)
            return hits, f"sparse-fallback (hybrid_retrieve error: {type(exc).__name__})"
    hits = _sparse_retrieve_atoms(db_path, query, k)
    reason = "sparse-fallback (hybrid_retrieve unavailable)"
    return hits, reason


def _memory_candidates(atom_hits: list[dict]) -> list[dict]:
    cands: list[dict] = []
    for h in atom_hits:
        c = dict(h)
        c["plane"] = "memory"
        c.setdefault("doc_type", "atom")
        c.setdefault("score", 0.0)
        cands.append(c)
    return cands


def _fetch_atom(conn: sqlite3.Connection, cand: dict) -> dict:
    """Fetch ONE atom body for the winning memory candidate."""
    text = cand.get("snippet") or ""
    doc_id = cand.get("doc_id")
    ref = cand.get("ref")
    if doc_id is not None:
        row = conn.execute(
            "SELECT atom_path, excerpt FROM atoms WHERE id = ?", (doc_id,)
        ).fetchone()
        if row:
            ref = row[0] or ref
            if row[1]:
                text = row[1]
    return {"plane": "memory", "doc_type": "atom", "doc_id": doc_id,
            "ref": ref, "text": text}


# ── clear-top-1 gate ────────────────────────────────────────────────────────────

def _clear_top1(cands: list[dict], key: str = "score") -> bool:
    """True when the candidate set has narrowed to an unambiguous winner."""
    if not cands:
        return False
    if cands[0].get(key, 0) <= 0:
        return False
    if len(cands) == 1:
        return True
    s0 = cands[0].get(key, 0)
    s1 = cands[1].get(key, 0)
    if s1 <= 0:
        return True
    return s0 >= 1.5 * s1


# ── route ────────────────────────────────────────────────────────────────────

def route(query: str, db_path: str, k: int = 5) -> dict:
    """Dispatch a query to the right plane and return locators (+ maybe one fetch).

    Return shape: {"plane","reason","locators","fetch","signals","retrieval_backend"}.
    `fetch` is non-None only when the candidate set narrows to a clear top-1.
    """
    cls = classify(query)
    plane = cls["plane"]
    signals = cls["signals"]

    conn = sqlite3.connect(db_path)
    backend = "n/a"
    fetch = None
    try:
        if plane == "code":
            locators = _code_candidates(conn, query, k)
            reason = f"code plane: {len(locators)} symbol/ref candidate(s) by token match"
            syms = [c for c in locators if c["doc_type"] == "symbol"]
            if _clear_top1(syms):
                fetch = _fetch_symbol_chunk(conn, syms[0])

        elif plane == "memory":
            atom_hits, backend = _retrieve_atoms(db_path, query, k)
            locators = _memory_candidates(atom_hits)[:k]
            reason = f"memory plane: {len(locators)} atom candidate(s) via {backend}"
            if _clear_top1(locators):
                fetch = _fetch_atom(conn, locators[0])

        else:  # mixed
            code_cands = _code_candidates(conn, query, k)
            atom_hits, backend = _retrieve_atoms(db_path, query, k)
            mem_cands = _memory_candidates(atom_hits)
            _normalize(code_cands)
            _normalize(mem_cands)
            merged = sorted(
                code_cands + mem_cands,
                key=lambda c: (-c.get("_n", 0.0), c.get("ref", "")),
            )[:k]
            reason = (
                f"mixed plane: merged {len(code_cands)} code + "
                f"{len(mem_cands)} memory candidate(s) via {backend}, capped to {k}"
            )
            if _clear_top1(merged, key="_n"):
                top = merged[0]
                if top["plane"] == "code" and top["doc_type"] == "symbol":
                    fetch = _fetch_symbol_chunk(conn, top)
                elif top["plane"] == "memory":
                    fetch = _fetch_atom(conn, top)
            for c in merged:
                c.pop("_n", None)
            locators = merged
    finally:
        conn.close()

    return {
        "plane": plane,
        "reason": reason,
        "locators": locators,
        "fetch": fetch,
        "signals": signals,
        "retrieval_backend": backend,
    }


def _normalize(cands: list[dict]) -> None:
    mx = max((c.get("score", 0.0) for c in cands), default=0.0)
    for c in cands:
        c["_n"] = (c.get("score", 0.0) / mx) if mx > 0 else 0.0


# ── CLI ────────────────────────────────────────────────────────────────────────

def _default_db() -> str:
    root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    return os.path.join(root, "state", ".repo_index.sqlite3")


def _print_human(result: dict) -> None:
    print(f"plane: {result['plane']}   ({result['reason']})")
    print(f"signals: {', '.join(result['signals']) or '(none)'}")
    if result["retrieval_backend"] not in ("n/a", None):
        print(f"backend: {result['retrieval_backend']}")
    print(f"locators ({len(result['locators'])}):")
    for i, loc in enumerate(result["locators"], 1):
        name = loc.get("name") or loc.get("ref")
        kind = loc.get("kind", loc.get("doc_type"))
        print(f"  {i}. [{loc['doc_type']}] {loc['ref']}  {name} ({kind})  score={loc.get('score')}")
    if result["fetch"]:
        f = result["fetch"]
        body = (f.get("text") or "").strip().replace("\n", " ")
        if len(body) > 160:
            body = body[:160] + "…"
        print(f"fetch (clear top-1): [{f['doc_type']}] {f['ref']}")
        print(f"  {body}")
    else:
        print("fetch: none (candidate set not narrowed — caller chooses)")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="BRAIN B-3 deterministic router/dispatcher")
    parser.add_argument("--query", required=True, help="the natural-language / code query")
    parser.add_argument("--k", type=int, default=5, help="max locators to return")
    parser.add_argument("--db", default=None, help="path to the repo index SQLite DB")
    parser.add_argument("--json", action="store_true", help="emit JSON instead of human text")
    args = parser.parse_args(argv)

    db_path = args.db or _default_db()
    if not os.path.isfile(db_path):
        print(
            f"brain_route: no DB at {db_path} — run scan_repo_index.py first",
            file=sys.stderr,
        )
        return 2

    result = route(args.query, db_path, k=args.k)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        _print_human(result)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
