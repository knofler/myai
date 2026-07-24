#!/usr/bin/env bash
# myai_release.sh — one-command release cut (`myai release [patch|minor|major]`).
#
# Consolidates the manual runbook in documentation/RELEASE.md into a single,
# repeatable, two-phase tool built on the pieces the repo already has:
#   scripts/release_version.py  — conventional-commits → semver + changelog
#   scripts/publish_guard.sh    — clean-room npm-pack leak scanner
#   scripts/tests/run_all.sh    — shell unit suite
#
# ── CUT phase (default) ──────────────────────────────────────────────────────
#   myai release [patch|minor|major]
#     1. bump    — package.json version (auto-detected from Conventional
#                  Commits since the last v* tag, or forced via the argument)
#     2. changelog — CHANGELOG.md section generated + prepended
#     3. validate — clean-room build: shell unit suite + publish_guard.sh leak
#                  scan + a genuine Docker install/smoke check (packs the real
#                  tarball, installs it in a throwaway node container, runs
#                  `myai --version`). ANY failure auto-reverts the bump — the
#                  working tree is never left half-applied.
#     4. commit  — `chore(release): vX.Y.Z` (local commit only; ship it through
#                  the normal test → main PR flow like any other change)
#   Runs on whatever branch you're on (typically `test`) — it does not push,
#   and it does not require `main`, matching the existing ship-it flow.
#
# ── TAG phase ─────────────────────────────────────────────────────────────────
#   myai release --tag
#     Run AFTER the cut's commit has landed on `main` (i.e. after `ship it`
#     merges the PR). Tags the CURRENT package.json version and pushes the tag
#     (never the branch — a tag push is not a `main` push and the safety hook
#     does not block it). Prints the follow-up `gh release create` command,
#     which is the deliberate human/CI gate that triggers the npm publish.
#
# Flags (both phases)
#   --release-as <patch|minor|major>  same as the positional bump argument
#   --dry-run          print the plan only; mutate nothing
#   --skip-tests       skip the shell unit suite
#   --skip-guard       skip the clean-room publish_guard.sh leak scan
#   --skip-docker      skip the Docker install/smoke clean-room check
#   --no-commit        (cut) apply the bump + validate, but leave it uncommitted
#   --no-push          (tag) create the tag locally only, don't push
#   --allow-branch <b> override the "must be on main" guard for --tag (testing only)
#   --json             machine-readable result on stdout
#   -h, --help
#
# Env
#   MYAI_RELEASE_NODE_IMAGE   Docker image for the clean-room install check
#                             (default: node:20-alpine)
#   MYAI_RELEASE_ROOT         target repo root (default: this script's parent
#                             dir). Override lets the hermetic test suite point
#                             the bump/commit/tag machinery at a scratch fixture
#                             repo without ever touching the real checkout —
#                             release_version.py/publish_guard.sh are still
#                             resolved from THIS install (sibling of $0).
#
# Exit codes: 0 ok · 1 validation/build failure (reverted) · 2 usage/precondition
#             error · 3 nothing release-worthy (no-op, mirrors release_version.py)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${MYAI_RELEASE_ROOT:-$(cd "$HERE/.." && pwd)}"
REL="$HERE/release_version.py"
NODE_IMAGE="${MYAI_RELEASE_NODE_IMAGE:-node:20-alpine}"

cd "$ROOT"

usage() { sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; }

TAG_PHASE=0
BUMP=""
DRY_RUN=0
SKIP_TESTS=0
SKIP_GUARD=0
SKIP_DOCKER=0
NO_COMMIT=0
NO_PUSH=0
ALLOW_BRANCH=""
JSON=0

while [ $# -gt 0 ]; do
  case "$1" in
    patch|minor|major) BUMP="$1" ;;
    --release-as) shift; BUMP="${1:?--release-as needs patch|minor|major}" ;;
    --tag) TAG_PHASE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --skip-guard) SKIP_GUARD=1 ;;
    --skip-docker) SKIP_DOCKER=1 ;;
    --no-commit) NO_COMMIT=1 ;;
    --no-push) NO_PUSH=1 ;;
    --allow-branch) shift; ALLOW_BRANCH="${1:?--allow-branch needs a branch name}" ;;
    --json) JSON=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "myai release: unknown flag $1" >&2; usage >&2; exit 2 ;;
    *) echo "myai release: unexpected argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { [ "$JSON" = "1" ] || echo "$@"; }
