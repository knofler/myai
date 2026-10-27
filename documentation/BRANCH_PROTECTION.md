# Branch Protection — fleet standard, the `protect main` keyword, and the ship-it permission allowlist

> Origin: operator request 2026-10-02 (task-78db2c04).
> In Claude Code **auto mode** the built-in classifier denied the operator's attempt to
> ADD protection to `main` (`gh api -X PUT …/protection`, reason `[CI Bypass]`) and a
> read-only `pr_guard.sh` + `git log` chained after it. The operator had to run both by
> hand. A fleet check then found one repo's `main` had had **no protection at all**, despite
> CLAUDE.md declaring `main` PR-required. This doc is the fix's reference.

---

## 1. The fleet-standard protection

Applied to every repo's default branch (`main`). Matches the state the operator applied to
that repo by hand:

| Rule | Value | Why |
|------|-------|-----|
| `required_pull_request_reviews` | present, `0` approvals | A PR is **required** — no direct push to `main`. Zero human approvals: AI reviews, the operator/admin merges. |
| `required_status_checks` | the repo's real CI/Vercel check(s), `strict: false` | At least one gate must go green before merge. **Never a phantom check** (see §4). |
| `enforce_admins` | `false` | The deliberate admin-merge escape hatch for the Actions-billing-blocked case — see `ship it` §8 (`gh pr merge --merge --admin`). |
| `allow_force_pushes` | `false` | No history rewrite on `main`. |
| `allow_deletions` | `false` | `main` cannot be deleted. |
| `restrictions` | `null` | No push allow-list (the PR gate is the control). |

---

## 2. `protect main` — the sanctioned, TIGHTEN-ONLY path

```sh
# Apply to one repo (owner/repo slug, a checkout path, or a roster name):
./scripts/protect_main.sh <repo>
bash "$(myai root)/scripts/protect_main.sh" <repo>     # kernel repo (no local ./scripts)

./scripts/protect_main.sh <repo> --checks "Vercel"      # set the required check explicitly
./scripts/protect_main.sh <repo> --dry-run              # preview the payload, PUT nothing
./scripts/protect_main.sh --audit                       # read-only, whole fleet
./scripts/protect_main.sh --audit --json                # machine-readable
```

**Tighten-only by design.** `protect_main.sh` only ever `PUT`s the strict fleet-standard
protection. It has **no remove/loosen mode**, it never `DELETE`s protection, and it
**preserves** (unions, never drops) any required-status-check context the branch already
has. That property is what lets it be **pre-approved** in the permission allowlist (§3)
while a raw branch-protection write stays gated: the script can only ever make `main`
*safer*.

This is also the answer to "allow tightening but not removal, if that's expressible."
It is **not** expressible as a `Bash(…)` prefix rule — a PUT that tightens and a PUT that
loosens share the identical command prefix (`gh api -X PUT …/protection`); only the JSON
body differs. So the tighten/loosen distinction has to live in a **vetted script**, not a
permission glob. `protect_main.sh` is that script.

---

## 3. The ship-it permission allowlist (why the classifier was blocking)

A **kernel repo** (onboarded by `myai init`) ships with
`templates/settings.kernel.json` — which, before this change, had **no `permissions.allow`
list**, only the safety hooks + `defaultMode`. In a Team/Enterprise org, `bypassPermissions`
is server-side-gated and silently downgrades to the classifier-gated mode (CLAUDE.md →
*Zero-Prompt Policy*). With no allow-list, **every** Bash call falls to the built-in
auto-mode classifier — which denies branch-protection writes as `[CI Bypass]` and anything
chained with them.

How a `permissions.allow` entry helps: an explicit allow rule **skips the classifier** for
that command. So `templates/settings.kernel.json` now pre-approves the **safe** ship-it
surface only:

- **PR lifecycle** — `gh pr create|merge|view|checks|list|diff|status|comment|review|ready`.
  (`--admin` is *not* separately expressible as a prefix rule — it stays governed by the
  `ship it` §8 billing/outage guardrails and `enforce_admins`.)
- **Read-only + normal git** — status/log/diff/show/fetch/rev-parse/branch/merge-base/…
  plus add/commit/push/pull/merge/rebase/checkout. Push-to-`main` is still blocked by the
  `01-block-push-main` hook; force-push and `reset --hard origin` are in `deny`.
- **`gh api` GETs** — `gh api repos/…`, `gh api user…`, `gh api -X GET …`.
- **`pr_guard.sh` and `protect_main.sh`** resolved from the module root
  (`bash "$(myai root)/scripts/…"`) and the `./scripts/` / `./AI/scripts/` layouts.

**Deliberately absent / denied:**

- Branch-protection **writes** are **not** in `allow`: a raw `gh api -X PUT …/protection`
  stays classifier-gated → the operator runs it with `! …`, **or** the agent uses the
  tighten-only `protect main` keyword.
- `deny` adds `gh api -X DELETE` / `--method DELETE` (removes protection and other
  destructive API deletes) on top of the force-push / reset-hard denies.

**Operator consent at install.** The allowlist is a vetted, documented part of the kernel
wiring (the `$allow_comment` field in the template states exactly what and why). `myai init`
deep-merges it in (repo-local additions preserved); the operator consents by adopting the
fleet-standard kernel. The **master** repo (`.claude/settings.json`) already carries broad
`Bash(gh:*)` / `Bash(git:*)` allows, so its ship-it steps were never blocked; the one
recommended addition there is the `gh api -X DELETE` deny (see §6).

### Handling a classifier denial (ship it protocol)

When the classifier denies a step anyway: **STOP, print the exact command for the operator
to run with `! <command>`, and do not retry it, re-word it, split it into pieces, or route
around it.** Run read-only checks (`pr_guard.sh`, `git log`) as their **own** call — never
chained behind a gated write, or they go down with it. (This is how the original incident was handled.)

---

## 4. Required-check safety (phantom checks)

A required status check whose context **never actually runs** permanently blocks every
non-admin PR (CLAUDE.md §8, AI_RULES §20). `protect_main.sh` therefore **never invents** a
context. Resolution order:

1. `--checks "A,B"` (explicit), else
2. the branch's **existing** required contexts (read via GET — tighten-only), else
3. auto-detect from a local checkout (`vercel.json` → `Vercel`; `ci.yml` → `Lint,Type-check,Test`), else
4. **none**, with a loud warning (PR-required + no-force + no-delete still applied).

---

## 5. Auditing your fleet

Run `./scripts/protect_main.sh --audit` (the `protect main --audit` keyword). It walks
`config/managed_repos.txt` and `config/remote_fleet.txt` and prints one row per repo:
`PR-REQ` = a PR is required to merge to `main`; `NOFORCE` / `NODEL` = force-push /
deletion blocked; plus the required status checks.

Reading the result:

- **PR not required** (direct push still allowed): for each repo that is **yours to
  change**, run `./scripts/protect_main.sh <repo>` — but pass `--checks` (or confirm the
  repo has a real CI/Vercel context) so you don't apply PR-required with **no** working
  gate. Where a repo has no CI at all, PR-required alone is still an improvement over
  open push.
- **Do NOT modify shared / fetch-only repos** (a team repo you only fetch, or one marked
  `NEVER push` in `managed_repos.txt`): their protection is the upstream team's call.
- **Workspace roots and placeholder remotes:** some roster entries are workspace
  directories, or sub-paths whose `origin` is a placeholder slug. Verify the slug points
  at the real app repo before applying.
- Re-run `protect main --audit` after any pass to confirm.
