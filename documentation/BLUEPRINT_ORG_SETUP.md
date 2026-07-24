# Blueprint Org Setup — one-time-per-org checklist

> Configure each GitHub org **once** so every blueprint repo created under it
> inherits the same protection, required checks, secrets, and "Use this template"
> button. Per-project hookups (Vercel/Atlas/Sentry/Anthropic) are in
> **`BLUEPRINT_HOOKUP.md`** — this file is the org-level foundation those rely on.
>
> Orgs in scope: `powerhouse-ict`, `powerhousemuseum`, future `powerhouse-labs` /
> `powerhouse-blueprints`, and personal `knofler`.

---

## 1. Branch protection (per org, applied to each repo's `main`)

Protect `main` so nothing lands without passing the gate. Repo → Settings →
Branches → **Add rule** for `main`:

- [x] Require a pull request before merging (≥ 1 approval)
- [x] Require status checks to pass before merging — select: **CI / Lint**,
      **CI / Type-check**, **CI / Test**, **CI / Build**, **Merge Gate**
- [x] Require branches to be up to date before merging
- [x] Require conversation resolution before merging
- [x] Do **not** allow force pushes / deletions
- [ ] `enforce_admins` — leave **off** so the fleet's local-ci + `--admin` merge
      fallback works when Actions is billing-blocked (see CLAUDE.md "Local-CI
      Policy"). Turn on only for the most sensitive prod repos.

CLI (repeat per repo, or script across the org):

```bash
gh api -X PUT repos/<org>/<repo>/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -f "required_pull_request_reviews[required_approving_review_count]=1" \
  -F "required_status_checks[strict]=true" \
  -f "required_status_checks[checks][][context]=CI / Lint" \
  -f "required_status_checks[checks][][context]=CI / Type-check" \
  -f "required_status_checks[checks][][context]=CI / Test" \
  -f "required_status_checks[checks][][context]=CI / Build" \
  -f "required_status_checks[checks][][context]=Merge Gate" \
  -F "enforce_admins=false" \
  -F "restrictions=null"
```

> **Test/codeclot branches stay unprotected** — they are sync/integration
> branches. Only `main` is protected.

---

## 2. Required status checks

The blueprint's `ci.yml` exposes jobs **Lint, Type-check, Test, Build**;
`merge-gate.yml` exposes **Merge Gate** (enforces PRs to `main` come from
`test`/`hotfix/*`). Add `claude-review` / `copilot-review` to required checks
only after they're proven non-flaky in the org — start them advisory.

---

## 3. Org-level secrets

Org → Settings → **Secrets and variables → Actions → New organization secret**.
Set once; every repo inherits them (scope to *all* or *selected* repos).

| Secret | Used by | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `claude-review.yml`, scripts | **Agent SDK credit pool** key, not the interactive subscription |
| `VERCEL_TOKEN` | deploy automation | scope to deploy-capable repos |
| `SENTRY_AUTH_TOKEN` | build source-map upload | `project:releases` + `org:read` |
| `MONGODB_ATLAS_API_KEY` | provisioning automation | only if auto-provisioning Atlas |

```bash
gh secret set ANTHROPIC_API_KEY --org <org> --visibility all
gh secret set VERCEL_TOKEN      --org <org> --visibility all
gh secret set SENTRY_AUTH_TOKEN --org <org> --visibility all
```

> Per-repo override: `gh secret set <NAME> --repo <org>/<repo>`.

---

## 4. Copilot code review (for `copilot-review.yml`)

1. Org → Settings → **Copilot** → enable **Copilot in GitHub** for members.
2. Enable **Copilot code review** (Repository → Settings → Code review, or
   org policy). The workflow requests `copilot-pull-request-reviewer` as a
   reviewer; without the feature it logs a notice and no-ops.

### 4a. Turn OFF *automatic* Copilot review — it must be code-PR-only (AI_RULES §17.2)

Actions/Copilot credit is scarce (§17). Copilot must review **only PRs that carry
genuine code**, never docs/AI-only PRs. There are two ways Copilot can run — keep
exactly the first:

- **✅ Workflow-requested (keep).** `copilot-review.yml` carries the §16 `changes`
  gate (`if: needs.changes.outputs.code == 'true'`), so it requests Copilot **only**
  when a PR touches real code. Docs/AI-only PRs skip it entirely.
- **❌ Automatic App review (DISABLE).** If the org/repo has *"Copilot automatically
  reviews pull requests"* enabled (a repository **ruleset** or the repo Code-review
  setting), Copilot reviews **every** PR — bypassing the gate and burning credit on
  docs PRs. **Turn it off** so the gated workflow is the only trigger:
  - Repo → Settings → **Rules → Rulesets** → any ruleset with *"Request pull request
    review from Copilot" / "Automatically request Copilot review"* → **disable** that
    requirement (or delete the ruleset if it exists only for this).
  - Repo/Org → Settings → **Code review** → uncheck *"Automatically review pull
    requests"* for Copilot.
  - Detect + audit across the fleet with `scripts/disable_copilot_autoreview.sh`
    (best-effort ruleset scan via `gh api`; prints the manual toggle when the setting
    is UI-only).

Net effect: a docs/`AI_RULES`/hook PR gets **no** Copilot review; a code PR gets one.

---

## 5. GitHub Template Repository marker

Make the canonical blueprint (`knofler/todo-blueprint`, and per-org mirrors)
usable via the GitHub UI **"Use this template"** button:

- Repo → Settings → **Template repository** ✔
- Or: `gh repo edit <org>/<blueprint-repo> --template`

Org members can then scaffold from the UI; the CLI path stays
`init blueprint <path> --mode template --gh-create <org>/<name>`.

---

## 6. Vercel org/team link (optional)

1. Vercel → connect the GitHub org (Git Integration).
2. Decide default scope: **personal** (`knoflers-projects`) for sandbox/test
   apps (no SSO wall on preview URLs); **team** for production Powerhouse apps.
3. Set org-wide env defaults (e.g. `SENTRY_ORG`) at the Vercel team level so new
   projects inherit them.

---

## 7. Per-org rollout order (from POWERHOUSE_BLUEPRINT.md §5)

1. `knofler` (personal) — proven on `todo-blueprint`.
2. `powerhouse-labs` / `powerhouse-blueprints` — host the org template repo.
3. `powerhouse-ict` — first real internal repo.
4. `powerhousemuseum` — first real public repo.
5. Mark the blueprint as a Template Repository in each org once stable.

---

## 8. Verification

```bash
# Branch protection present?
gh api repos/<org>/<repo>/branches/main/protection --jq '.required_status_checks.checks[].context'
# Org secrets present?
gh secret list --org <org>
# Template marker?
gh repo view <org>/<blueprint-repo> --json isTemplate --jq .isTemplate
```

All three green → a new repo scaffolded with `init blueprint` under this org is
protected, gated, secret-equipped, and template-able with zero per-repo setup.
