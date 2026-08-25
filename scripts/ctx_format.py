#!/usr/bin/env python3
"""ctx_format.py — render brain_route.py's --json output as bare pointers.

`myai recall` prints a narrative view (plane/signals/backend/fetch) for a
human exploring the index. `myai ctx` (BRAIN_V2 W3.1) needs the OPPOSITE: a
lean, pipeable, one-locator-per-line stream an agent (or a script) can grep,
loop over, or feed straight into a targeted Read — the primitive that
replaces bulk Read/Grep. This module is the formatting step, split out of
myai_ctx.sh so it is unit-testable against canned JSON without paying for a
real index build.

Format (stdout, one per locator, in the router's ranked order):
  <file>:<line>  <name> (<kind>)     — doc_type == "symbol"/"chunk", name known
  <file>:<line>                      — doc_type == "symbol"/"chunk", name absent
  atom:<ref>                         — doc_type == "atom"

No LLM, no network — pure stdlib JSON transform.

Usage
  ctx_format.py < router.json          # read router JSON from stdin
  ctx_format.py router.json            # or from a file argument
"""
from __future__ import annotations

import json
import sys


def format_locator(loc: dict) -> str:
    ref = loc.get("ref", "")
    if loc.get("doc_type") == "atom":
        return f"atom:{ref}"
    name = loc.get("name") or ""
    kind = loc.get("kind") or ""
    if name:
        return f"{ref}  {name} ({kind})" if kind else f"{ref}  {name}"
    return ref


def format_locators(data: dict) -> list[str]:
    return [format_locator(loc) for loc in (data.get("locators") or [])]


def main(argv: list[str]) -> int:
    src = open(argv[1], "r", encoding="utf-8") if len(argv) > 1 else sys.stdin
    try:
        data = json.load(src)
    finally:
        if src is not sys.stdin:
            src.close()
    for line in format_locators(data):
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
