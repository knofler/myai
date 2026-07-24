# CI Policies — Local-CI fallback + CI/Vercel Thrift (POLICY LEVEL — fleet-wide)

> Load-on-demand policy. `CLAUDE.md` keeps one-line pointers to this file; the full text lives here to keep the per-turn context small. These are still standing POLICY for every repo.

---

## Local-CI Policy — CI-credit exhaustion

> **Standing policy for every repo and every AI agent (master + all managed):** when GitHub Actions cannot run a required check — billing/credit exhausted ("recent account payments have failed or your spending limit needs to be increased"), an Actions outage, or no workflow run appears for the pushed SHA within ~2 min — **fall back to `local-ci.sh`**, do not stall the pipeline waiting for Actions and do not silently skip the checks. This was promoted from "fallback" to standing policy on 2026-06-10 after recurring Actions billing exhaustion.

**The local-CI path (all repos):**
1. Push to `test` as normal.
2. If the required Actions check doesn't start/finish, run `./scripts/local-ci.sh` (master) or `./AI/scripts/local-ci.sh` (managed). It discovers the required checks from branch protection, runs their Docker equivalents locally, and posts `success` commit statuses **only for checks that genuinely pass**. Use `--trust-build` only when you've manually verified the build.
3. **Announce the fallback** every time you take it ("GitHub Actions billing-blocked → local-ci fallback").
4. Always run the real gates first (tsc, tests, build in Docker) — local-ci posts statuses, it does not replace verification. Never post a green status for a check that didn't actually pass.

**Merging when a required check is app-pinned:** branch protection may pin the required check to the GitHub Actions app (`required_status_checks.checks[].app_id`). A `local-ci` commit-status posted under a different identity then can't satisfy it, so the PR stays BLOCKED. Complete the merge with `gh pr merge --merge --admin` after local-ci passes — this is sanctioned wherever branch protection permits the admin path (`enforce_admins: false`). The quality gate (tests/build) ran locally and passed, local-ci validated the branch policy, and the repo config allows the override. Always state when you take it. (Scope: see "Bypass applies to ALL repos" below — this now covers managed/production repos too, with guardrails.)

**Bypass applies to ALL repos when Actions is billing-blocked (fleet-wide, user-authorized 2026-06-12).** When GitHub Actions cannot run a required check because of billing/credit exhaustion (or an outage) and an app-pinned required check therefore leaves the PR `BLOCKED` even after local-ci posts a green status, **complete the merge with `gh pr merge --merge --admin` — on managed/production app repos too**, not only the master/infra repo. This reverses the earlier "production repos report-and-wait, never admin-bypass" rule.

**Non-negotiable guardrails (these still hold — the bypass is about CI *credits*, never about skipping verification):**
1. **Run the real gates locally FIRST** — tsc + tests + build in Docker must actually pass. local-ci posts statuses; it does NOT replace verification.
2. **Never post a green status for a check that didn't genuinely pass.** Use `--trust-build` only when you've manually verified the build.
3. **Only bypass for the billing/outage condition** — if a required check FAILS on real grounds (a test breaks, tsc errors), that is NOT a billing block; fix it, never admin-merge over a genuine red.
4. **Announce every bypass** ("Actions billing-blocked → local-ci + admin-merge").
5. **`--admin` only succeeds where branch protection permits it** (`enforce_admins: false` / no unmet required reviews). On a repo configured with `enforce_admins: true` the override is rejected by GitHub — in that case report the blocker and wait, or ask the user to relax enforcement.
6. **Restore normal Actions-based CI as soon as billing/credit is fixed** — this path is a billing-outage fallback, not the steady state.

---

## CI/Vercel Thrift Policy — stop credit burn (fleet-wide, 2026-06-12)

> **Standing policy for every repo:** CI and Vercel must NOT run on every push. The previous setup (CI `on: push:[main,test]` + Vercel auto-deploy on every push) ran the test/build/deploy pipeline 2–3× per change and burned Actions/Vercel credits continuously. New rule: **verify locally in Docker first; remote CI/deploy is a PR-to-main gate, not a per-push tax.**

**The three levers (all rolled out via `scripts/rollout_ci_thrift.sh`):**

1. **GitHub Actions — CI runs ONCE, at PR-to-`main` only.** `ci.yml` triggers on `pull_request: [main]` + `workflow_dispatch` only — the `push` trigger is removed, so pushes to `test` (or any branch) trigger **zero** CI runs. `concurrency: cancel-in-progress` cancels superseded runs. `templates/ci.yml` carries this for all future scaffolds.
2. **Vercel — production deploys only.** `vercel.json` → `"git": {"deploymentEnabled": {"main": true, "test": false}}`. No preview build on every test-branch push. `templates/vercel.json` is the scaffold default.
3. **Pre-push Docker gate.** A `.git/hooks/pre-push` hook runs `local-ci.sh` (Docker tsc + tests + build) before any push, so broken code never reaches the remote and wastes a run. Skippable with `git push --no-verify`; auto-skips `chore: update state` commits.

**Verification is local now:** before pushing, run `./scripts/local-ci.sh` (master) or `./AI/scripts/local-ci.sh` (managed) — Docker tsc + tests + build. This is the same tool the Local-CI Policy uses; it's now the primary gate, with Actions reserved for the final PR-to-main check.

**Rollout:** `./scripts/rollout_ci_thrift.sh` (dry-run default; `--apply` edits working trees; `--apply --commit` commits). Skips AI-folder-only / no-push repos (e.g. a read-only mirror). The new `ci.yml` must reach BOTH `test` and `main` to fully stop push-CI. Composes with the Local-CI Policy (admin-merge when Actions is billing-blocked).
