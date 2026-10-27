#!/usr/bin/env python3
"""schedule_ingest.py — ingest a repo's AI/plan/schedule.json tasks into the local
myAI gateway task queue, DEDUPED against the tasks the gateway already holds for
that repo. Invoked by scripts/push_schedule.sh (which owns the gateway-health gate
and the whole-file sentinel fast-path); this script owns plan_set + the per-task
schedule_task fan-out.

Root cause it closes (observed 2026-10-02 in one managed repo):
  push_schedule.sh guarded re-ingestion ONLY with a whole-file git-blob hash of
  schedule.json recorded in AI/state/.schedule-ingested. Appending even one task
  changes that hash, so the guard misses and EVERY task in the file is re-sent to
  schedule_task — re-queuing tasks whose identical titles were already status=done
  in the gateway (19 duplicates that day). Because `schedule plan` is the mandatory
  step 0 of `wrap up`, every wrap-up refresh of the schedule resurrected completed
  work for the runner.

Fix: before scheduling, list the repo's existing gateway tasks across EVERY status
(pending/working/review/done/blocked/paused/dead_letter, paginated), and skip any
artifact task whose normalized title already exists. The whole-file sentinel stays
as a cheap no-op fast-path in push_schedule.sh; this per-task title dedup is the
correctness floor for when the file *does* change.

Pure helpers (normalize_title, partition_tasks, titles_from_tasks_list_payload)
are unit-tested without a gateway in scripts/tests/test_schedule_ingest.sh.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request

# TaskStatus union (runtime/src/shared/db.ts). Dedup must see ALL of them so a
# title already status=done is not re-queued — 'done' leads because it is the
# status that bit us (the 2026-10-02 incident).
ALL_STATUSES = ["done", "review", "working", "pending", "blocked", "paused", "dead_letter"]
PAGE_LIMIT = 200


def normalize_title(title) -> str:
    """Canonical dedup key: collapse internal whitespace, trim, and casefold so a
    title matches regardless of stray spacing or case. Conservative on purpose —
    it never collapses two genuinely different titles, only exact restatements."""
    return " ".join(str(title or "").split()).casefold()


def partition_tasks(tasks, existing_titles):
    """Split artifact `tasks` into (new, duplicate).

    A task is a duplicate when its normalized title already exists in the gateway
    (`existing_titles`, any status) OR appeared earlier in this same artifact — so
    a file that lists one title twice schedules it once. Input order is preserved.
    Tasks with a blank title can't be deduped and fall through to `new` (where
    schedule_task.sh rejects them loudly), matching the pre-fix behavior.
    """
    seen = {normalize_title(t) for t in existing_titles}
    new, dup = [], []
    for t in tasks:
        key = normalize_title(t.get("title", ""))
        if key and key in seen:
            dup.append(t)
        else:
            new.append(t)
            if key:
                seen.add(key)
    return new, dup


def titles_from_tasks_list_payload(payload):
    """(titles, nextCursor) from a tasks_list tool payload. Tolerates both the
    current {count, tasks:[...], nextCursor?} shape and a bare list (older/stub)."""
    if isinstance(payload, list):
        return [r.get("title", "") for r in payload], None
    rows = payload.get("tasks", [])
    return [r.get("title", "") for r in rows], payload.get("nextCursor")


def _mcp_call(mcp, token, name, arguments):
    body = json.dumps({
        "jsonrpc": "2.0", "method": "tools/call", "id": 1,
        "params": {"name": name, "arguments": arguments},
    }).encode()
    req = urllib.request.Request(
        mcp, data=body,
        headers={"content-type": "application/json", "x-gateway-local-token": token},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 — local gateway only
        return resp.read()


def _unwrap(raw):
    """Pull the tool payload (parsed JSON) out of an MCP tools/call envelope."""
    d = json.loads(raw)
    return json.loads(d["result"]["content"][0]["text"])


def fetch_existing_titles(mcp, token, repo, statuses=ALL_STATUSES):
    """Every title the gateway already holds for `repo`, across all statuses,
    following nextCursor to the end so a repo with more than PAGE_LIMIT done tasks
    is fully covered — truncation here would silently re-admit a duplicate, which
    is exactly the bug this guard exists to prevent."""
    titles = []
    for st in statuses:
        cursor = None
        while True:
            args = {"repo": repo, "status": st, "limit": PAGE_LIMIT}
            if cursor:
                args["cursor"] = cursor
            page, cursor = titles_from_tasks_list_payload(
                _unwrap(_mcp_call(mcp, token, "tasks_list", args))
            )
            titles.extend(page)
            if not cursor:
                break
    return titles


def _build_cmd(sched, repo, task):
    cmd = [sched, "--repo", repo, "--title", task["title"],
           "--priority", task.get("priority", "P2"),
           "--model", task.get("model", "claude-fable-5")]
    if task.get("agent"):
        cmd += ["--agent", task["agent"]]
    if task.get("desc"):
        cmd += ["--desc", task["desc"]]
    notes = f"[{task.get('category', '')}] day {task.get('day', '?')} | from schedule.json"
    cmd += ["--notes", notes]
    return cmd


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--artifact", required=True, help="path to schedule.json")
    ap.add_argument("--gateway", required=True, help="gateway MCP URL, e.g. http://localhost:3100/mcp")
    ap.add_argument("--sched", required=True, help="path to schedule_task.sh")
    ap.add_argument("--token", default="", help="x-gateway-local-token value")
    ap.add_argument("--dry-run", action="store_true", help="report, do not plan_set or schedule")
    args = ap.parse_args(argv)

    with open(args.artifact) as fh:
        d = json.load(fh)
    repo = d["repo"]

    # 1) plan_set (dashboard /plan view) — idempotent, replace semantics.
    if d.get("days"):
        if not args.dry_run:
            _mcp_call(args.gateway, args.token, "plan_set",
                      {"repo": repo, "startDate": d.get("startDate"), "replace": True, "days": d["days"]})
        print(f"  plan_set: {len(d['days'])} days for {repo}")

    tasks = d.get("tasks", [])

    # 2) Dedup against what the gateway already holds for this repo (any status).
    # Degrade LOUDLY — ingest all, as the pre-fix script did — if the gateway
    # can't be queried, so a broken dedup is visible rather than silently
    # resurrecting a duplicate storm. No tasks => no need to query at all.
    existing = []
    if tasks:
        try:
            existing = fetch_existing_titles(args.gateway, args.token, repo)
        except Exception as e:  # noqa: BLE001 — any fetch failure degrades to no-dedup
            print(f"  ⚠ could not list existing gateway tasks ({e}) — ingesting WITHOUT dedup")
    new, dup = partition_tasks(tasks, existing)

    for t in dup:
        print(f"  ↷ skip (already in gateway for {repo}): {t.get('title', '')}")

    # 3) schedule_task each NEW item. check=False (one bad task must not abort the
    # rest) but every non-zero exit is reported and turns into a hard exit 1 —
    # a swallowed failure here is the class of bug this path exists to close.
    n = failed = 0
    for t in new:
        cmd = _build_cmd(args.sched, repo, t)
        if args.dry_run:
            print(f"  would schedule: {t.get('title', '')}")
            n += 1
            continue
        r = subprocess.run(cmd, check=False, capture_output=True, text=True)
        if r.returncode != 0:
            failed += 1
            print(f"  ✗ failed to schedule '{t.get('title', '')}' (exit {r.returncode}): "
                  f"{(r.stderr or r.stdout).strip()}")
        else:
            n += 1

    summary = f"  scheduled {n} new task(s) for {repo}"
    if dup:
        summary += f", skipped {len(dup)} already-present"
    if failed:
        summary += f" — {failed} FAILED"
    print(summary)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