err() { echo "✗ myai release: $*" >&2; }
relver() { python3 "$REL" --repo-root "$ROOT" "$@"; }

emit_json() { # emit_json <ok:0|1> <phase> <version> <message>
  printf '{"ok":%s,"phase":"%s","version":"%s","message":"%s"}\n' \
    "$([ "$1" = "0" ] && echo true || echo false)" "$2" "$3" "$4"
}

if [ ! -f package.json ] || [ ! -f "$REL" ]; then
  err "not an ai-management checkout (missing package.json or $REL)"
  exit 2
fi

command -v python3 >/dev/null 2>&1 || { err "python3 not found — required by release_version.py"; exit 2; }
command -v git >/dev/null 2>&1 || { err "git not found"; exit 2; }

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  err "working tree is dirty — commit or stash before releasing"
  exit 2
fi

# ── TAG phase — cut a tag for the version already bumped+merged to main ─────
if [ "$TAG_PHASE" = "1" ]; then
  if [ "$BRANCH" != "main" ] && [ "$BRANCH" != "$ALLOW_BRANCH" ]; then
    err "--tag must run on 'main' (currently on '$BRANCH'). Merge the release commit first, or pass --allow-branch $BRANCH for testing."
    exit 2
  fi
  VERSION="$(relver current)"
  TAG="v$VERSION"
  # Tags are always v<package.json version>, so "tag already exists" and
  # "nothing new since the last release" are the same state — an idempotent
  # no-op (this version was already cut), not a usage error.
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
    say "Nothing to tag — $TAG already exists (this version was already released)."
    [ "$JSON" = "1" ] && emit_json 1 tag "$VERSION" "already-tagged"
    exit 3
  fi

  if [ "$DRY_RUN" = "1" ]; then
    say "DRY RUN — would tag $TAG at $(git rev-parse --short HEAD) and $([ "$NO_PUSH" = 1 ] && echo 'NOT push' || echo 'push to origin')."
    [ "$JSON" = "1" ] && emit_json 0 tag "$VERSION" "dry-run"
    exit 0
  fi

  # Pull this version's CHANGELOG section into the annotated tag message.
  NOTES="$(awk -v v="$VERSION" '
    $0 ~ "^## \\[" v "\\]" {f=1; next}
    f && /^## \[/ {exit}
    f {print}
  ' CHANGELOG.md 2>/dev/null | sed '/^\s*$/d')"
  MSG="myai $VERSION"
  [ -n "$NOTES" ] && MSG="$(printf '%s\n\n%s' "$MSG" "$NOTES")"

  git tag -a "$TAG" -m "$MSG"
  say "✓ tagged $TAG"

  if [ "$NO_PUSH" = "1" ]; then
    say "  (--no-push: tag created locally only)"
  else
    if git push origin "$TAG"; then
      say "✓ pushed $TAG to origin"
    else
      err "tag created locally but 'git push origin $TAG' failed — push it manually"
      [ "$JSON" = "1" ] && emit_json 1 tag "$VERSION" "push-failed"
      exit 1
    fi
  fi

  say ""
  say "Next: gh release create $TAG --generate-notes   (triggers the npm PUBLISH job)"
  [ "$JSON" = "1" ] && emit_json 0 tag "$VERSION" "tagged"
  exit 0
fi

# ── CUT phase — bump + changelog + clean-room validation + local commit ─────
BUMP_FLAGS=()
[ -n "$BUMP" ] && BUMP_FLAGS=(--release-as "$BUMP")
# bash 3.2 (macOS default) throws "unbound variable" on "${arr[@]}" when the
# array is empty under `set -u`; the ${arr[@]+"${arr[@]}"} idiom expands to
# nothing when unset and to the quoted elements otherwise.
WHAT="$(relver bump ${BUMP_FLAGS[@]+"${BUMP_FLAGS[@]}"})"; RC=$?
if [ "$RC" = 3 ]; then
  say "No release-worthy commits since the last tag (feat/fix/perf/breaking) — nothing to release."
  [ "$JSON" = "1" ] && emit_json 1 cut "$(relver current)" "no-op"
  exit 3
