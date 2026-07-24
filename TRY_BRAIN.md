# Try the Brain — git-versioned agent memory in 5 minutes

Goal: prove the core loop of `myai brain` by hand — **init → work → stash →
pop from a second agent → merge → diff** — against a throwaway brain that
never touches your real one. Everything below is copy-paste; no gateway, no
Docker, no API key needed. The brain is plain git + plain files.

**The mental model:** the brain is a real, private git repo SEPARATE from your
code git. Sessions = commits. Wrap up = merge. Stash = freeze your context and
walk away — resume from ANY agent on ANY device. `main` = the consolidated
truth every agent boots from.

Time: ~5 minutes. Prerequisites: `git` + the `myai` CLI (`npm i -g
ai-management`, or run `./scripts/myai_brain.sh` straight from a
checkout — same thing).

## 0. Point at a throwaway brain

`MYAI_HOME` + `MYAI_BRAIN_DIR` override the resolution order for this shell
only, so your real brain (`~/.myai/brain`) and its pointer file are never
touched:

```bash
export MYAI_HOME="$(mktemp -d)"
export MYAI_BRAIN_DIR="$MYAI_HOME/brain"
```

## 1. Init — the brain is born

```bash
myai brain init
myai brain status
```

You get a git repo on branch `main` with `memory/` (cross-repo facts) and
`repos/` (per-project namespaces). `status` shows the branch, atom counts, and
any stashes waiting. Add `--remote git@yourhost:you/brain.git` to sync it
between machines later — it's just git.

## 2. Work — a session is a branch, memory is append-only atoms

Start a session branch and write some atoms (one immutable file each —
filenames embed a content hash, so parallel agents can never conflict):

```bash
myai brain session start demo          # → session/<today>-<host>-demo
echo "Decided to use JWT cookies for auth — bcrypt + HS256." \
  | myai brain write session my-app "auth decision"
echo "The demo user prefers dark mode." \
  | myai brain write memory - "user prefers dark mode"
myai brain log
```

Re-writing an identical atom is a no-op (dedup by content hash); changed
content is a NEW atom — history is never edited.

## 3. Stash — freeze context, walk away

You're mid-task and have to leave. Freeze the in-flight context, then wrap up
your session. The stash is committed straight to `main`, so it is NOT local
like `git stash` — any later session on any device sees it after a plain pull:

```bash
cat <<'EOF' | myai brain stash "auth wiring" my-app
In progress: wiring JWT auth into my-app.
Done: token issue + verify. Next: refresh rotation, then the login form.
Watch out: the cookie must be SameSite=Lax or the OAuth callback loses it.
EOF
myai brain stash list
myai brain merge          # wrap up: your session's atoms become truth on main
```

`merge` folds the session branch into `main` (`--no-ff`, so the session
boundary survives in history), deletes it, and auto-runs the distiller —
recompiling each namespace's artifacts on `main`: `brief.md` (~150-token boot
brief), `working.md` (~2k working context), `rollup.md` (one line per atom).
Reading the brain needs NO server: `git pull` → read files.

## 4. Pop — a second agent resumes, anywhere

Simulate a different machine/agent (new host identity, fresh session):

```bash
BRAIN_HOST=laptop-b myai brain session start evening
myai brain pop
```

`pop` prints the frozen context (frontmatter shows who stashed it, from which
branch, when) and removes the entry from `main` with a normal commit — nothing
is rewritten. The second agent now knows exactly where the first one stopped.
`myai brain pop <slug>` pops a specific stash instead of the newest.

## 5. Merge — the second session becomes truth too

The second agent finishes the job and wraps up the same way:

```bash
echo "Refresh rotation done; login form wired. Auth is complete." \
  | myai brain write session my-app "auth complete"
myai brain merge
myai brain status
cat "$MYAI_BRAIN_DIR/repos/my-app/brief.md"    # the compiled ~150-token boot brief
```

## 6. Diff / log / branch — git muscle memory, memory edition

```bash
myai brain diff main~1 main            # what did the last merge add?
myai brain branch redesign             # idea/redesign — long-lived parallel thought
echo "What if auth moved to passkeys entirely?" \
  | myai brain write memory - "passkey idea"
myai brain merge                       # idea branches SURVIVE their merge
myai brain checkout main
myai brain log 15
```

Made a mistake? `myai brain revert <sha>` undoes any commit with an inverse
commit — atoms stay append-only, history is never rewritten.

## 7. Clean up

```bash
rm -rf "$MYAI_HOME" && unset MYAI_HOME MYAI_BRAIN_DIR
```

Your real brain was never touched.

## What you just proved

- **Sessions = commits, wrap up = merge** — two agents on two "hosts" worked
  in parallel and merged conflict-free, because atoms are append-only files
  named by content hash.
- **Stash/pop crosses devices** — frozen context lives on `main`, not in a
  local ref, so any agent can resume it.
- **Boot is cheap** — a blank agent reads `brief.md` (~150 tokens), not your
  whole history; a returning agent asks only "what changed since my last SHA".
- **No server, no lock-in** — it's your git repo. `git log`, `git pull`, and
  plain files work on it like on any other repo.

Next: `myai up` starts the full stack, where the same brain is served to every
connected agent through the gateway's `brain_*` MCP tools (`brain_delta` gives
returning agents the diff-only catch-up). Automated coverage of everything
above: `scripts/tests/test_brain.sh` (bash) + `runtime/tests/unit/brain*.test.ts`
(node mirror).
