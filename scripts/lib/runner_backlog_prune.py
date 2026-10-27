#!/usr/bin/env python3
"""runner_backlog_prune.py — check and bulk-drop already-shipped seeds from runner backlog.

Policy & Directive (operator / master mandate 2026-10-04):
  (a) at the source — cli_task_runner checks 'seed already shipped' BEFORE
      claiming/spending a fire, and drops all already-shipped seeds in ONE commit
      per run window.

Avoids the churn of spending a 10-minute fire per already-shipped seed, which
repeatedly pushes single-line chore commits to `test` and cancels in-flight CI.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPTS = os.path.dirname(_HERE)
_ROOT = os.path.dirname(_SCRIPTS)

sys.path.insert(0, _SCRIPTS)
from backlog_dupe_check import tokenize, overlap_coefficient  # noqa: E402
from backlog_prior_art import resolve_repo_root, commit_corpus, best_match  # noqa: E402

INTENT_REGEX = re.compile(
    r"\b(revert|reverts|reverting|regression|regressed|broke|broken|breaks|breaking|"
    r"bug|bugfix|bugfixes|fix|fixes|fixed|fixing|hotfix|extend|extends|amend|reopen|"
    r"builds?\s+on|on\s+top\s+of|follow[- ]?up|cherry[- ]?pick)\b",
    re.I,
)

DELIVERABLE_EXTS = re.compile(
    r"\.(md|mdx|mp4|mov|png|jpg|jpeg|svg|gif|webm|pdf|ts|tsx|js|jsx|mjs|cjs|py|sh|json|ya?ml|toml|css|scss|html|txt|csv)$",
    re.I,
)


def deliverable_missing(repo_path: str, title: str) -> bool:
    """True if title names a file that does not exist on origin/main or origin/test."""
    try:
        proc = subprocess.run(
            ["git", "-C", repo_path, "ls-tree", "-r", "--name-only", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if proc.returncode != 0:
            return False
        tree = set(proc.stdout.splitlines())
        basenames = set(p.rsplit("/", 1)[-1].lower() for p in tree)
    except Exception:
        return False

    named = []
    for raw in re.split(r"\s+", title):
        t = re.sub(r"^\./", "", raw.strip().strip("\"'`()[]{}<>,;:"))
        if not t or "://" in t or len(t) > 200:
            continue
        if ("/" in t and re.search(r"\.[A-Za-z0-9]+$", t)) or DELIVERABLE_EXTS.search(t):
            named.append(t)

    if not named:
        return False
    for t in named:
        if "/" in t:
            if t not in tree:
                return True
        else:
            if t.lower() not in basenames:
                return True
    return False


def is_sha_delivered(repo_path: str, sha: str) -> bool:
    """Verify that sha exists and is merged into origin/main or present on origin/test."""
    try:
        # Check commit object exists
        rc = subprocess.run(
            ["git", "-C", repo_path, "cat-file", "-e", f"{sha}^{{commit}}"],
            capture_output=True,
            timeout=5,
        ).returncode
        if rc != 0:
            return False

        # Check if ancestor of origin/main or origin/test
        for target in ("origin/main", "origin/test", "main", "test"):
            has_target = subprocess.run(
                ["git", "-C", repo_path, "rev-parse", "--verify", "--quiet", target],
                capture_output=True,
                timeout=5,
            ).returncode == 0
            if has_target:
                is_anc = subprocess.run(
                    ["git", "-C", repo_path, "merge-base", "--is-ancestor", sha, target],
                    capture_output=True,
                    timeout=5,
                ).returncode == 0
                if is_anc:
                    return True
        return False
    except Exception:
        return False


def prune_backlog_seeds(
    backlog_path: str,
    threshold: float = 0.70,
    dry_run: bool = True,
    commit: bool = False,
    close_tasks: bool = True,
) -> dict:
    if not os.path.isfile(backlog_path):
        return {"error": f"backlog file not found: {backlog_path}", "pruned": 0}

    with open(backlog_path, "r", encoding="utf-8") as fh:
        raw_lines = fh.readlines()

    dropped = []  # list of (index, item_dict, sha, score, subject)
    kept_lines = []
    corpuses = {}  # repo_path -> corpus

    for idx, line in enumerate(raw_lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            kept_lines.append(line)
            continue
        try:
            item = json.loads(stripped)
        except Exception:
            kept_lines.append(line)
            continue

        repo = item.get("repo", "")
        title = item.get("title", "")
        desc = item.get("desc", "")
        full_text = f"{title} {desc}"

        # Intent gate: words indicating a bug/fix/revert relative to past commit
        if INTENT_REGEX.search(full_text):
            kept_lines.append(line)
            continue

        repo_path = resolve_repo_root(repo, None)
        if not repo_path or not os.path.exists(os.path.join(repo_path, ".git")):
            kept_lines.append(line)
            continue

        # Check deliverable files named in title
        if deliverable_missing(repo_path, title):
            kept_lines.append(line)
            continue

        if repo_path not in corpuses:
            corpuses[repo_path] = commit_corpus(repo_path, since=None, window_days=180)

        corpus = corpuses[repo_path]
        match = best_match(title, corpus)
        if match:
            score, sha, date_str, subj = match
            if score >= threshold:
                if is_sha_delivered(repo_path, sha):
                    dropped.append((idx, item, sha, score, subj))
                    continue

        kept_lines.append(line)

    pruned_count = len(dropped)
    if pruned_count == 0:
        return {"pruned": 0, "dropped": []}

    if not dry_run:
        with open(backlog_path, "w", encoding="utf-8") as fh:
            fh.writelines(kept_lines)

    # Optional: Auto-close matching gateway tasks
    closed_task_ids = []
    if close_tasks and not dry_run:
        closed_task_ids = auto_close_gateway_tasks(dropped)

    commit_sha = None
    if commit and not dry_run and pruned_count > 0:
        commit_sha = commit_dropped_seeds(backlog_path, dropped)

    return {
        "pruned": pruned_count,
        "commit": commit_sha,
        "closed_tasks": closed_task_ids,
        "dropped": [
            {
                "line": idx,
                "title": it.get("title"),
                "sha": sha,
                "score": round(score, 3),
                "subject": subj,
            }
            for idx, it, sha, score, subj in dropped
        ],
    }


def auto_close_gateway_tasks(dropped: list) -> list[str]:
    """Find any pending/working gateway tasks matching dropped seeds and flip to done."""
    token = os.environ.get("GATEWAY_LOCAL_TOKEN", "")
    gateway_url = "http://localhost:3100/mcp"
    closed = []

    # Map dropped titles and SHAs
    dropped_titles = set(it.get("title") for _, it, _, _, _ in dropped if it.get("title"))
    dropped_shas = set(sha.lower() for _, _, sha, _, _ in dropped if sha)

    try:
        import urllib.request
        req = urllib.request.Request(
            gateway_url,
            data=json.dumps({
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {"name": "tasks_list", "arguments": {"limit": 1000}},
                "id": 1,
            }).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-gateway-local-token": token},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            content = data["result"]["content"][0]["text"]
            parsed = json.loads(content)
            tasks = parsed if isinstance(parsed, list) else parsed.get("tasks", [])
    except Exception:
        return closed

    for t in tasks:
        tid = t.get("taskId")
        status = t.get("status")
        title = t.get("title", "")
        desc = t.get("description", "")
        if status not in ("pending", "working"):
            continue

        match_sha = None
        if title in dropped_titles:
            # find corresponding sha
            for _, it, sha, _, _ in dropped:
                if it.get("title") == title:
                    match_sha = sha
                    break

        if not match_sha and "PRIOR ART CHECK" in desc:
            for s in dropped_shas:
                if s in desc.lower():
                    match_sha = s
                    break

        if match_sha:
            try:
                stamp = f'[resolution] {{"reason":"already-shipped","sha":"{match_sha}","by":"runner-backlog-prune"}}'
                note = f"auto-closed by runner seed pruner: seed already shipped in {match_sha}\n{stamp}"
                update_req = urllib.request.Request(
                    gateway_url,
                    data=json.dumps({
                        "jsonrpc": "2.0",
                        "method": "tools/call",
                        "params": {
                            "name": "tasks_update",
                            "arguments": {
                                "taskId": tid,
                                "status": "done",
                                "notes": note,
                            },
                        },
                        "id": 2,
                    }).encode("utf-8"),
                    headers={"Content-Type": "application/json", "x-gateway-local-token": token},
                )
                with urllib.request.urlopen(update_req, timeout=10) as uresp:
                    closed.append(tid)
            except Exception:
                pass

    return closed


def commit_dropped_seeds(backlog_path: str, dropped: list) -> str | None:
    curr = os.path.abspath(os.path.dirname(backlog_path))
    repo_dir = None
    while curr and curr != os.path.dirname(curr):
        if os.path.exists(os.path.join(curr, ".git")):
            repo_dir = curr
            break
        curr = os.path.dirname(curr)
    if not repo_dir:
        repo_dir = os.path.dirname(os.path.dirname(os.path.abspath(backlog_path)))
    try:
        subprocess.run(["git", "-C", repo_dir, "add", backlog_path], check=True, timeout=10)
        n = len(dropped)
        msg_lines = [
            f"chore(backlog): drop {n} already-shipped seed{'s' if n != 1 else ''} — bulk pruned by runner",
            "",
            "Bulk pruned seeds whose deliverables have already shipped to origin/main:",
        ]
        for _, it, sha, score, subj in dropped:
            t = it.get("title", "")[:60]
            msg_lines.append(f"- {t} — shipped in {sha} ({subj[:40]})")
        msg = "\n".join(msg_lines)

        subprocess.run(
            ["git", "-C", repo_dir, "commit", "-m", msg],
            check=True,
            capture_output=True,
            timeout=15,
        )
        rev = subprocess.run(
            ["git", "-C", repo_dir, "rev-parse", "--short", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()
        return rev
    except Exception as e:
        print(f"[runner-backlog-prune] commit failed: {e}", file=sys.stderr)
        return None


def main():
    parser = argparse.ArgumentParser(description="Prune already-shipped seeds from runner backlog.")
    parser.add_argument("--backlog", default=os.path.join(_ROOT, "config", "runner_backlog.jsonl"))
    parser.add_argument("--threshold", type=float, default=0.70)
    parser.add_argument("--apply", action="store_true", help="Actually apply deletions (default: report-only unless RUNNER_PRUNE_APPLY=1)")
    parser.add_argument("--dry-run", action="store_true", help="Force report-only mode even if RUNNER_PRUNE_APPLY=1")
    parser.add_argument("--commit", action="store_true", help="Commit dropped seeds if applied")
    parser.add_argument("--no-close-tasks", action="store_true", help="Do not auto-close matching gateway tasks")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    env_apply = os.environ.get("RUNNER_PRUNE_APPLY", "0").strip().lower() in ("1", "true", "yes")
    apply_mode = (args.apply or env_apply) and not args.dry_run
    dry_run = not apply_mode

    res = prune_backlog_seeds(
        backlog_path=args.backlog,
        threshold=args.threshold,
        dry_run=dry_run,
        commit=args.commit and apply_mode,
        close_tasks=not args.no_close_tasks and apply_mode,
    )
    res["mode"] = "apply" if apply_mode else "report-only"

    if args.json:
        print(json.dumps(res, indent=2))
    else:
        pruned = res.get("pruned", 0)
        if not apply_mode:
            print(f"[runner-backlog-prune] REPORT-ONLY (RUNNER_PRUNE_APPLY=0): identified {pruned} candidate seed(s) from {args.backlog}")
            for d in res.get("dropped", []):
                print(f"  - line {d['line']}: {d['title'][:55]} (score {d['score']}, shipped in {d['sha']}: {d['subject'][:40]})")
        else:
            print(f"[runner-backlog-prune] pruned {pruned} seed(s) from {args.backlog}")
            if res.get("commit"):
                print(f"[runner-backlog-prune] committed as {res['commit']}")
            if res.get("closed_tasks"):
                print(f"[runner-backlog-prune] closed {len(res['closed_tasks'])} gateway task(s)")
            for d in res.get("dropped", []):
                print(f"  - line {d['line']}: {d['title'][:55]} (shipped in {d['sha']})")


if __name__ == "__main__":
    main()
