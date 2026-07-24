#!/usr/bin/env python3
"""session_tokens.py — precise per-session OUTPUT-token measurement for the runner's
credit-pacing throttle, with NO double-counting across fires.

Transcripts live at <config-dir>/projects/*/*.jsonl; each assistant turn carries
`message.usage.output_tokens`. To attribute exactly the tokens spent by ONE runner
session we snapshot every transcript's byte-size BEFORE the session, then after it
parse ONLY the bytes appended past that offset (plus any brand-new files). That delta
is this session's output tokens — re-running never re-counts old turns.

Usage:
  session_tokens.py snapshot <config-dir>            → prints JSON {path: size_bytes}
  session_tokens.py delta    <config-dir> <snapfile> → prints int (new output tokens)

Best-effort by contract: any error prints 0 / an empty snapshot and exits 0, so the
runner's always-on session-count cap remains the reliable guard (never fails open).
"""
import sys, os, glob, json


def _transcripts(cfg):
    return glob.glob(os.path.join(cfg, "projects", "**", "*.jsonl"), recursive=True)


def _snapshot(cfg):
    snap = {}
    for f in _transcripts(cfg):
        try:
            snap[f] = os.path.getsize(f)
        except OSError:
            pass
    return snap


def _sum_output_tokens(fh):
    total = 0
    for line in fh:
        if '"output_tokens"' not in line:
            continue
        try:
            usage = (json.loads(line).get("message") or {}).get("usage") or {}
            total += int(usage.get("output_tokens", 0) or 0)
        except (ValueError, TypeError):
            pass
    return total


def _delta(cfg, snapfile):
    try:
        with open(snapfile, encoding="utf-8") as fh:
            snap = json.load(fh)
    except (OSError, ValueError):
        snap = {}
    total = 0
    for f in _transcripts(cfg):
        start = int(snap.get(f, 0) or 0)
        try:
            with open(f, encoding="utf-8", errors="ignore") as fh:
                fh.seek(start)          # parse only bytes appended during this session
                total += _sum_output_tokens(fh)
        except OSError:
            pass
    return total


def main(argv):
    if len(argv) >= 3 and argv[1] == "snapshot":
        print(json.dumps(_snapshot(argv[2])))
        return 0
    if len(argv) >= 4 and argv[1] == "delta":
        print(_delta(argv[2], argv[3]))
        return 0
    print(0)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception:
        print(0)
        sys.exit(0)
