#!/usr/bin/env python3
"""ci_workflow_steps.py — read a repo's own GitHub Actions steps so local-ci can
mirror what its CI actually runs (connect #60, 2026-10-21: local-ci was green
while the hosted `build` failed `npm run openapi:check` and `Security Audit`
failed the repo's own secret scan).

Line-based on purpose: PyYAML is not guaranteed on the fleet's Macs, and the
two shapes we need are regular in every workflow we ship.

  ci_workflow_steps.py secret-steps <repo> <outdir>
      Writes the `run:` script of every step whose name mentions "secret" and
      whose script runs `git grep` to <outdir>/secret-step-<n>.sh, prints each
      path. Prints nothing when the repo has none.
  ci_workflow_steps.py npm-runs <repo>
      Prints every `npm run <script>` name the repo's workflows run, sorted.
"""
import os
import re
import sys


def workflow_files(repo):
    d = os.path.join(repo, ".github", "workflows")
    if not os.path.isdir(d):
        return []
    return sorted(
        os.path.join(d, f) for f in os.listdir(d) if f.endswith((".yml", ".yaml"))
    )


def indent_of(line):
    return len(line) - len(line.lstrip(" "))


def steps(path):
    """Yield (name, run_script) for each step that has a run: key."""
    lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    i, n = 0, len(lines)
    while i < n:
        m = re.match(r"^(\s*)-\s+name:\s*(.*)$", lines[i])
        if not m:
            i += 1
            continue
        item_indent = len(m.group(1))
        name = m.group(2).strip().strip("'\"")
        run, j = None, i + 1
        while j < n:
            ln = lines[j]
            if ln.strip() and indent_of(ln) <= item_indent:
                break
            r = re.match(r"^(\s*)run:\s*(.*)$", ln)
            if r:
                key_indent, rest = len(r.group(1)), r.group(2).strip()
                if rest in ("|", "|-", ">", ">-"):
                    body, k = [], j + 1
                    while k < n and (not lines[k].strip() or indent_of(lines[k]) > key_indent):
                        body.append(lines[k])
                        k += 1
                    pad = min((indent_of(b) for b in body if b.strip()), default=0)
                    run = "\n".join(b[pad:] for b in body).strip("\n") + "\n"
                    j = k
                    continue
                run = rest + "\n"
            j += 1
        if run is not None:
            yield name, run
        i = j


def main(argv):
    if len(argv) < 3 or argv[1] not in ("secret-steps", "npm-runs"):
        sys.stderr.write(__doc__)
        return 2
    repo = argv[2]
    if argv[1] == "secret-steps":
        if len(argv) < 4:
            sys.stderr.write("secret-steps needs <outdir>\n")
            return 2
        out, count = argv[3], 0
        for wf in workflow_files(repo):
            for name, run in steps(wf):
                if re.search(r"secret", name, re.I) and "git grep" in run:
                    count += 1
                    p = os.path.join(out, "secret-step-%d.sh" % count)
                    with open(p, "w", encoding="utf-8") as fh:
                        fh.write("# from %s — step: %s\n" % (os.path.relpath(wf, repo), name))
                        fh.write(run)
                    print(p)
        return 0
    names = set()
    for wf in workflow_files(repo):
        for _, run in steps(wf):
            names.update(re.findall(r"\bnpm run ([A-Za-z0-9:_-]+)", run))
    for s in sorted(names):
        print(s)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