elif [ "$RC" != 0 ]; then
  err "release_version.py bump failed"
  exit 2
fi

CURRENT="$(relver current)"
NEXT="$(relver next ${BUMP_FLAGS[@]+"${BUMP_FLAGS[@]}"})"

if [ "$DRY_RUN" = "1" ]; then
  say "DRY RUN — $CURRENT → $NEXT ($WHAT bump). Nothing changed."
  say ""
  say "Changelog notes:"
  relver notes ${BUMP_FLAGS[@]+"${BUMP_FLAGS[@]}"}
  [ "$JSON" = "1" ] && emit_json 0 cut "$NEXT" "dry-run"
  exit 0
fi

say "Cutting $WHAT release: $CURRENT → $NEXT"

if ! relver apply ${BUMP_FLAGS[@]+"${BUMP_FLAGS[@]}"} >/dev/null; then
  err "release_version.py apply failed"
  exit 2
fi
say "✓ package.json + CHANGELOG.md updated"

revert() { git checkout -- package.json CHANGELOG.md 2>/dev/null; }

if [ "$SKIP_GUARD" != "1" ]; then
  say "→ clean-room publish guard…"
  if ! bash "$HERE/publish_guard.sh" --quiet; then
    err "clean-room publish guard failed — reverting bump"
    revert
    exit 1
  fi
  say "✓ publish guard passed"
fi

if [ "$SKIP_TESTS" != "1" ]; then
  say "→ shell unit suite…"
  if ! bash "$HERE/tests/run_all.sh" >/tmp/myai-release-tests.log 2>&1; then
    err "shell unit suite failed (see /tmp/myai-release-tests.log) — reverting bump"
    revert
    exit 1
  fi
  say "✓ shell unit suite passed"
fi

if [ "$SKIP_DOCKER" != "1" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    say "⚠ docker not found — skipping Docker clean-room install check"
  else
    say "→ Docker clean-room install check ($NODE_IMAGE)…"
    PACK_DIR="$(mktemp -d -t myai-release-pack.XXXXXX)"
    TARBALL="$(env -u npm_config_dry_run npm pack --pack-destination "$PACK_DIR" 2>/tmp/myai-release-pack.log | tail -1)"
    if [ -z "$TARBALL" ] || [ ! -f "$PACK_DIR/$TARBALL" ]; then
      err "'npm pack' failed for the Docker check (see /tmp/myai-release-pack.log) — reverting bump"
      rm -rf "$PACK_DIR"
      revert
      exit 1
    fi
    if docker run --rm -v "$PACK_DIR:/pkg:ro" "$NODE_IMAGE" \
        sh -c "npm install -g /pkg/$TARBALL >/tmp/install.log 2>&1 && myai --version" \
        >/tmp/myai-release-docker.log 2>&1; then
      say "✓ Docker clean-room install check passed ($(tail -1 /tmp/myai-release-docker.log))"
    else
      err "Docker clean-room install check failed (see /tmp/myai-release-docker.log) — reverting bump"
      rm -rf "$PACK_DIR"
      revert
      exit 1
    fi
    rm -rf "$PACK_DIR"
  fi
fi

if [ "$NO_COMMIT" = "1" ]; then
  say ""
  say "✓ $NEXT ready — bump left uncommitted (--no-commit). Review with 'git diff', then commit."
  [ "$JSON" = "1" ] && emit_json 0 cut "$NEXT" "applied-uncommitted"
  exit 0
fi

git add package.json CHANGELOG.md
git commit -q -m "chore(release): v$NEXT"
say ""
say "✓ committed chore(release): v$NEXT on '$BRANCH'"
say ""
say "Next: ship it   (test → main PR)"
say "      then on main: myai release --tag"
[ "$JSON" = "1" ] && emit_json 0 cut "$NEXT" "committed"
exit 0
