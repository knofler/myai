#!/usr/bin/env python3
"""release_version.py — conventional-commit → semver release automation (zero-dep).

The dependency-free "semantic-release equivalent" for ai-management. It
computes the next version from conventional commits since the last release tag,
renders changelog notes, and can apply the bump to package.json + CHANGELOG.md.
No npm packages, no network — stdlib only — so it runs identically on a dev box,
in the hermetic shell-unit-test CI (script-unit-tests.yml), and in release.yml.

Subcommands
  current                                   print the package.json version
  bump   [--from REF] [--commits-file F]    print bump type: major|minor|patch|none
  next   [--from REF] [--commits-file F]    print the next version (X.Y.Z)
  notes  [--from REF] [--commits-file F]    print grouped changelog notes (markdown)
  apply  [--from REF] [--commits-file F]    bump package.json + prepend CHANGELOG.md

Bump rules (Conventional Commits ↔ SemVer)
  major  — any commit with a `!` after type/scope, or a `BREAKING CHANGE:` footer
  minor  — any `feat` commit
  patch  — any `fix` or `perf` commit
  none   — nothing release-worthy (chore/docs/test/refactor/ci/style/build only)

Commit input
  Default: git commit bodies in `<REF>..HEAD`. REF defaults to the latest `v*`
  tag; with no tag, the whole history is considered. Hermetic override:
  --commits-file reads commit messages separated by the ASCII record separator
  (\\x1e, "␞") — the tests feed fixtures this way so NO git repo is needed.
  `--commits-file -` reads from stdin.

Flags
  --repo-root DIR   repo root (default: the script's parent-of-parent)
  --date YYYY-MM-DD changelog date for `apply` (default: today, or $RELEASE_DATE)
  --release-as X    force the bump for `next`/`apply`: major|minor|patch

Exit 0 on success; 2 on usage/IO error; 3 when a bump/next is requested but no
release-worthy commit exists (so callers can cleanly skip a no-op release).
"""
from __future__ import annotations

import argparse
import datetime
import os
import re
import subprocess
import sys

RS = "\x1e"  # ASCII record separator — commit delimiter (git: --format=...%x1e)

# type(scope)!: subject  — capture type + the optional breaking `!`
_HEADER = re.compile(r"^(?P<type>[a-zA-Z]+)(?:\([^)]*\))?(?P<bang>!)?:", re.MULTILINE)
_BREAKING_FOOTER = re.compile(r"^BREAKING[ -]CHANGE:", re.MULTILINE)

_RANK = {"none": 0, "patch": 1, "minor": 2, "major": 3}
_RANK_NAME = {v: k for k, v in _RANK.items()}


def _repo_root(args) -> str:
    if args.repo_root:
        return os.path.abspath(args.repo_root)
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def read_version(root: str) -> str:
    """Read the "version" field from package.json without a JSON reformat risk."""
    path = os.path.join(root, "package.json")
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    m = re.search(r'"version"\s*:\s*"([^"]+)"', text)
    if not m:
        sys.exit("release_version: no \"version\" in package.json")
    return m.group(1)


def _git_latest_tag(root: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", root, "describe", "--tags", "--abbrev=0", "--match", "v*"],
            capture_output=True, text=True, check=True,
        )
        tag = out.stdout.strip()
        return tag or None
    except subprocess.CalledProcessError:
        return None  # no tags yet


def collect_commits(root: str, ref: str | None, commits_file: str | None) -> list[str]:
    """Return a list of full commit messages (subject + body) to analyse."""
    if commits_file:
        raw = sys.stdin.read() if commits_file == "-" else open(commits_file, encoding="utf-8").read()
        return [c.strip() for c in raw.split(RS) if c.strip()]
    base = ref or _git_latest_tag(root)
    rng = f"{base}..HEAD" if base else "HEAD"
    try:
        out = subprocess.run(
            ["git", "-C", root, "log", rng, f"--format=%B{RS}"],
            capture_output=True, text=True, check=True,
        )
    except subprocess.CalledProcessError as e:
        sys.exit(f"release_version: git log failed: {e.stderr.strip()}")
    return [c.strip() for c in out.stdout.split(RS) if c.strip()]


def classify(commit: str) -> str:
    """Return the bump a single commit implies: major|minor|patch|none."""
    m = _HEADER.search(commit)
    if _BREAKING_FOOTER.search(commit) or (m and m.group("bang")):
        return "major"
    if not m:
        return "none"
    t = m.group("type").lower()
    if t == "feat":
        return "minor"
    if t in ("fix", "perf"):
        return "patch"
    return "none"


def decide_bump(commits: list[str]) -> str:
    """Highest-ranked bump across all commits (Conventional-Commits precedence)."""
    best = "none"
    for c in commits:
        b = classify(c)
        if _RANK[b] > _RANK[best]:
            best = b
        if best == "major":
            break
    return best


