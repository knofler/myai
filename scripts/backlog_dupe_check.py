#!/usr/bin/env python3
"""backlog_dupe_check.py — lightweight near-duplicate title detector for
config/runner_backlog.jsonl.

The backlog well (config/runner_backlog.jsonl) is regenerated/extended by the
PLANNER task every time it runs low (see scripts/queue_topup.sh). Each run has
no fast way to tell whether a freshly-drafted title already exists under
different wording in the 700+ existing lines — grepping for it by hand burns
most of a session's budget. This script gives PLANNER (or any session) a cheap
pre-append check: token-overlap similarity between a drafted candidate batch
and the existing backlog, run once before appending.

Deliberately stdlib-only, no embeddings/network calls (same "cheap floor, not
the target retrieval path" tradeoff as scripts/embed_atoms.py) — this only
needs to catch obvious rewordings ("add X" vs "implement X for Y"), not
subtle semantic dupes. A human/agent still makes the final drop decision.

Similarity metric: overlap coefficient on stopword-filtered token sets,
  |tokens(a) ∩ tokens(b)| / min(|tokens(a)|, |tokens(b)|)
chosen over plain Jaccard because a verbose reworded title (superset of a
short existing title's tokens) still scores high — exactly the "different
wording" case this exists to catch. Comparisons are scoped to same-repo
pairs by default (titles across repos legitimately reuse the same terms).

Usage
  # check a drafted batch against the existing backlog before appending:
  scripts/backlog_dupe_check.py --candidates draft.jsonl
  cat draft.jsonl | scripts/backlog_dupe_check.py --candidates -

  # find near-duplicate pairs already sitting inside the backlog itself:
  scripts/backlog_dupe_check.py --self-check

Options
  --backlog PATH     path to the backlog JSONL (default: config/runner_backlog.jsonl)
  --candidates PATH  drafted batch JSONL to check, or '-' for stdin (required
                      unless --self-check)
  --threshold FLOAT  overlap-coefficient flag threshold, 0..1 (default: 0.6)
  --global           compare across all repos, not just same-repo pairs
  --self-check       find near-duplicate pairs within --backlog itself
  --json             emit machine-readable JSON instead of a text report

Exit codes: 0 = no likely dupes found, 1 = likely dupes found (flagged),
2 = usage/IO error.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

STOPWORDS = {
    "a", "an", "the", "and", "or", "of", "to", "in", "on", "with", "for",
    "from", "into", "via", "as", "is", "are", "be", "this", "that", "it",
    "its", "at", "by", "so", "than", "then", "over", "per", "up", "down",
    "own", "not", "no", "do", "does", "did",
}

TOKEN_RE = re.compile(r"[a-z0-9]+")


def tokenize(title: str) -> set:
    words = TOKEN_RE.findall(title.lower())
    return {w for w in words if w not in STOPWORDS}


def overlap_coefficient(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


def load_jsonl(path: str, label: str):
    """Return list of dicts: {repo, title, tokens, line, source}. Skips
    blank/comment lines and warns (to stderr) on malformed JSON rather than
    aborting the whole run — the backlog is hand-edited across many PLANNER
    passes and one bad line shouldn't block the check."""
    if path == "-":
        raw = sys.stdin.read().splitlines()
        source = "<stdin>"
    else:
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = f.read().splitlines()
        except OSError as e:
            print(f"error: cannot read {label} {path!r}: {e}", file=sys.stderr)
            sys.exit(2)
        source = path

    entries = []
    for lineno, line in enumerate(raw, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError as e:
            print(f"warning: {label} {source}:{lineno} skipped (invalid JSON: {e})", file=sys.stderr)
            continue
        title = obj.get("title", "")
        if not title:
            print(f"warning: {label} {source}:{lineno} skipped (no title)", file=sys.stderr)
            continue
        entries.append({
            "repo": obj.get("repo", "ai_management"),
            "title": title,
            "tokens": tokenize(title),
            "line": lineno,
            "source": source,
        })
    return entries


def find_matches(candidates, existing, threshold, scope_by_repo):
    """For each candidate, find the best-scoring existing entry. Return a
    flagged list (score >= threshold), best match attached to each."""
    flagged = []
    for cand in candidates:
        pool = existing if not scope_by_repo else [
            e for e in existing if e["repo"] == cand["repo"]
        ]
        best = None
        best_score = 0.0
        for e in pool:
            score = overlap_coefficient(cand["tokens"], e["tokens"])
            if score > best_score:
                best_score = score
                best = e
        if best is not None and best_score >= threshold:
            flagged.append({
                "candidate_title": cand["title"],
                "candidate_repo": cand["repo"],
                "candidate_line": cand["line"],
                "match_title": best["title"],
                "match_repo": best["repo"],
                "match_line": best["line"],
                "score": round(best_score, 3),
            })
    return flagged


def find_self_duplicates(existing, threshold, scope_by_repo):
    """Pairwise near-duplicate scan within the backlog itself (i < j only,
    each pair reported once)."""
    flagged = []
    n = len(existing)
    for i in range(n):
        for j in range(i + 1, n):
            a, b = existing[i], existing[j]
            if scope_by_repo and a["repo"] != b["repo"]:
                continue
            score = overlap_coefficient(a["tokens"], b["tokens"])
            if score >= threshold:
                flagged.append({
                    "candidate_title": b["title"],
                    "candidate_repo": b["repo"],
                    "candidate_line": b["line"],
                    "match_title": a["title"],
                    "match_repo": a["repo"],
                    "match_line": a["line"],
                    "score": round(score, 3),
                })
    return flagged


def report(flagged, as_json, backlog_path):
    if as_json:
        print(json.dumps(flagged, indent=2))
        return
    if not flagged:
        print("no likely near-duplicates found")
        return
    print(f"{len(flagged)} likely near-duplicate title(s) flagged (threshold-based, verify before dropping):\n")
    for f in flagged:
        print(f"  [{f['score']}] candidate ({f['candidate_repo']}, line {f['candidate_line']}):")
        print(f"        {f['candidate_title']!r}")
        print(f"      ~= existing ({f['match_repo']}, {backlog_path}:{f['match_line']}):")
        print(f"        {f['match_title']!r}")
        print()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--backlog", default=None, help="path to existing backlog JSONL (default: config/runner_backlog.jsonl relative to repo root)")
    parser.add_argument("--candidates", default=None, help="drafted batch JSONL to check, or '-' for stdin")
    parser.add_argument("--threshold", type=float, default=0.6, help="overlap-coefficient flag threshold, 0..1 (default: 0.6)")
    parser.add_argument("--global", dest="global_scope", action="store_true", help="compare across all repos, not just same-repo pairs")
    parser.add_argument("--self-check", action="store_true", help="find near-duplicate pairs within --backlog itself")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = parser.parse_args()

    if not args.self_check and not args.candidates:
        parser.error("--candidates is required unless --self-check is set")
    if not (0.0 <= args.threshold <= 1.0):
        parser.error("--threshold must be between 0 and 1")

    if args.backlog:
        backlog_path = args.backlog
    else:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        backlog_path = os.path.join(root, "config", "runner_backlog.jsonl")

    existing = load_jsonl(backlog_path, "backlog")
    scope_by_repo = not args.global_scope

    if args.self_check:
        flagged = find_self_duplicates(existing, args.threshold, scope_by_repo)
    else:
        candidates = load_jsonl(args.candidates, "candidates")
        flagged = find_matches(candidates, existing, args.threshold, scope_by_repo)

    report(flagged, args.json, backlog_path)
    sys.exit(1 if flagged else 0)


if __name__ == "__main__":
    main()
