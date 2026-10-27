#!/usr/bin/env python3
"""selfhosted_rewrite.py — enforce the "self-hosted runners only" rule on ONE
GitHub Actions workflow file (CLAUDE.md CRITICAL RULE 9 / AI_RULES §21).

What it does (surgical, comment-preserving, idempotent):
  1. Rewrites a direct `runs-on: ubuntu-latest` (or `ubuntu-NN.NN`, optionally
     bracketed/quoted) to `runs-on: [self-hosted, myai-local]`. ubuntu is a
     Linux target, so moving it onto the Linux/ARM64 self-hosted runner is safe.
  2. Strips the `push:` trigger from a block-form `on:` map (keeps
     pull_request + workflow_dispatch), and removes `push` from a flow-list
     `on: [push, ...]`. CI must run at PR time only (see rule 8 CI Thrift).
  3. Does NOT rewrite `windows-*` / `macos-*` runners or matrix `os` lists — a
     Windows/macOS job cannot run on the Linux/ARM64 self-hosted runner, and a
     matrix needs a human decision. It REPORTS them (tag WARN-HOSTED) so the
     rollout surfaces them and health_check keeps flagging them.

Usage:
  selfhosted_rewrite.py <workflow.yml>            # dry-run: print planned tags
  selfhosted_rewrite.py <workflow.yml> --apply    # edit in place

Prints one tag per action to stdout (consumed by rollout_selfhosted_runner.sh):
  RUNSON <lineno>          a hosted-ubuntu runs-on was/would be rewritten
  PUSH <lineno>            a push: trigger was/would be stripped
  WARN-HOSTED <lineno> <label>   a windows/macos/matrix hosted runner remains (manual)
Exit 0 always on a readable file; 2 on a read/parse error.
"""
import re
import sys

TARGET = "[self-hosted, myai-local]"
# A single hosted runner label, optionally bracketed and/or quoted.
_VAL = re.compile(r'^\[?\s*["\']?([a-z0-9.\-]+)["\']?\s*\]?$')
_HOSTED = re.compile(r'^(ubuntu|windows|macos)-(latest|[0-9]+(\.[0-9]+)?)$')
_RUNS_ON = re.compile(r'^(?P<indent>\s*)runs-on:\s*(?P<rest>.*?)\s*$')
_ON_KEY = re.compile(r'''^(["']?on["']?):\s*(.*?)\s*$''')
_INDENT = re.compile(r'^(\s*)')


def indent_of(line):
    return len(_INDENT.match(line).group(1))


def split_comment(rest):
    """Split a YAML scalar value from a trailing ' #...' comment (best-effort)."""
    m = re.search(r'\s#', rest)
    if m and not (rest.lstrip().startswith('#')):
        return rest[:m.start()].rstrip(), rest[m.start():]
    return rest, ''


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    apply = '--apply' in sys.argv[1:]
    if not args:
        print("usage: selfhosted_rewrite.py <workflow.yml> [--apply]", file=sys.stderr)
        return 2
    path = args[0]
    try:
        with open(path, 'r') as fh:
            lines = fh.readlines()
    except OSError as exc:
        print(f"ERROR cannot read {path}: {exc}", file=sys.stderr)
        return 2

    out = []
    tags = []
    i = 0
    n = len(lines)
    changed = False

    while i < n:
        line = lines[i]
        lineno = i + 1
        nl = '\n' if line.endswith('\n') else ''
        body = line[:-1] if line.endswith('\n') else line

        # ── runs-on rewrite ────────────────────────────────────────────────
        m = _RUNS_ON.match(body)
        if m:
            value, comment = split_comment(m.group('rest'))
            vm = _VAL.match(value.strip())
            label = vm.group(1) if vm else None
            if label and _HOSTED.match(label):
                if label.startswith('ubuntu-'):
                    newbody = f"{m.group('indent')}runs-on: {TARGET}"
                    if comment:
                        newbody += f"  {comment.lstrip()}"
                    tags.append(f"RUNSON {lineno}")
                    out.append(newbody + nl)
                    changed = True
                    i += 1
                    continue
                else:
                    # windows-*/macos-* — cannot move to Linux self-hosted.
                    tags.append(f"WARN-HOSTED {lineno} {label}")
            elif value and ('ubuntu-' in value or 'windows-' in value or 'macos-' in value):
                # a list of several labels / unusual shape — flag, don't rewrite.
                tags.append(f"WARN-HOSTED {lineno} {value.strip()}")
            out.append(line)
            i += 1
            continue

        # ── on: block — strip the push: trigger ────────────────────────────
        om = _ON_KEY.match(body)
        if om and indent_of(body) == 0:
            on_val = om.group(2)
            # Flow-list form: on: [push, pull_request, ...]
            if on_val.startswith('['):
                items = [x.strip() for x in on_val.strip('[]').split(',') if x.strip()]
                if 'push' in items:
                    kept = [x for x in items if x != 'push']
                    if kept:
                        out.append(f"{om.group(1)}: [{', '.join(kept)}]{nl}")
                    else:
                        out.append(f"{om.group(1)}: [workflow_dispatch]{nl}")
                    tags.append(f"PUSH {lineno}")
                    changed = True
                    i += 1
                    continue
                out.append(line)
                i += 1
                continue
            # Block form: on:\n  push:\n    ...\n  pull_request:\n ...
            if on_val == '' or on_val == '{}':
                out.append(line)
                i += 1
                j = i
                # scan the indented children of on:
                while j < n:
                    child = lines[j]
                    cbody = child[:-1] if child.endswith('\n') else child
                    if cbody.strip() == '':
                        out.append(child)
                        j += 1
                        continue
                    cind = indent_of(cbody)
                    if cind == 0:
                        break  # back to top level — on: block ended
                    if re.match(r'^\s*push:\s*(#.*)?$', cbody) or re.match(r'^\s*push:\s*\[', cbody):
                        push_ind = cind
                        tags.append(f"PUSH {j + 1}")
                        changed = True
                        j += 1
                        # drop push: children (strictly deeper) and blank lines within
                        while j < n:
                            k = lines[j]
                            kbody = k[:-1] if k.endswith('\n') else k
                            if kbody.strip() == '':
                                j += 1
                                continue
                            if indent_of(kbody) > push_ind:
                                j += 1
                                continue
                            break
                        continue
                    out.append(child)
                    j += 1
                i = j
                continue
            out.append(line)
            i += 1
            continue

        out.append(line)
        i += 1

    if apply and changed:
        with open(path, 'w') as fh:
            fh.write(''.join(out))

    for t in tags:
        print(t)
    return 0


if __name__ == '__main__':
    sys.exit(main())
