#!/usr/bin/env python3
"""json_merge.py — deep-merge a framework-owned JSON file into a repo-local one.

THE CLOBBER FIX (2026-07-02, raised by the agentFlow agent after 18 clobbers):
update_all.sh used to plain-overwrite .claude/settings.json and jq-rewrite
.mcp.json on every sync, destroying repo-local additions (statusLine, extra
session hooks, custom MCP servers) and dirtying every managed repo's tree even
when nothing semantically changed. This helper replaces every one of those
callsites with ONE merge policy:

  * dicts   — recurse. MASTER wins on shared leaf keys (framework-owned values
              stay canonical fleet-wide); keys only in TARGET survive (that's
              the repo-local statusLine, extra permissions, custom servers).
  * lists   — master items first, in master order. A target item is appended
              only if its identity isn't already present. Identity:
                dict with "command" -> the command string   (hook entries)
                dict with "matcher" -> the matcher string   (hook groups; the
                                       two groups deep-merge, so repo-local
                                       entries inside a shared matcher survive)
                anything else       -> its canonical JSON   (permission strings)
              When identities collide, the pair deep-merges (master precedence),
              so a repo-local "timeout" on a framework hook entry survives while
              the framework command itself stays canonical.
              Same-identity items pair up POSITIONALLY (1st occurrence in master
              with 1st occurrence in target, 2nd with 2nd, ...) rather than every
              occurrence colliding on one shared match. A settings.json can
              legitimately carry more than one hook GROUP for the same matcher
              (e.g. templates/settings.kernel.json has two separate "Bash"
              PreToolUse groups) — without positional pairing, a second group
              sharing an already-seen matcher gets merged against the FIRST
              group with that matcher instead of its own counterpart, splicing
              one group's hook list into the other and duplicating entries on
              every re-merge (found via test_myai_init_settings_merge.sh: a
              genuinely no-op re-init was duplicating the 3 safety-hook
              commands). Positional pairing keeps same-identity groups distinct
              1:1 as long as master and target agree on ordering — which they
              do for every framework-authored group; only genuinely-extra
              target occurrences (beyond master's count for that identity)
              fall through to the "target-only" append path, so a repo-added
              duplicate matcher group still survives untouched.
  * scalars — master wins.

  * IDEMPOTENT WRITE — the target file is rewritten ONLY when the merged result
    differs semantically from what's already there. A no-change sync leaves the
    repo tree clean (this is what stops the every-session churn).
  * GUARD — an unreadable/invalid target is left UNTOUCHED (exit 2, message on
    stderr). Never fall back to overwriting: a broken file is the repo agent's
    to fix; destroying it hides the problem.

Usage:  json_merge.py TARGET MASTER [--check]
Stdout: one of  changed | unchanged | created
Exit:   0 ok · 1 master unreadable (caller bug) · 2 target invalid (left alone)

--check: dry run for drift detection (e.g. check_config_drift.sh). Computes the
same merged result and prints the same changed/unchanged/created verdict, but
never writes TARGET — lets a read-only fleet audit ask "would this merge
change anything?" without mutating the repo it's inspecting.
"""
import json
import os
import sys


def identity(item):
    if isinstance(item, dict):
        if "command" in item:
            return ("command", item["command"])
        if "matcher" in item:
            return ("matcher", item["matcher"])
    try:
        return ("val", json.dumps(item, sort_keys=True))
    except (TypeError, ValueError):
        return ("val", str(item))


def merge(master, target):
    """Merged value with master precedence; repo-local additions survive."""
    if isinstance(master, dict) and isinstance(target, dict):
        out = dict(target)
        for k, v in master.items():
            out[k] = merge(v, target[k]) if k in target else v
        return out
    if isinstance(master, list) and isinstance(target, list):
        # Queue same-identity target items so repeated identities (e.g. two
        # hook groups that both use matcher "Bash") pair up positionally with
        # master's occurrences instead of every occurrence colliding on one
        # shared match (see module docstring).
        by_id = {}
        for it in target:
            by_id.setdefault(identity(it), []).append(it)
        out = []
        for it in master:
            key = identity(it)
            queue = by_id.get(key)
            out.append(merge(it, queue.pop(0)) if queue else it)
        for queue in by_id.values():
            out.extend(queue)  # genuinely target-only occurrences survive
        return out
    return master


def canon(value):
    return json.dumps(value, sort_keys=True)


def main():
    args = [a for a in sys.argv[1:] if a != "--check"]
    check_only = "--check" in sys.argv[1:]
    if len(args) != 2:
        print("usage: json_merge.py TARGET MASTER [--check]", file=sys.stderr)
        return 1
    target_path, master_path = args

    try:
        with open(master_path) as f:
            master = json.load(f)
    except (OSError, ValueError) as e:
        print(f"master {master_path} unreadable: {e}", file=sys.stderr)
        return 1

    if not os.path.exists(target_path):
        if not check_only:
            with open(target_path, "w") as f:
                json.dump(master, f, indent=2)
                f.write("\n")
        print("created")
        return 0

    try:
        with open(target_path) as f:
            target = json.load(f)
    except (OSError, ValueError) as e:
        print(f"target {target_path} invalid — left untouched: {e}", file=sys.stderr)
        return 2

    merged = merge(master, target)
    if canon(merged) == canon(target):
        print("unchanged")
        return 0

    if not check_only:
        with open(target_path, "w") as f:
            json.dump(merged, f, indent=2)
            f.write("\n")
    print("changed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
