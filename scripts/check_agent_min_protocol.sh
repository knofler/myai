#!/usr/bin/env bash
# check_agent_min_protocol.sh — guards the `agent mode -min` read budget (BRAIN
# W4.4): the protocol must provably perform AT MOST ONE file read per session
# start — zero on the brain-reachable path (brain_delta / compiled brief),
# exactly one on the file-fallback path (AI_AGENT_HANDOFF.md / handoff.md
# only). Before W4.4, the fallback step also re-read the top session block of
# STATE.md — redundant once `wrap up` started inlining the top-3 session
# summary lines into the handoff (BRAIN-PRIMARY, TOKEN-OPT 3), and exactly the
# kind of silent drift this script exists to catch.
#
# BRAIN-2 (2026-09-08): the brain-reachable path used to be zero-reads only
# on paper — the prose's own OR clause ("...or the handoff header has a
# `Brain: <sha>` line") quietly meant a real boot could still need to open the
# handoff just to find `since`. `brain_merge` now stamps that SHA server-side
# as `lastAnchor` per repo (runtime/src/core/distill.ts), surfaced read-free
# via `brain_manifest`/`context_boot`, and `brain_delta({ repo })` resolves it
# itself when `since` is omitted — so the prose no longer needs (and must not
# reintroduce) that disjunct. This check still only greps prose for backtick
# file paths; it cannot see the runtime behavior, so treat the two as a pair.
#
# Source of truth: the `agent mode -min` prose itself in CLAUDE.md (the
# self-contained copy every managed repo gets) and documentation/CORE_KEYWORDS.md
# (this repo's own authoritative full-text copy, which explicitly claims to be
# the version that wins on conflict — see that file's header). Both must stay
# in sync; this script checks both independently.
#
# What it checks, per file, within the `agent mode -min` step-2 span (the
# brain-boot step through the start of step 3):
#   1. step 2 (brain-reachable path, before "2b."): zero backtick-quoted
#      file-looking paths (a Read target would mean a file read on the
#      supposedly-file-free primary path)
#   2. step 2b (file-fallback path): exactly ONE distinct backtick-quoted
#      file-looking path (zero = the fallback documents no read at all,
#      which can't be right since it has to read *something*; >1 = the
#      regression this check exists to catch)
#
# A "file-looking" backtick token is one that contains a `/` or ends in a
# known state-doc extension (.md/.json) — this excludes non-file backtick
# tokens like `localhost:3100`, `brain_delta`, `sha` that legitimately appear
# in the same prose.
#
# Hermetic: python3 only, no node/Docker/gateway/network — runs in
# script-unit-tests.yml and release.yml (both call scripts/tests/run_all.sh).
#
# Usage: ./scripts/check_agent_min_protocol.sh [CLAUDE.md] [CORE_KEYWORDS.md]
#        (both default to this repo's real files — override for tests)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

CLAUDE_MD="${1:-$REPO_ROOT/CLAUDE.md}"
CORE_KEYWORDS_MD="${2:-$REPO_ROOT/documentation/CORE_KEYWORDS.md}"

if ! command -v python3 >/dev/null 2>&1; then
    echo "  skip — python3 not on PATH"
    exit 0
fi

python3 - "$CLAUDE_MD" "$CORE_KEYWORDS_MD" <<'PY'
import re, sys, os

claude_md_path, core_kw_path = sys.argv[1:3]

PASS = FAIL = 0
def ok(m):  globals().__setitem__("PASS", PASS + 1); print(f"  ok   — {m}")
def bad(m): globals().__setitem__("FAIL", FAIL + 1); print(f"  FAIL — {m}")

# files are optional individually (a repo might only ship one), but at least
# one must exist and be checkable, or there's nothing to guard.
candidates = [("CLAUDE.md", claude_md_path), ("documentation/CORE_KEYWORDS.md", core_kw_path)]
existing = [(label, p) for label, p in candidates if os.path.exists(p)]
if not existing:
    bad(f"neither {claude_md_path} nor {core_kw_path} exists — nothing to guard")
    print(f"\nRESULT: {PASS} passed, {FAIL} failed"); sys.exit(1)

