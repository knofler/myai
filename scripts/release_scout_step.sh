#!/usr/bin/env bash
# release_scout_step.sh — weekly check: is the published npm package
# `ai-management` behind main/test? Per agents/standing-release-scout.md.
#
# LANE: runner-driven RECURRING TASK (recurring_tasks_create), same shape as
# scripts/blog_scout_step.sh — never a gateway cron (the gateway dispatches
# MCP tools/agents in-gateway; this needs `npm`/`git` from a real checkout,
# which only the CLI runner host environment can do) and never a
# claude.ai/code cloud routine (config/cloud_routines.md: all disabled
# 2026-09-20, five-part justification required to re-add one).
#
# WHAT IT DOES, once per fire:
#   1. Resolve npm's ACTUAL published version (`npm view ai-management
#      version`) — the ground truth, not the local `v*` tag (a tag can exist
#      locally without npm ever having received it, e.g. a publish that
#      started but never finished — see scripts/publish_release.sh's own
#      "half-done release" notes).
#   2. Read package.json's current version.
#   3. release_scout_decide (pure, unit-tested) picks one of three outcomes:
#        reminder — package.json already ahead of npm (a prepare happened
#                   earlier and was never published): remind, change nothing.
#        skip     — in sync, no release-worthy commit since the published
#                   tag (scripts/release_version.py bump --from v<published>
#                   returned "none"): skip the week, one-line mail.
#        prepare  — in sync, release-worthy: scripts/release_version.py
#                   apply --from v<published> bumps package.json + prepends
#                   CHANGELOG.md, commit it to `test` (fetch+rebase first,
#                   never `main`, never a PR), then mail the operator
#                   (kind=request) with the proposed version + notes.
#   4. NEVER publishes: never calls scripts/publish_release.sh, never runs
#      `npm publish`, never tags, never opens a PR. That is a deliberate,
#      human-gated, separate step (CLAUDE.md protocol 8 / AGENT_PROTOCOLS §7).
#
#   ./scripts/release_scout_step.sh                  # check + prepare if warranted
#   ./scripts/release_scout_step.sh --dry-run        # log the decision, write/push/mail nothing
#
# ENV: GATEWAY_MCP (default http://localhost:3100/mcp), RELEASE_SCOUT_MAIL_TO
#      (default "ai_management" — a repo-shaped mailbox address; any session
#      opened in ai_management answers to it), RELEASE_SCOUT_PKG (default
#      ai-management), RELEASE_VERSION_PY (default scripts/release_version.py),
#      SCHEDULE_IGNORE_FILE (default config/schedule_ignore.txt),
#      SCHEDULE_CONSENT=1 (override if ai_management is ever added to the
#      ignore list).
#
# Pure version-diff/decision/mail-body helpers (release_scout_*) are unit
# tested by scripts/tests/test_release_scout_step.sh, which sources this file
# with RELEASE_SCOUT_LIB_ONLY=1 (same convention as blog_scout_step.sh's
# BLOG_SCOUT_LIB_ONLY) so the test suite never touches git/npm/the gateway/
# the network. The commit-classification engine itself (conventional commits
# -> semver bump, changelog rendering) is NOT re-implemented here — it's
# delegated to scripts/release_version.py, which already has its own
# hermetic suite (scripts/tests/test_release_version.sh).
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/.." && pwd)"
LIB_DIR="$SELF_DIR/lib"

. "$LIB_DIR/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

GATEWAY_MCP="${GATEWAY_MCP:-http://localhost:3100/mcp}"
RELEASE_SCOUT_MAIL_TO="${RELEASE_SCOUT_MAIL_TO:-ai_management}"
RELEASE_SCOUT_PKG="${RELEASE_SCOUT_PKG:-ai-management}"
RELEASE_SCOUT_REPO="${RELEASE_SCOUT_REPO:-ai_management}"
RELEASE_VERSION_PY="${RELEASE_VERSION_PY:-$REPO_ROOT/scripts/release_version.py}"
IGNORE_FILE="${SCHEDULE_IGNORE_FILE:-$REPO_ROOT/config/schedule_ignore.txt}"

# ── pure helpers (unit tested — no git/npm/gateway/network call in here) ───

