#!/usr/bin/env python3
"""
CI-THRIFT v2 — inject an AI/docs-only paths gate into a GitHub Actions ci.yml.

Operator directive 2026-07-05: AI/docs-only changes must NEVER rebuild the stack.
This makes the heavy jobs in a workflow skip when a PR touches only the AI/docs
set (AI/ docs/ state/ logs/ .claude/ *.md) — WITHOUT paths-ignore at the trigger
level (a required check that never posts a conclusion would hang the PR forever).

How it works (surgical, comment-preserving text edit — NOT a YAML round-trip,
because the fleet's ci.yml files are divergent and full of comments PyYAML would
strip):

  1. Insert a `changes` job right after `jobs:`. It always runs and computes
     `outputs.code`: `false` when ONLY the AI/docs set changed, else `true`.
  2. For every ROOT job (a job with no existing `needs:` and no existing `if:`),
     inject `needs: changes` + `if: needs.changes.outputs.code == 'true'`.
     A skipped required check counts as satisfied for branch protection, so the
     workflow still completes green and app-pinned required checks stay happy.
  3. A job that has an `if:` but NO `needs:` (the review-workflow shape —
     claude-review / copilot-review gate a single job on a fork/draft `if:`)
     gets `needs: changes` injected AND its `if:` merged to
     `needs.changes.outputs.code == 'true' && (<original>)`. This is how §17.2/§17.3
     make Copilot/Claude review skip docs-only PRs (the old logic left these
     ungated, so they ran on every PR — pure Actions-credit burn).
  4. A job that ALREADY declares `needs:` is left untouched: if it depends on a
     now-gated job it cascade-skips automatically; a job with BOTH needs+if is
     reported for manual review rather than risk a wrong merge. A single-line `if:`
     is required for the merge in (3); a block/multi-line `if:` is reported instead.

Idempotent: re-running detects the marker and makes no change.

Exit codes: 0 = changed, 3 = already gated (no change), 4 = no jobs/parse skip.
Usage: ci_paths_gate.py <path-to-ci.yml> [--check]   (--check = dry, never write)
"""
import re
import sys

MARKER = "CI-THRIFT-V2 changes gate"

CHANGES_JOB = """  # {marker} — decide whether this change needs a build at all.
  # code=false when ONLY AI/ docs/ state/ logs/ .claude/ *.md changed
  # (framework/doc propagation); the heavy jobs below key off this and skip, so
  # an AI/docs-only PR spends ~one cheap runner-minute instead of the full
  # matrix. Always runs -> never a hanging required check. Non-PR events build.
  changes:
    name: Detect changes
    runs-on: ubuntu-latest
    outputs:
      code: ${{{{ steps.filter.outputs.code }}}}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: filter
        working-directory: ${{{{ github.workspace }}}}
        run: |
          if [ "${{{{ github.event_name }}}}" != "pull_request" ]; then
            echo "code=true" >> "$GITHUB_OUTPUT"; exit 0
          fi
          base="${{{{ github.event.pull_request.base.sha }}}}"
          if git diff --quiet "$base"...HEAD -- \\
              ':(exclude)AI' ':(exclude)docs' ':(exclude)state' ':(exclude)logs' \\
              ':(exclude).claude' ':(exclude)*.md'; then
            echo "code=false" >> "$GITHUB_OUTPUT"
            echo "AI/docs-only change -> heavy jobs skip (CI-thrift v2)"
          else
            echo "code=true" >> "$GITHUB_OUTPUT"
          fi
""".format(marker=MARKER)

GATE_LINES = [
    "    needs: changes\n",
    "    if: needs.changes.outputs.code == 'true'\n",
]
NEEDS_LINE = "    needs: changes\n"

JOB_HEADER = re.compile(r"^  ([A-Za-z0-9_.\-]+):\s*(#.*)?$")
IF_LINE = re.compile(r"^(    )if:\s*(\S.*?)\s*$")
IF_WRAPPED = re.compile(r"^\$\{\{\s*(.*?)\s*\}\}$")


def _merged_if(if_value):
    """Wrap an existing `if:` expression with the changes-gate condition.

    Returns the new full line value (text after `if: `), or None if the
    expression is a block/multi-line scalar we should not touch."""
    if if_value.startswith("|") or if_value.startswith(">"):
        return None  # block scalar — multi-line, leave for manual review
    m = IF_WRAPPED.match(if_value)
    inner = m.group(1) if m else if_value
    if "needs.changes.outputs.code" in inner:
        return None  # already gated somehow — don't double-wrap
    return "${{ needs.changes.outputs.code == 'true' && (%s) }}" % inner


