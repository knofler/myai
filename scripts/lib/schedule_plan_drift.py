#!/usr/bin/env python3
"""schedule_plan_drift.py — ground-truth cross-check between a repo's
registered `plan_set` day-by-day schedule (PlanDay collection, dashboard
/plan) and its actual task queue (Task collection, `tasks_list`) (task-
cea1ef6f).

WHY: several handoffs (connect 2026-07-06, agentFlow S57) describe a repo's
10-day plan_set slice going stale or getting silently superseded by a later
bulk-queue event — the plan still SAYS "day 4: add rate limiting" but the
actual task queue was bulk-replaced with unrelated work, or a plan day was
marked `done` on the dashboard without any task ever actually shipping that
work. Nothing cross-checked the two stores against each other; the drift was
only ever found by a human eyeballing the /plan dashboard next to /tasks.

This is that cross-check. For every repo that has at least one registered
plan day, it diffs the plan against the task queue and flags two kinds of
drift, matching plan-day `focus` text against task `title` text via
normalized-token overlap (exact string equality is not expected — a plan
day's focus is prose, a task title is a short imperative — so this uses a
fuzzy match, see `titles_match`):

  day-done-no-shipped-task  — a plan day is marked `done` but no task in that
                               repo, with status `done`, has a title that
                               matches the day's focus. Either the day was
                               marked done by hand without real work shipping,
                               or the shipped task's title drifted so far from
                               the plan's wording that nothing traces back.

  queued-task-no-plan-day   — a task is actively queued (pending/working/
                               review) but no plan day in that repo (any
                               status) has a focus matching its title. This is
                               the "silently superseded by a later bulk-queue
                               event" case: real work is queued that the
                               registered plan never accounted for.

Only repos with a registered plan (>=1 PlanDay) are considered — a repo that
has never called plan_set has no plan to drift against, so its tasks are
out of scope for the queued-task-no-plan-day check.

READ-ONLY: this module (and its wrapper, schedule_plan_drift_check.sh) never
calls plan_set / tasks_update / any mutating tool. It only reports. No
auto-reconciliation — a human decides whether to update the plan or the
queue.

FAIL LOUDLY (unlike the silent self-checks such as pool_capacity_drift.py):
exit 1 when drift is found, so a scheduled/CI run surfaces it as a visible
failure instead of a line buried in a log a human has to go looking for.

Usage:
  schedule_plan_drift.py <input.json> [--threshold 0.34] [--status-out PATH]

Input JSON shape (produced by schedule_plan_drift_check.sh from plan_list +
tasks_list, or built by hand in tests):
  {
    "days":  [{"repo": "...", "day": 1, "focus": "...", "status": "enabled|disabled|done|blocked"}, ...],
    "tasks": [{"repo": "...", "title": "...", "status": "pending|working|review|done|blocked|paused|dead_letter", "taskId": "..."}, ...]
  }

Exit codes:
  0  no drift found (may still print OK lines per repo)
  1  drift found (fail loudly — the caller should surface this)
  2  usage / input error (missing or malformed input file)
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone

QUEUED_STATUSES = {"pending", "working", "review"}
SHIPPED_STATUS = "done"
DEFAULT_THRESHOLD = 0.34

# Small stopword set — enough to strip filler words common in both plan focus
# prose ("Add X to Y") and task titles ("Implement X for Y") without needing
# an NLP dependency. Not exhaustive by design: over-stripping just widens
# false-positive matches, which is the safer failure direction for a report
# a human still has to read.
STOPWORDS = {
    "the", "and", "for", "with", "add", "to", "of", "on", "in", "a", "an",
    "is", "are", "this", "that", "from", "into", "via", "up", "it", "its",
    "by", "as", "or", "be", "at",
}


def normalize_tokens(text):
    """Lowercase, extract alnum runs, drop stopwords and 1-2 char noise."""
    text = (text or "").lower()
    tokens = re.findall(r"[a-z0-9]+", text)
    return {t for t in tokens if len(t) > 2 and t not in STOPWORDS}


def titles_match(focus, title, threshold=DEFAULT_THRESHOLD):
    """Fuzzy match a plan day's `focus` prose against a task `title`.

    Token-Jaccard overlap (intersection / union) catches the common case of
    "add rate limiting to public API" vs "implement rate limiting for /api" —
    different words, shared core nouns. A separate overlap-vs-smaller-set
    ratio catches a short, focused title being fully contained in a longer
    focus description (or vice versa) even when the union is large enough
    to dilute the plain Jaccard score below threshold.
    """
    ta, tb = normalize_tokens(focus), normalize_tokens(title)
    if not ta or not tb:
        return False
    overlap = ta & tb
    if not overlap:
        return False
    union = ta | tb
    jaccard = len(overlap) / len(union)
    smaller = min(len(ta), len(tb))
    overlap_ratio = (len(overlap) / smaller) if smaller else 0.0
    return jaccard >= threshold or overlap_ratio >= 0.6


def compute_drift(days, tasks, threshold=DEFAULT_THRESHOLD,
                   queued_statuses=QUEUED_STATUSES, shipped_status=SHIPPED_STATUS):
    """Return a list of drift finding dicts. Pure function — no I/O."""
    days_by_repo = defaultdict(list)
    for d in days:
        repo = isinstance(d, dict) and d.get("repo")
        if repo:
            days_by_repo[repo].append(d)

    tasks_by_repo = defaultdict(list)
    for t in tasks:
        repo = isinstance(t, dict) and t.get("repo")
        if repo:
            tasks_by_repo[repo].append(t)

    findings = []
    # Only repos with a registered plan are in scope — see module docstring.
    for repo, repo_days in sorted(days_by_repo.items()):
        repo_tasks = tasks_by_repo.get(repo, [])

        for d in sorted(repo_days, key=lambda x: x.get("day", 0)):
            if d.get("status") != "done":
                continue
            focus = d.get("focus", "")
            matched = any(
                t.get("status") == shipped_status and titles_match(focus, t.get("title", ""), threshold)
                for t in repo_tasks
            )
            if not matched:
                findings.append({
                    "repo": repo,
                    "kind": "day-done-no-shipped-task",
                    "day": d.get("day"),
                    "focus": focus,
                    "status": d.get("status"),
                })

        for t in repo_tasks:
            if t.get("status") not in queued_statuses:
                continue
            title = t.get("title", "")
            matched = any(titles_match(d.get("focus", ""), title, threshold) for d in repo_days)
            if not matched:
                findings.append({
                    "repo": repo,
                    "kind": "queued-task-no-plan-day",
                    "taskId": t.get("taskId"),
                    "title": title,
                    "status": t.get("status"),
                })

    return findings


def format_finding(f):
    if f["kind"] == "day-done-no-shipped-task":
        return (f"DRIFT {f['repo']} day-done-no-shipped-task day={f['day']} "
                f"focus=\"{f['focus']}\" — plan day marked done but no shipped "
                f"task title matches")
    return (f"DRIFT {f['repo']} queued-task-no-plan-day taskId={f.get('taskId')} "
            f"title=\"{f['title']}\" status={f['status']} — queued task has no "
            f"corresponding plan day")


def _write_status_json(path, payload):
    """Best-effort atomic write of a JSON bridge artifact, same pattern as
    pool_capacity_drift.py — never raises past the caller."""
    if not path:
        return
    try:
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        tmp = f"{path}.tmp.{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    except OSError:
        pass


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("input", help="path to JSON file with {days:[...], tasks:[...]}")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                         help=f"title-match Jaccard threshold (default {DEFAULT_THRESHOLD})")
    parser.add_argument("--status-out", default=os.environ.get("SCHEDULE_PLAN_DRIFT_STATUS_OUT"),
                         help="optional path to write a JSON bridge artifact")
    args = parser.parse_args(argv[1:])

    checked_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    try:
        with open(args.input, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as e:
        print(f"ERROR: cannot read input {args.input}: {e}", file=sys.stderr)
        return 2

    if not isinstance(data, dict):
        print(f"ERROR: input {args.input} must be a JSON object with days/tasks", file=sys.stderr)
        return 2

    days = data.get("days") or []
    tasks = data.get("tasks") or []
    if not isinstance(days, list) or not isinstance(tasks, list):
        print(f"ERROR: input {args.input} 'days' and 'tasks' must be arrays", file=sys.stderr)
        return 2

    findings = compute_drift(days, tasks, threshold=args.threshold)

    repos_with_plan = sorted({d.get("repo") for d in days if isinstance(d, dict) and d.get("repo")})
    repos_with_drift = sorted({f["repo"] for f in findings})

    for repo in repos_with_plan:
        repo_findings = [f for f in findings if f["repo"] == repo]
        if not repo_findings:
            print(f"OK {repo} — plan and task queue agree")
            continue
        for f in repo_findings:
            print(format_finding(f))

    any_drift = len(findings) > 0
    print(f"-- {len(repos_with_plan)} repo(s) with a registered plan checked, "
          f"{len(findings)} drift finding(s) across {len(repos_with_drift)} repo(s) --")

    _write_status_json(args.status_out, {
        "checkedAt": checked_at,
        "reposChecked": repos_with_plan,
        "anyDrift": any_drift,
        "findings": findings,
    })

    return 1 if any_drift else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