PATH_RE = re.compile(r"`([^`]+)`")
# Case-sensitive: this doc's convention is capital "Read" for the imperative
# ("Read `X`"), vs. lowercase "read" in prose that talks ABOUT reading
# without being a read instruction itself (e.g. "Do **NOT** also read `Y`" —
# a negation, not a second sanctioned read).
READ_RE = re.compile(r"Read\s+")
# The slim-kernel marker (2026-09-07): when present, CLAUDE.md carries only a
# one-line `agent mode -min` summary and DELEGATES the step-numbered protocol
# (and therefore this budget check) to documentation/CORE_KEYWORDS.md.
SLIM_RE = re.compile(r"Slim kernel \(")
# BRAIN-2 regression guard: step 2 used to justify "zero reads" partly via an
# OR clause — "...or the handoff header has a `Brain: <sha>` line" — which was
# itself a file read hiding behind prose that never said the word "Read". Now
# that `brain_merge` stamps the anchor server-side (`lastAnchor`, surfaced via
# brain_manifest/context_boot) and `brain_delta({repo})` resolves it without a
# `since` at all, step 2 must never describe falling back to that grep again.
HANDOFF_HEADER_DISJUNCT_RE = re.compile(r"handoff header has a", re.IGNORECASE)

def looks_like_file(tok: str) -> bool:
    return "/" in tok or tok.endswith(".md") or tok.endswith(".json")

def extract_read_paths(span: str):
    """Every backtick file-path named as the direct object of a "Read "
    instruction in `span`, scoped to that instruction's own clause (up to the
    next ". " or " — ", so a later, unrelated sentence's file mentions — e.g.
    the one naming the checker script itself — never get swept in)."""
    paths = []
    for m in READ_RE.finditer(span):
        rest = span[m.end():]
        cut_candidates = [c for c in (rest.find(". "), rest.find(" — ")) if c != -1]
        cut = min(cut_candidates) if cut_candidates else len(rest)
        clause = rest[:cut]
        paths.extend(p for p in PATH_RE.findall(clause) if looks_like_file(p))
    return paths