def transform(text):
    """Return (new_text, changed, skipped_jobs) or (text, False, None) if no-op."""
    if MARKER in text:
        return text, False, []  # already gated

    lines = text.splitlines(keepends=True)

    # locate the top-level `jobs:` line
    jobs_idx = None
    for i, ln in enumerate(lines):
        if re.match(r"^jobs:\s*$", ln):
            jobs_idx = i
            break
    if jobs_idx is None:
        return text, False, None  # not a recognizable workflow

    # find job header line indices (2-space indent) after jobs:
    headers = []
    for i in range(jobs_idx + 1, len(lines)):
        ln = lines[i]
        if re.match(r"^[A-Za-z]", ln):
            break  # a new top-level key ended the jobs: block
        m = JOB_HEADER.match(ln)
        if m:
            headers.append((i, m.group(1)))

    if not headers:
        return text, False, None

    # defense in depth: a workflow that already has a `changes` job is gated
    # (e.g. scaffolded from templates/ci.yml) — never double-inject.
    if any(name == "changes" for _, name in headers):
        return text, False, []

    # for each job, determine its body span and whether it already has needs/if
    starts = [h[0] for h in headers]
    spans = []
    for k, (idx, name) in enumerate(headers):
        end = starts[k + 1] if k + 1 < len(starts) else len(lines)
        spans.append((idx, name, end))

    to_gate = []       # header idx -> inject needs+if (root job, no needs/no if)
    to_merge = []      # (header idx, if_idx, new_if_value) -> inject needs + merge if
    skipped = []       # jobs left untouched (needs present, or uncertain if:)
    for idx, name, end in spans:
        body = lines[idx + 1:end]
        has_needs = any(re.match(r"^    needs:", b) for b in body)
        if_hit = next(((i, m) for i, m in
                       ((idx + 1 + k, IF_LINE.match(b)) for k, b in enumerate(body))
                       if m), None)
        has_if = any(re.match(r"^    if:", b) for b in body)
        if has_needs:
            skipped.append(name)          # cascade-skips via deps, or custom — leave
        elif has_if:
            # review-workflow shape: gate a single-job workflow on its own if:.
            new_if = _merged_if(if_hit[1].group(2)) if if_hit else None
            if new_if is None:
                skipped.append(name)      # block/multi-line if: — manual review
            else:
                to_merge.append((idx, if_hit[0], new_if))
        else:
            to_gate.append(idx)

    if not to_gate and not to_merge:
        # nothing we can safely gate (all jobs already have needs/uncertain ifs)
        return text, False, skipped

    # Build the new file. Apply header/if edits from the BOTTOM up so indices stay
    # valid, then insert the changes job right after jobs:. For a merge job the
    # if-rewrite (higher line) is applied before the needs-insert (header+1).
    out = list(lines)
    edits = []  # (anchor_line, kind, payload) applied in descending anchor order
    for idx in to_gate:
        edits.append((idx + 1, "insert", GATE_LINES))
    for hdr, if_idx, new_if in to_merge:
        indent = "    "
        edits.append((if_idx, "replace", indent + "if: " + new_if + "\n"))
        edits.append((hdr + 1, "insert", [NEEDS_LINE]))
    for anchor, kind, payload in sorted(edits, key=lambda e: e[0], reverse=True):
        if kind == "insert":
            out[anchor:anchor] = payload
        else:
            out[anchor] = payload
    out[jobs_idx + 1:jobs_idx + 1] = [CHANGES_JOB]

    return "".join(out), True, skipped


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    check = "--check" in sys.argv
    if not args:
        sys.stderr.write("usage: ci_paths_gate.py <ci.yml> [--check]\n")
        sys.exit(2)
    path = args[0]
    try:
        text = open(path).read()
    except OSError as e:
        sys.stderr.write("cannot read %s: %s\n" % (path, e))
        sys.exit(2)

    new, changed, skipped = transform(text)
    if skipped is None:
        sys.exit(4)  # no recognizable jobs
    if not changed:
        sys.exit(3)  # already gated
    if skipped:
        sys.stderr.write("left untouched (already have needs/if): %s\n" % ", ".join(skipped))
    if not check:
        open(path, "w").write(new)
    sys.exit(0)


if __name__ == "__main__":
    main()