# release_scout_ignored_repos <ignore-file> → one repo name per line
# (comments/blanks stripped). Mirrors blog_scout_step.sh's equivalent.
release_scout_ignored_repos() {
    local f="$1"
    [ -f "$f" ] || return 0
    grep -v '^[[:space:]]*#' "$f" 2>/dev/null | grep -v '^[[:space:]]*$' | sed -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//'
}

# release_scout_is_ignored_repo <repo-name> <ignore-file> → 0 (true) iff
# listed — defense in depth, in case ai_management is ever added to the
# fleet-wide no-autonomous-schedule list.
release_scout_is_ignored_repo() {
    local repo="$1" f="$2" line
    while IFS= read -r line; do
        [ -n "$line" ] && [ "$line" = "$repo" ] && return 0
    done < <(release_scout_ignored_repos "$f")
    return 1
}

# release_scout_is_release_worthy <bump> → 0 (true) iff the bump type from
# release_version.py is patch/minor/major (not "none"/empty/unrecognized).
release_scout_is_release_worthy() {
    case "$1" in
        patch|minor|major) return 0 ;;
        *) return 1 ;;
    esac
}

# release_scout_decide <npm-published-version> <package.json-version>
# <bump-type> → "reminder" | "skip" | "prepare". The version-diff decision
# at the heart of this agent:
#   - package.json already ahead of npm (an earlier prepare was never
#     published) -> "reminder", regardless of bump (never double-prepare).
#   - in sync (npm == package.json) and nothing release-worthy -> "skip".
#   - in sync and release-worthy -> "prepare".
release_scout_decide() {
    local published="$1" pkg="$2" bump="$3"
    if [ "$published" != "$pkg" ]; then
        printf 'reminder'
    elif release_scout_is_release_worthy "$bump"; then
        printf 'prepare'
    else
        printf 'skip'
    fi
}

# release_scout_semver_bump <current X.Y.Z> <bump patch|minor|major> → the
# next version string. Mirrors release_version.py's next_version() in bash
# so the dry-run preview needs neither python nor a real repo checkout.
# Authoritative mutation still goes through release_version.py apply (which
# recomputes independently) — this is for preview/decision purposes only.
release_scout_semver_bump() {
    local current="$1" bump="$2" major minor patch rest
    IFS='.' read -r major minor rest <<< "$current"
    patch="${rest%%[!0-9]*}"
    case "$major" in ''|*[!0-9]*) return 1 ;; esac
    case "$minor" in ''|*[!0-9]*) return 1 ;; esac
    case "$patch" in ''|*[!0-9]*) return 1 ;; esac
    case "$bump" in
        major) printf '%s.0.0' "$((major + 1))" ;;
        minor) printf '%s.%s.0' "$major" "$((minor + 1))" ;;
        patch) printf '%s.%s.%s' "$major" "$minor" "$((patch + 1))" ;;
        *) printf '%s' "$current" ;;
    esac
}

# release_scout_bump_reason <bump> → one-line human reason for the mail.
release_scout_bump_reason() {
    case "$1" in
        major) printf 'a breaking change (! or BREAKING CHANGE footer) landed since the last release' ;;
        minor) printf 'new feat commit(s) landed since the last release, no breaking change' ;;
        patch) printf 'fix/perf commit(s) landed since the last release, no new features' ;;
        *)     printf 'nothing release-worthy (chore/docs/test/refactor/ci/style only)' ;;
    esac
}

# release_scout_prepare_mail_subject <next-version> → the operator-facing
# subject line the task spec asks for verbatim: "release vX.Y.Z ready — run
# publish_release.sh".
release_scout_prepare_mail_subject() {
    printf 'release v%s ready — run publish_release.sh' "$1"
}

# release_scout_prepare_mail_body <next-version> <bump> <reason> <notes> →
# the full "release prepared" mail body (kind=request).
release_scout_prepare_mail_body() {
    local next="$1" bump="$2" reason="$3" notes="$4"
    printf 'Release v%s ready — operator action required.\nBump: %s (%s)\nCHANGELOG.md updated (test branch), package.json bumped to %s.\nContents:\n%s\nNext: review, then on main after merge:\n  scripts/publish_release.sh --interactive-otp\nThis never runs automatically — publishing is a human decision.' \
        "$next" "$bump" "$reason" "$next" "$notes"
}

