# Release Runbook — `ai-management`

The release artifacts (version, changelog, distribution docs, demo) are prepared
in the repo. There are two paths:

- **First publish → manual** (this doc's runbook). The very first `npm publish`
  is deliberately human-owed: it needs an interactive `npm login`, claims the
  scoped name, and is irreversible.
- **Every release after → automated cadence** (see
  [Automated cadence](#-automated-cadence-semantic-release-equivalent) below).
  A zero-dependency "semantic-release equivalent" computes the version from
  Conventional Commits, and `.github/workflows/release.yml` runs the clean-room
  guard + tests and publishes to npm when a GitHub Release is cut.

---

## ⚡ `myai release` — one command, not a manual checklist

`scripts/myai_release.sh` (wired up as `myai release`) wraps everything below
into a single repeatable tool, split into two phases so the version-bump
commit still goes through the normal `test` → `main` PR flow (it never pushes
to `main`) and the tag still only gets cut once that commit has actually
landed:

```bash
# on test (or any branch) — bump + changelog + clean-room validate + commit
myai release              # auto-detects patch/minor/major from Conventional Commits
myai release minor        # or force a level: patch | minor | major
myai release --dry-run    # preview the plan (current → next, notes) — mutates nothing

# ship it   → test → main PR, merges as usual

# on main, after the PR merges — tag + push (never a branch push)
myai release --tag
gh release create v$(python3 scripts/release_version.py current) --generate-notes
```

The cut phase's clean-room validation is the same three checks described
below — shell unit suite, `publish_guard.sh` leak scan, and a genuine Docker
install/smoke check (packs the real tarball, installs it in a throwaway
`node:20-alpine` container, runs `myai --version`) — run automatically, in
order. **Any failure auto-reverts the version bump** (`package.json` +
`CHANGELOG.md`) so the tree is never left half-applied. Skip a stage with
`--skip-tests` / `--skip-guard` / `--skip-docker` (or `--no-commit` to apply
without committing). Full flag reference: `myai release --help`. Unit-tested
in `scripts/tests/test_myai_release.sh`.

The manual steps below still work — `myai release` is a wrapper around them,
not a replacement — and remain the reference for the very first publish.

---

## 🤖 Automated cadence (semantic-release equivalent)

Two pieces, both zero-dependency and CI-thrift-compliant (no per-push tax):

**`scripts/release_version.py`** — Conventional-Commits → SemVer, stdlib only:

```bash
python3 scripts/release_version.py current   # 0.2.0
python3 scripts/release_version.py bump       # major | minor | patch | none  (exit 3 = none)
python3 scripts/release_version.py next        # the computed next version, e.g. 0.3.0
python3 scripts/release_version.py notes       # grouped Keep-a-Changelog markdown
python3 scripts/release_version.py apply       # bump package.json + prepend CHANGELOG.md
```

Bump rules: `feat` → minor, `fix`/`perf` → patch, `!`/`BREAKING CHANGE:` → major,
everything else (chore/docs/test/refactor/ci/style/build) → no release. Force a
level with `--release-as major|minor|patch`. Range defaults to `<last v* tag>..HEAD`.
Unit-tested in `scripts/tests/test_release_version.sh` (run by `run_all.sh` →
`script-unit-tests.yml`).

**`.github/workflows/release.yml`** — two human-gated entry points, never `push`:

1. **Plan** (`workflow_dispatch`, dry-run) — computes current→next + notes, runs
   `publish_guard.sh` + the unit suite, and writes the plan (with the exact
   `apply` / `gh release create` commands) to the job summary. Publishes nothing.
2. **Publish** (`release: published`) — fires when you cut a GitHub Release
   `vX.Y.Z`. Verifies the tag matches `package.json`, HARD-runs `publish_guard.sh`
   + the unit suite, `npm publish --access public` (needs the `NPM_TOKEN` repo
   secret), then verifies the version is live on the registry.

The **normal cadence** once the first publish is done:

```bash
gh workflow run release.yml                         # (optional) preview the plan in the run summary
python3 scripts/release_version.py apply            # bump package.json + CHANGELOG
# ship it   → test → main PR (CI-thrift gated, merge-gate + unit tests)
git checkout main && git pull                        # after the PR merges
NEXT="v$(python3 scripts/release_version.py current)"
git tag -a "$NEXT" -m "myai ${NEXT#v}" && git push origin "$NEXT"
gh release create "$NEXT" --generate-notes           # → triggers the PUBLISH job → npm
```

One-time enablement: add the **`NPM_TOKEN`** repo secret (an npm automation
token with publish rights) so the publish job can authenticate. Until it's set,
the job fails loudly and you fall back to the manual runbook below.

---

## ✅ PUBLISH-READY — what's already done

- `package.json` is set: name `ai-management`, version **0.2.0**, bins
  `myai` + `ai-manage`, `files` allowlist, `prepublishOnly` → `publish_guard.sh`.
- `CHANGELOG.md` cut for **0.2.0** (Keep a Changelog + semver).
- `documentation/DISTRIBUTION.md` — npm + `curl | sh` install paths.
- `scripts/demo.sh` — record-friendly CLI walkthrough.
- Clean-room gate wired: `scripts/publish_guard.sh` runs automatically on
  `npm publish` and hard-blocks on any operator-context leak.
- `npm login` — completed by the operator (2026-06-26, per the Independent
  Edition plan). Publish is unblocked, gated only by the leak scan passing.

## 🔑 USER-OWED — the publish itself

These steps are **not** run from the autonomous/headless runner (host `npm` is
Docker-only here, and publishing is irreversible). Run them yourself:

```bash
# 0. Be on a clean, merged main (release from main, not test).
git checkout main && git pull origin main

# 1. Confirm identity + version.
npm whoami                       # expect your npm user
node bin/myai.cjs --version      # expect 0.2.0

# 2. Dry-run the tarball and READ what would ship.
npm pack --dry-run               # also: npm run smoke

# 3. Run the clean-room leak gate explicitly (also runs on publish).
bash scripts/publish_guard.sh    # MUST exit 0 — fix any leak before publishing

# 4. Publish (scoped public package).
npm publish --access public      # prepublishOnly re-runs publish_guard.sh

# 5. Verify it's live.
npm view ai-management version
npx ai-management@latest --version
```

## 🏷️ Tag + GitHub release (after a successful publish)

```bash
git tag -a v0.2.0 -m "myai 0.2.0 — Independent Edition (first public release)"
git push origin v0.2.0

# GitHub release with notes pulled from the changelog:
gh release create v0.2.0 \
  --title "v0.2.0 — Independent Edition" \
  --notes-file <(awk '/^## \[0.2.0\]/{f=1} f&&/^## \[Unreleased\]/{exit} f' CHANGELOG.md)
```

(Or `gh release create v0.2.0 --generate-notes` to auto-build notes from commits.)

## After release

1. Move the `[0.2.0]` section's "Unreleased" link forward and start a fresh
   `## [Unreleased]` block in `CHANGELOG.md`.
2. Bump `package.json` `version` for the next cycle when work resumes.
3. Announce + link `documentation/DISTRIBUTION.md` for installers.

## Rollback

- npm: `npm deprecate ai-management@0.2.0 "<reason>"` (deprecate, do not
  unpublish — unpublish has a 72h window and breaks installs).
- git: `git push origin :refs/tags/v0.2.0` then delete the GitHub release.
