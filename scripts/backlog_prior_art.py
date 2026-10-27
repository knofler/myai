#!/usr/bin/env python3
"""backlog_prior_art.py — pop-time "has this already shipped?" check for
config/runner_backlog.jsonl items.

THE LEAK THIS CLOSES
--------------------
The backlog well is drafted by the PLANNER task and consumed weeks later by
queue_topup.sh's pop path. The PLANNER *does* check for already-shipped work
— by hand, at DRAFT time (its refill comments carry lines like
"'DASHBOARD: task-defer-alerter has no operator-facing surface' -> shipped
358ef31"). Nothing re-checks at POP time. So a line drafted on 2026-07-29,
implemented by somebody else on 2026-07-31, and popped on 2026-09-03 reaches
the runner as live work.

That is not hypothetical: on 2026-09-03 four of five runner sessions burned a
full budget each re-verifying already-shipped work (tasks 65dd6952, 64419f62,
4fdbb5d5, 24311b61), each ending in a `docs(plan): re-verify` commit and a
hand-removal of the stale seed line. Commit 6f438513 did the same thing a
cycle earlier. Deleting one line per incident treats the symptom.

WHY THIS ADVISES INSTEAD OF SKIPPING
------------------------------------
Measured on this repo's own history (1353 commit subjects, 2026-06-01+), the
overlap coefficient between a backlog title and the commit that actually
shipped it ranks that commit **#1 of 1353** for both confirmed duplicates —
but only at 0.50 and 0.80 absolute. Meanwhile 67 of 120 recent lines also
score >=0.70 against *some* commit. It is a strong RANKER and a weak
CLASSIFIER: no threshold separates "already shipped" from "merely similar".

So this never drops an item. It attaches the top-ranked candidate commit to
the task description as PRIOR ART, with an instruction to check that one
commit first and stop early if it already covers the ask. The expensive
failure mode (a full implement-and-verify session) collapses into a two
minute `git show`, and a false positive costs only that lookup — whereas an
auto-skip would silently drop real work on a signal demonstrably too noisy
to bear that weight.

Usage
  # advisory lookup for one item (exit 0 always; prints nothing when no hit)
  scripts/backlog_prior_art.py --repo ai_management --title "DASHBOARD: ..."

  # since-date bound: only consider commits landed at/after the draft date
  scripts/backlog_prior_art.py --repo ai_management --title "..." --since 2026-07-29

  # machine-readable, for queue_topup.sh
  scripts/backlog_prior_art.py --repo X --title "..." --json

Options
  --repo NAME        backlog item's repo (resolved to a checkout via
                      config/managed_repos.txt / REPO_PATHS_FILE)
  --title TEXT       the backlog item title
  --since YYYY-MM-DD only consider commits on/after this date (the line's
                      draft date; omit to scan the whole window)
  --threshold FLOAT  minimum overlap to report (default 0.45 — below the 0.50
                      of the weaker confirmed case, so both are caught)
  --window N         how many days back to scan when --since is absent (180)
  --json             emit JSON instead of the human preamble
  --repo-root PATH   explicit checkout path, bypassing roster resolution

Exit codes: always 0 unless a usage error (2). This is advisory by design —
it must never be able to fail a top-up cycle.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
# Single source of truth for the metric — same tokenizer/stopwords the
# draft-time checker uses, so the two stages agree on what "similar" means.
from backlog_dupe_check import tokenize, overlap_coefficient  # noqa: E402

# Bookkeeping commits quote backlog titles verbatim (planner refills) or
# describe the duplicate-dispatch cleanup itself (`docs(plan): re-verify`).
# Both would match near-perfectly and mean the opposite of "already shipped",
# so they are never prior art.
SKIP_PREFIXES = (
    "chore(planner)",
    "chore: update state",
    "chore(state)",
    "docs(state)",
    "docs(plan): re-verify",
    "Merge ",
    "Revert ",
)


def resolve_repo_root(repo: str, explicit: str | None) -> str | None:
    """Map a backlog `repo` name to a local checkout, or None."""
    if explicit:
        return explicit if os.path.exists(os.path.join(explicit, ".git")) else None
    roster = os.environ.get("MANAGED_REPOS_FILE") or os.path.join(
        os.path.dirname(_HERE), "config", "managed_repos.txt"
    )
    candidates = []
    if os.path.isfile(roster):
        with open(roster) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                candidates.append(os.path.expanduser(line))
    # the master repo itself is the parent of scripts/
    candidates.append(os.path.dirname(_HERE))
    for path in candidates:
        if not os.path.exists(os.path.join(path, ".git")):
            continue
        if os.path.basename(path.rstrip("/")) == repo:
            return path
        # Folder name and GitHub repo name diverge for the master checkout
        # (folder `AI`, repo `ai_management`) and for any repo cloned under a
        # different directory name, so fall back to the origin remote.
        if _remote_name(path) == repo:
            return path
    return None


def _remote_name(path: str) -> str | None:
    try:
        url = subprocess.run(
            ["git", "-C", path, "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
    except Exception:
        return None
    if not url:
        return None
    return os.path.basename(url.rstrip("/")).removesuffix(".git")


def commit_corpus(repo_root: str, since: str | None, window_days: int):
    """[(sha8, date, subject, tokens)] for candidate prior-art commits."""
    if not since:
        since = (
            _dt.date.today() - _dt.timedelta(days=window_days)
        ).isoformat()
    try:
        out = subprocess.run(
            ["git", "-C", repo_root, "log", "--no-merges",
             "--format=%H\t%ad\t%s", "--date=short", f"--since={since}"],
            capture_output=True, text=True, timeout=30,
        ).stdout
    except Exception:
        return []
    rows = []
    for line in out.splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        sha, date, subj = parts
        if subj.startswith(SKIP_PREFIXES):
            continue
        toks = tokenize(subj)
        if toks:
            rows.append((sha[:8], date, subj, toks))
    return rows


def best_match(title: str, corpus):
    ct = tokenize(title)
    if not ct:
        return None
    best = None
    for sha, date, subj, st in corpus:
        score = overlap_coefficient(ct, st)
        if best is None or score > best[0]:
            best = (score, sha, date, subj)
    return best


def preamble(score: float, sha: str, date: str, subj: str) -> str:
    """The text prepended to the task description at pop time."""
    return (
        f"PRIOR ART CHECK (automated, {score:.0%} title match) — commit {sha} "
        f"({date}) \"{subj}\" may already deliver this. This backlog line was "
        f"drafted before that commit landed. FIRST ACTION: `git show --stat "
        f"{sha}` and check whether the ask below is already satisfied. "
        f"If it IS: remove this item's line from config/runner_backlog.jsonl, "
        f"note the SHA in one line, commit that, and STOP — do not re-implement, "
        f"do not re-run the test suites, and do not write a re-verification "
        f"report — and end your final output with 'RESULT: ALREADY-SHIPPED "
        f"{sha} — <one line>' so the runner closes this task terminally as "
        f"done (resolution: already-shipped) instead of leaving it to "
        f"re-dispatch. If it is NOT (or only partly): say so in one line and "
        f"do the work as normal. This hint is a ranked guess, not a verdict.\n\n"
    )


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--since")
    ap.add_argument("--threshold", type=float, default=0.45)
    ap.add_argument("--window", type=int, default=180)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--repo-root")
    args = ap.parse_args()

    root = resolve_repo_root(args.repo, args.repo_root)
    if not root:
        if args.json:
            print(json.dumps({"match": False, "reason": "repo checkout not found"}))
        return 0

    corpus = commit_corpus(root, args.since, args.window)
    if not corpus:
        if args.json:
            print(json.dumps({"match": False, "reason": "empty commit corpus"}))
        return 0

    best = best_match(args.title, corpus)
    if not best or best[0] < args.threshold:
        if args.json:
            print(json.dumps({
                "match": False,
                "reason": "no candidate above threshold",
                "best": round(best[0], 3) if best else None,
                "scanned": len(corpus),
            }))
        return 0

    score, sha, date, subj = best
    if args.json:
        print(json.dumps({
            "match": True, "score": round(score, 3), "sha": sha,
            "date": date, "subject": subj, "scanned": len(corpus),
            "preamble": preamble(score, sha, date, subj),
        }))
    else:
        sys.stdout.write(preamble(score, sha, date, subj))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # advisory: never break a top-up cycle
        print(json.dumps({"match": False, "reason": f"error: {exc}"}))
        sys.exit(0)