# release_scout_skip_mail_body <published-version> <since-tag> <commit-count>
# → the "nothing release-worthy" mail body. States the fact, no filler.
release_scout_skip_mail_body() {
    local published="$1" since="$2" commits="$3"
    printf 'Release scout — nothing release-worthy since %s (npm %s is current)\nSwept: %s commit(s) on main since %s — all routine/chore/docs/refactor-without-substance.\nNo release prepared.' \
        "$since" "$published" "$commits" "$since"
}

# release_scout_reminder_mail_body <package.json-version> <npm-published-
# version> → the "already prepared, still unpublished" reminder body.
release_scout_reminder_mail_body() {
    local pkg="$1" published="$2"
    printf 'Release scout reminder — v%s is already prepared (package.json) but npm still serves v%s.\nA release is waiting on the operator: run scripts/publish_release.sh --interactive-otp after merging to main.\nNo new changes prepared this run.' \
        "$pkg" "$published"
}

# ── unit-test hook — stop here before any git/npm/gateway/network call ──────
if [ "${RELEASE_SCOUT_LIB_ONLY:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

# ── impure driver (network/git/npm — not unit tested; follows blog_scout_step.sh's pattern) ──

mcp() { # mcp <tool> <json-args>
    local body raw
    body="{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
    raw="$(curl -sf -m 20 -X POST "$GATEWAY_MCP" -H 'content-type: application/json' \
        -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" -d "$body" 2>/dev/null || true)"
    [ -n "$raw" ] || return 1
    printf '%s' "$raw" | /usr/bin/python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["content"][0]["text"])' 2>/dev/null
}

log() { echo "[release-scout $(date -u +%H:%M:%S)Z] $*"; }

send_mail() { # <kind> <full-text — first line is the subject, rest is the body>
    local kind="$1" full="$2" subject body
    subject="${full%%$'\n'*}"
    body="${full#*$'\n'}"
    [ "$body" = "$full" ] && body=""
    mcp mail_send "$(/usr/bin/python3 -c '
import json, sys
print(json.dumps({"to": sys.argv[1], "from": "release-scout", "subject": sys.argv[2], "body": sys.argv[3], "kind": sys.argv[4]}))' \
        "$RELEASE_SCOUT_MAIL_TO" "$subject" "$body" "$kind")" >/dev/null 2>&1 \
        || log "WARN: mail_send failed (gateway unreachable?) — summary stays in this log only."
}

DRY_RUN=false
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=true ;;
        -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
    esac
    shift
done

if release_scout_is_ignored_repo "$RELEASE_SCOUT_REPO" "$IGNORE_FILE" && [ "${SCHEDULE_CONSENT:-0}" != "1" ]; then
    log "ERROR: $RELEASE_SCOUT_REPO is in $IGNORE_FILE — refusing to run without explicit consent (SCHEDULE_CONSENT=1)."
    exit 1
fi

command -v npm >/dev/null 2>&1 || { log "ERROR: npm not found — cannot query the registry."; exit 1; }
command -v python3 >/dev/null 2>&1 || { log "ERROR: python3 not found — required by release_version.py."; exit 1; }
[ -f "$RELEASE_VERSION_PY" ] || { log "ERROR: $RELEASE_VERSION_PY not found."; exit 1; }

cd "$REPO_ROOT" || exit 1

PUBLISHED="$(npm view "$RELEASE_SCOUT_PKG" version 2>/dev/null || true)"
if [ -z "$PUBLISHED" ]; then
    log "ERROR: could not resolve the npm-published version for $RELEASE_SCOUT_PKG (registry unreachable?) — skipping this run, nothing mailed."
    exit 1
fi

PKG_VERSION="$(python3 "$RELEASE_VERSION_PY" --repo-root "$REPO_ROOT" current 2>/dev/null || true)"
[ -n "$PKG_VERSION" ] || { log "ERROR: could not read package.json version."; exit 1; }

log "npm published: $PUBLISHED, package.json: $PKG_VERSION"

git fetch origin --tags >/dev/null 2>&1 || true

TAG="v$PUBLISHED"
BUMP_FROM_FLAGS=(--from "$TAG")
LOG_RANGE="$TAG..HEAD"
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
    log "WARN: tag $TAG not found locally — falling back to the latest reachable v* tag for the commit range."
    BUMP_FROM_FLAGS=()
    LOG_RANGE="HEAD"
