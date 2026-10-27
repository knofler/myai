# Windows compatibility — framework scripts (`init_ai.sh` / `update_all.sh` / `health_check.sh`)

> Every fleet script (`init_ai.sh`, `update_all.sh`, `health_check.sh`, the
> `scripts/lib/*.sh` they share, and the runner libs) is bash-only. This page
> covers the three most commonly run ones — bootstrap, propagate, audit — for
> an operator on Windows. For the autonomous CLI runner specifically, see
> `documentation/WINDOWS_RUNNER.md` (same underlying platform story, different
> script).

**Support tier: best-effort, CI-covered.** These scripts are bash and were
developed on macOS/Linux. They are **not** ported to native PowerShell —
they lean on bash constructs (process substitution, arrays, `trap`-based
cleanup, `set -e`) that would need a rewrite, not a translation, to become
idiomatic pwsh. Instead: run them under **Git Bash** (already a prerequisite —
these scripts assume `git`) or **WSL2**, and CI now exercises that exact path
on a real Windows runner.

## Which path?

| | Git Bash (works today, no extra install) | WSL2 (recommended for heavier use) |
|---|---|---|
| Provided by | Git for Windows (`git` is already required) | `wsl --install -d Ubuntu` |
| Environment | MSYS2 bash on top of Windows | real Linux userland |
| Coverage | **Not CI-tested on Windows** — the hosted `windows-latest` lane was removed 2026-10-03 (no Windows operators; rule 9). The same suite runs on macOS + Linux bash | same code path as Linux — see `WINDOWS_RUNNER.md` Path A |
| When to pick | one-off `init_ai.sh` on a new project, occasional `health_check.sh` | doing framework dev, running `update_all.sh` regularly, or anything that shells out to Python |

## Running the scripts (Git Bash)

```bash
# from Git Bash, at the repo root
./scripts/init_ai.sh /c/path/to/your/project
./scripts/health_check.sh /c/path/to/your/project
./scripts/update_all.sh
```

Same commands as macOS/Linux — Git Bash translates the POSIX paths, and these
three scripts (unlike the native `.ps1` runner installer) don't touch anything
Windows-specific (no `schtasks`, no registry, no ACLs).

## CI coverage

`scripts/tests/test_windows_framework_scripts.sh` runs in `scripts/tests/run_all.sh`
on macOS (every boot) and Linux (self-hosted CI). The hosted `windows-latest`
workflows (`windows-framework-ci.yml`, `windows-runner-ci.yml`) were deleted on
2026-10-03: nobody runs myAI on Windows, hosted runners are disallowed outside
`<exempt-org>` (CLAUDE.md rule 9), and they failed every PR on billing. If a
Windows operator appears, restore them from git history (`git log --diff-filter=D
-- .github/workflows/windows-*`) onto a self-hosted Windows runner. The suite:

1. `bash -n` syntax-parses all three scripts plus `lib/merge_json.sh` and
   `lib/sync_guard.sh` — catches a bash-dialect break immediately.
2. Runs `init_ai.sh` end-to-end against a throwaway fixture project (asserts
   exit 0, `AI/` structure created, tracking-file entry added).
3. Runs `update_all.sh` against that fixture (tracking file swapped
   temporarily, restored via `trap` even on failure — the real
   `config/managed_repos.txt` fleet roster is never touched).
4. Runs `health_check.sh` against the fixture and asserts it completes with a
   defined exit code (0/1/2 by design) and prints its Summary section.

Run it locally on any platform: `./scripts/tests/test_windows_framework_scripts.sh`.

## Known limitation — the `/usr/bin/python3` convention

`merge_json.sh` (used by both `init_ai.sh` and `update_all.sh` to merge
`.claude/settings.json`/`.mcp.json` without clobbering repo-local additions)
shells out to a hardcoded `/usr/bin/python3` — a convention used fleet-wide,
not something this change rewrites. On macOS/Linux that path is reliably
present; **Git Bash on Windows does not ship a `/usr/bin/python3`**, so on a
plain Git Bash install the merge step gracefully **SKIPs** (it's designed to
degrade non-fatally — the calling script still completes, it just reports
`SKIPPED — ...` for that one file instead of merging it). WSL2 doesn't have
this gap (real `/usr/bin/python3` via `apt install python3`). If you need the
settings-merge behavior on Windows without WSL2, install Python so it
resolves at that exact path inside your Git Bash environment (e.g. via
MSYS2's `pacman -S python`), or use WSL2.

---

*Related: `documentation/WINDOWS_RUNNER.md` (autonomous CLI runner on
Windows) · `scripts/tests/test_windows_framework_scripts.sh`.*