def check_min_span(label: str, text: str, delegate_ok=None) -> bool:
    """Locate the `agent mode -min` step-2 span in `text` and validate its
    read budget. Returns True if the keyword wasn't found at all (nothing to
    check in this file — not an error, e.g. a repo missing CORE_KEYWORDS.md
    coverage) as None, True/False if it was found and validated (pass/fail already
    recorded via ok()/bad())."""
    # Anchor on the keyword itself, then look for the "2. **Brain boot" /
    # "2b." / "3." numbered-step markers that bound the primary and fallback
    # spans within the SAME paragraph (stop at the next blank line / row end
    # so we never wander into an unrelated keyword's prose).
    # Anchor on the row/section HEADER, not any inline backtick mention of
    # `agent mode -min` (e.g. `agent mode`'s own prose says "same path
    # `agent mode -min` uses" — that mention precedes the real block and
    # would truncate it to nothing if used as the anchor).
    kw = text.find("| `agent mode -min`")
    if kw == -1:
        kw = text.find("## `agent mode -min`")
    if kw == -1:
        # None (not True) so a delegating slim CLAUDE.md cannot treat a
        # CORE_KEYWORDS.md that never covers `agent mode -min` as proof.
        return None  # not present in this file — skip, not a failure

    # Bound the whole -min block: from the keyword to the next "---" rule,
    # next "## " heading, or next "| \`" table row (whichever is closest and
    # present), else end of file.
    end_markers = [m for m in (text.find("\n---", kw), text.find("\n## ", kw + 1), text.find("\n| `", kw + 1)) if m != -1]
    block_end = min(end_markers) if end_markers else len(text)
    block = text[kw:block_end]

    m2 = re.search(r"\b2\.\s*\*\*Brain boot", block)
    m2b = re.search(r"2b\.[\s*]*File fallback", block)
    m3 = re.search(r"\b3\.\s*Run\b", block)
    if not (m2 and m2b and m3):
        # A slim-kernel CLAUDE.md has no 2/2b/3 markers to bound: the
        # step-numbered protocol moved to documentation/CORE_KEYWORDS.md and
        # this row is a one-line summary. That is sanctioned drift, but only
        # if the budget stays provable — so require (a) the summary sanctions
        # no STATE.md read, (b) it still names the handoff as the fallback,
        # and (c) the canonical copy exists and passed the full check.
        if SLIM_RE.search(text):
            state_reads = [p for p in extract_read_paths(block) if p.endswith("STATE.md")]
            if state_reads:
                bad(f"{label}: slim-kernel `agent mode -min` summary sanctions a "
                    f"STATE.md read {state_reads} — the fallback budget is the handoff alone")
                return False
            if "handoff" not in block.lower():
                bad(f"{label}: slim-kernel `agent mode -min` summary no longer names the "
                    f"handoff as the single fallback read — budget claim has been watered down")
                return False
            if delegate_ok is not True:
                bad(f"{label}: slim-kernel `agent mode -min` delegates the read budget to "
                    f"documentation/CORE_KEYWORDS.md, which is absent or failing — the budget "
                    f"must remain provable in at least one file")
                return False
            ok(f"{label}: slim kernel — summary sanctions no STATE.md read and names the "
               f"handoff; full step-numbered budget enforced in documentation/CORE_KEYWORDS.md")
            return True
        bad(f"{label}: could not locate the step 2 / 2b / 3 markers inside the "
            f"`agent mode -min` block — protocol structure changed underneath this check")
        return False

    primary_span = block[m2.end():m2b.start()]
    fallback_span = block[m2b.start():m3.start()]

    primary_paths = sorted(set(extract_read_paths(primary_span)))
    fallback_paths = sorted(set(extract_read_paths(fallback_span)))

    good = True
    if primary_paths:
        bad(f"{label}: brain-reachable path (step 2) references file path(s) {primary_paths} "
            f"— it must boot purely from brain_delta with ZERO file reads")
        good = False
    else:
        ok(f"{label}: brain-reachable path (step 2) performs zero file reads")

    if HANDOFF_HEADER_DISJUNCT_RE.search(primary_span):
        bad(f"{label}: brain-reachable path (step 2) still describes falling back to the "
            f"handoff header for the `Brain:` SHA — BRAIN-2's server-side `lastAnchor` "
            f"(brain_merge → brain_manifest/context_boot) removed the need for that "
            f"disjunct; a repo-scoped brain_delta resolves `since` itself now")
        good = False
    else:
        ok(f"{label}: brain-reachable path (step 2) does not fall back to a handoff-header grep")

    if len(fallback_paths) == 0:
        bad(f"{label}: file-fallback path (step 2b) documents zero file reads "
            f"— it must read exactly one (the handoff)")
        good = False
    elif len(fallback_paths) > 1:
        bad(f"{label}: file-fallback path (step 2b) reads {len(fallback_paths)} files "
            f"{fallback_paths} — budget is at most 1 (protocol drift, e.g. a re-added STATE.md read)")
        good = False
    else:
        ok(f"{label}: file-fallback path (step 2b) reads exactly 1 file ({fallback_paths[0]})")

    return good

# CORE_KEYWORDS.md first: it is the canonical full-text copy, and a slim
# CLAUDE.md delegates its budget to it, so its verdict must be known first.
existing.sort(key=lambda lp: 0 if "CORE_KEYWORDS" in lp[0] else 1)
core_ok = None
for label, path in existing:
    text = open(path).read()
    result = check_min_span(label, text, delegate_ok=core_ok)
    if "CORE_KEYWORDS" in label:
        core_ok = result

print(f"\nRESULT: {PASS} passed, {FAIL} failed")
sys.exit(0 if FAIL == 0 else 1)
PY