fi

BUMP="$(python3 "$RELEASE_VERSION_PY" --repo-root "$REPO_ROOT" bump ${BUMP_FROM_FLAGS[@]+"${BUMP_FROM_FLAGS[@]}"} 2>/dev/null || echo none)"
DECISION="$(release_scout_decide "$PUBLISHED" "$PKG_VERSION" "$BUMP")"
log "decision: $DECISION (bump=$BUMP)"

case "$DECISION" in
  reminder)
    MAIL="$(release_scout_reminder_mail_body "$PKG_VERSION" "$PUBLISHED")"
    SUBJECT="Release scout reminder — v$PKG_VERSION still unpublished"
    if $DRY_RUN; then
        log "DRY-RUN — would mail reminder: $SUBJECT"
        printf '%s\n' "$MAIL" | sed 's/^/    /'
        exit 0
    fi
    send_mail note "$SUBJECT
$MAIL"
    log "done — reminder sent, nothing changed."
    ;;
  skip)
    N_COMMITS="$(git log --no-merges --oneline "$LOG_RANGE" 2>/dev/null | grep -c . || true)"
    case "$N_COMMITS" in ''|*[!0-9]*) N_COMMITS=0 ;; esac
    MAIL="$(release_scout_skip_mail_body "$PUBLISHED" "$TAG" "$N_COMMITS")"
    SUBJECT="Release scout — nothing release-worthy since $TAG"
    if $DRY_RUN; then
        log "DRY-RUN — would mail skip: $SUBJECT"
        printf '%s\n' "$MAIL" | sed 's/^/    /'
        exit 0
    fi
    send_mail note "$SUBJECT
$MAIL"
    log "done — skipped, nothing release-worthy."
    ;;
  prepare)
    REASON="$(release_scout_bump_reason "$BUMP")"
    NOTES="$(python3 "$RELEASE_VERSION_PY" --repo-root "$REPO_ROOT" notes ${BUMP_FROM_FLAGS[@]+"${BUMP_FROM_FLAGS[@]}"} 2>/dev/null || true)"
    PREVIEW_NEXT="$(release_scout_semver_bump "$PUBLISHED" "$BUMP")"
    log "preparing $BUMP release: $PUBLISHED -> $PREVIEW_NEXT"

    if $DRY_RUN; then
        log "DRY-RUN — would bump package.json/CHANGELOG.md to $PREVIEW_NEXT and mail the operator:"
        printf '%s\n%s\n' "$(release_scout_prepare_mail_subject "$PREVIEW_NEXT")" \
            "$(release_scout_prepare_mail_body "$PREVIEW_NEXT" "$BUMP" "$REASON" "$NOTES")" | sed 's/^/    /'
        exit 0
    fi

    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
        log "ERROR: working tree is dirty — refusing to prepare a release on top of uncommitted changes."
        exit 1
    fi

    NEW_VERSION="$(python3 "$RELEASE_VERSION_PY" --repo-root "$REPO_ROOT" apply ${BUMP_FROM_FLAGS[@]+"${BUMP_FROM_FLAGS[@]}"} 2>/dev/null)"
    RC=$?
    if [ "$RC" != 0 ] || [ -z "$NEW_VERSION" ]; then
        log "ERROR: release_version.py apply failed (rc=$RC) — nothing committed."
        git checkout -- package.json CHANGELOG.md 2>/dev/null
        exit 1
    fi

    git add package.json CHANGELOG.md
    git commit -q -m "chore(release): prepare v$NEW_VERSION

Autonomous weekly sweep (standing-release-scout). Bump: $BUMP ($REASON).
Never published automatically — operator runs
scripts/publish_release.sh --interactive-otp after merging test to main."

    git fetch origin test >/dev/null 2>&1 && git rebase origin/test >/dev/null 2>&1
    if ! git push origin HEAD:test >/dev/null 2>&1; then
        log "WARN: push to origin test failed — release commit is local only, needs manual push."
    fi

    send_mail request "$(release_scout_prepare_mail_subject "$NEW_VERSION")
$(release_scout_prepare_mail_body "$NEW_VERSION" "$BUMP" "$REASON" "$NOTES")"
    log "done — prepared v$NEW_VERSION, mailed $RELEASE_SCOUT_MAIL_TO."
    ;;
esac
exit 0