def next_version(current: str, bump: str) -> str:
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)", current)
    if not m:
        sys.exit(f"release_version: unparseable version {current!r}")
    major, minor, patch = (int(x) for x in m.groups())
    if bump == "major":
        return f"{major + 1}.0.0"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    if bump == "patch":
        return f"{major}.{minor}.{patch + 1}"
    return current


# ── changelog rendering ──────────────────────────────────────────────────────
_SECTIONS = [
    ("feat", "### Added"),
    ("fix", "### Fixed"),
    ("perf", "### Performance"),
]


def _first_line(commit: str) -> str:
    return commit.splitlines()[0].strip() if commit.strip() else ""


def render_notes(commits: list[str]) -> str:
    """Group release-worthy commits into a Keep-a-Changelog markdown block."""
    buckets: dict[str, list[str]] = {"feat": [], "fix": [], "perf": [], "breaking": []}
    for c in commits:
        m = _HEADER.search(c)
        if not m:
            continue
        subject = _first_line(c)
        t = m.group("type").lower()
        if _BREAKING_FOOTER.search(c) or m.group("bang"):
            buckets["breaking"].append(subject)
        if t in buckets:
            buckets[t].append(subject)
    out: list[str] = []
    if buckets["breaking"]:
        out.append("### Breaking")
        out += [f"- {s}" for s in buckets["breaking"]]
        out.append("")
    for key, heading in _SECTIONS:
        items = buckets[key]
        if not items:
            continue
        out.append(heading)
        out += [f"- {s}" for s in items]
        out.append("")
    return "\n".join(out).rstrip() + ("\n" if out else "")


def _today(args) -> str:
    if args.date:
        return args.date
    env = os.environ.get("RELEASE_DATE")
    if env:
        return env
    return datetime.date.today().isoformat()


def apply_bump(root: str, current: str, new: str, notes: str, date: str) -> None:
    # 1. package.json — surgical line replace, preserve the rest verbatim.
    pkg = os.path.join(root, "package.json")
    with open(pkg, encoding="utf-8") as fh:
        text = fh.read()
    text2, n = re.subn(
        r'("version"\s*:\s*")' + re.escape(current) + r'(")',
        r"\g<1>" + new + r"\g<2>", text, count=1,
    )
    if n != 1:
        sys.exit(f"release_version: could not rewrite version {current} → {new} in package.json")
    with open(pkg, "w", encoding="utf-8") as fh:
        fh.write(text2)

    # 2. CHANGELOG.md — insert a new section right after `## [Unreleased]`.
    ch = os.path.join(root, "CHANGELOG.md")
    with open(ch, encoding="utf-8") as fh:
        clog = fh.read()
    block = f"## [{new}] — {date}\n"
    if notes.strip():
        block += "\n" + notes.rstrip() + "\n"
    if "## [Unreleased]" in clog:
        clog = clog.replace(
            "## [Unreleased]\n",
            f"## [Unreleased]\n\n{block}",
            1,
        )
    else:
        # No Unreleased header — prepend the section above the first `## [`.
        idx = clog.find("\n## [")
        if idx == -1:
            clog = clog.rstrip() + "\n\n" + block
        else:
            clog = clog[: idx + 1] + block + "\n" + clog[idx + 1:]
    with open(ch, "w", encoding="utf-8") as fh:
        fh.write(clog)


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="release_version.py", add_help=True)
    p.add_argument("cmd", choices=["current", "bump", "next", "notes", "apply"])
    p.add_argument("--from", dest="ref", default=None)
    p.add_argument("--commits-file", default=None)
    p.add_argument("--repo-root", default=None)
    p.add_argument("--date", default=None)
    p.add_argument("--release-as", choices=["major", "minor", "patch"], default=None)
    args = p.parse_args(argv)

    root = _repo_root(args)
    current = read_version(root)

    if args.cmd == "current":
        print(current)
        return 0

    commits = collect_commits(root, args.ref, args.commits_file)
    bump = args.release_as or decide_bump(commits)

    if args.cmd == "bump":
        print(bump)
        return 0 if bump != "none" else 3

    if args.cmd == "next":
        if bump == "none":
            print(current)
            return 3
        print(next_version(current, bump))
        return 0

    if args.cmd == "notes":
        print(render_notes(commits), end="")
        return 0 if bump != "none" else 3

    if args.cmd == "apply":
        if bump == "none":
            print(f"release_version: no release-worthy commits — {current} unchanged", file=sys.stderr)
            return 3
        new = next_version(current, bump)
        apply_bump(root, current, new, render_notes(commits), _today(args))
        print(new)
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
