#!/bin/bash
set +e
# restore_git_metadata.sh
# -----------------------------------------------------------------------------
# Re-attach a Dropbox-synced working tree to its GitHub remote after its `.git`
# directory has gone missing — WITHOUT touching a single working-tree file.
#
# WHY THIS EXISTS (incident 2026-08-27, runner-host)
# ---------------------------------------------------------
# Fleet policy marks every repo's `.git` with `com.dropbox.ignored` so Dropbox
# stops corrupting it with conflicted-copy ref files. On the machine that SETS
# the flag the folder stays on local disk. On EVERY OTHER machine Dropbox drops
# the server copy and the local `.git` goes with it — so a Mac that was away
# during the sweep comes back with 20+ intact working trees and zero git.
#
# THERE IS NOTHING TO RESTORE FROM DROPBOX. Verified 2026-08-27 against the live
# account: no `.git` under any managed repo, and a deleted-file search for
# `packed-refs` across `_MY_PROJECT` returns ZERO. Dropbox treats an ignore-flag
# purge as a sync-config change, not a user delete, so it leaves no rewind
# point. (Dropbox still holds `.git` for OLD, never-swept repos — the kind of
# legacy project that predates the sweep — which is how we know the search works.)
# The remote is the only source of truth, and that is fine: the working tree is
# the part Dropbox actually preserved.
#
# SAFETY — the whole design goal is "never lose an uncommitted local edit":
#   * `git init` + `fetch` + `update-ref` + `reset --mixed`. NEVER `checkout`,
#     never `reset --hard`, never `clean`. `--mixed` rebuilds the INDEX from the
#     fetched commit and leaves every file on disk exactly as it was, so any
#     local drift from this machine's last session shows up as a normal
#     modification for you to review instead of being silently overwritten.
#   * Refuses to run where `.git` already exists (no clobbering a live repo).
#   * DRY-RUN BY DEFAULT. `--apply` is required to write anything.
#
# REMOTE RESOLUTION is explicit-only, never fuzzy. A wrong remote here would
# reset a repo's index against someone else's history, so guessing is banned:
#   1. `--remote <url>` for a single target
#   2. `config/repo_remotes.txt`  ("<folder-name> <owner/repo>" per line)
#   3. `gh repo view knofler/<folder-name>` — only on an EXACT name match
#   Anything unresolved is SKIPPED and listed at the end.
# DO NOT add package.json `repository.url` as a source: on this master repo it
# points at `knofler/myai`, the scrubbed PUBLIC MIRROR, not the private repo.
#
# Usage:
#   ./scripts/restore_git_metadata.sh                      # dry-run, current repo
#   ./scripts/restore_git_metadata.sh --apply              # fix current repo
#   ./scripts/restore_git_metadata.sh --apply --remote knofler/ai_management .
#   ./scripts/restore_git_metadata.sh --fleet               # dry-run whole fleet
#   ./scripts/restore_git_metadata.sh --fleet --apply       # fix whole fleet
# -----------------------------------------------------------------------------

OWNER_DEFAULT="knofler"
# orgs are also searched for exact name matches (POWERHOUSE repos live in them).
# LAZY on purpose: resolved on first actual need inside resolve_remote(), not
# unconditionally at startup. `gh api user/orgs` is a real network round-trip
# (~0.5s) — firing it on every invocation, even a fully-healthy --fleet
# dry-run where no repo ever reaches org lookup, is exactly the "measurable
# boot latency when healthy" regression the MACHINE ARRIVAL preflight
# (hooks/session/26-git-fleet-preflight.sh) depends on NOT happening.
OWNER_ORGS_RESOLVED=0
OWNER_ORGS=""
owner_orgs() {
  if [ "$OWNER_ORGS_RESOLVED" != "1" ]; then
    # --paginate: user/orgs pages at 30; a member of >30 orgs must resolve them
    # all, or an exact repo-owner match could sit on an unfetched page.
    OWNER_ORGS="${MYAI_GIT_ORGS:-$(gh api --paginate user/orgs --jq '.[].login' 2>/dev/null | tr '\n' ' ')}"
    OWNER_ORGS_RESOLVED=1
  fi
  printf '%s' "$OWNER_ORGS"
}
APPLY=0
FLEET=0
REMOTE_OVERRIDE=""
TARGETS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)  APPLY=1 ;;
    --fleet)  FLEET=1 ;;
    --remote) REMOTE_OVERRIDE="$2"; shift ;;
    -h|--help) sed -n '1,60p' "$0"; exit 0 ;;
    *)        TARGETS+=("$1") ;;
  esac
  shift
done

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/.." && pwd)"
MAP_FILE="$REPO_ROOT/config/repo_remotes.txt"

say()  { echo "$@"; }
step() { echo "  → $@"; }

# ── resolve the GitHub remote for a working-tree dir ────────────────────────
resolve_remote() {
  local dir="$1" name
  name="$(basename "$dir")"

  if [ -n "$REMOTE_OVERRIDE" ]; then echo "$REMOTE_OVERRIDE"; return 0; fi

  if [ -f "$MAP_FILE" ]; then
    local mapped
    mapped=$(awk -v n="$name" '$1==n && $0 !~ /^#/ {print $2; exit}' "$MAP_FILE")
    if [ -n "$mapped" ]; then echo "$mapped"; return 0; fi
  fi

  # EXACT name match across the user's own account AND their orgs. Never fuzzy:
  # a near-miss here resets a repo's index against unrelated history. If two
  # owners both have the name we cannot tell which, so we REFUSE rather than
  # pick — that ambiguity is what config/repo_remotes.txt is for.
  if command -v gh >/dev/null 2>&1; then
    local hits="" owner
    for owner in "$OWNER_DEFAULT" $(owner_orgs); do
      gh repo view "$owner/$name" --json name >/dev/null 2>&1 && hits="$hits $owner/$name"
    done
    set -- $hits
    if [ "$#" -eq 1 ]; then echo "$1"; return 0; fi
    if [ "$#" -gt 1 ]; then echo "AMBIGUOUS:$hits"; return 0; fi
  fi

  return 1
}

to_url() {
  case "$1" in
    git@*|ssh://*|https://*) echo "$1" ;;
    *) echo "git@github.com:$1.git" ;;
  esac
}

SKIPPED=()
FIXED=()

restore_one() {
  local dir="$1"
  dir="$(cd "$dir" 2>/dev/null && pwd)" || { SKIPPED+=("$1 (no such dir)"); return; }
  local name; name="$(basename "$dir")"

  say ""
  say "── $name  ($dir)"

  if [ -e "$dir/.git" ]; then
    step "SKIP — .git already present (never clobber a live repo)"
    SKIPPED+=("$name (.git present)")
    return
  fi

  # CONTAINER FOLDER — a workspace directory that is not itself a repo but
  # holds repos as its immediate children. A `services/` dir is the classic
  # example: it has no .git of its own and never will, but it contains child
  # repos like `svc-api` and `svc-web`, both already attached and both tracked in the fleet
  # in their own right. Without this check it falls through to the remote
  # resolver, fails (correctly — there IS no remote for a container), and is
  # reported as "no .git, remote unresolved" at EVERY boot. That is a false
  # positive of exactly the kind LL/2026-08-28 records for the TNEW-OPS
  # Vercel-gate guard: a guard that cries wolf every session gets ignored,
  # and then the real signal is missed too. Classify it and move on.
  local _kids=0 _kid
  for _kid in "$dir"/*/; do
    [ -e "$_kid/.git" ] && _kids=$((_kids + 1))
  done
  if [ "$_kids" -gt 0 ]; then
    step "SKIP — container of $_kids attached repo(s); not a repo itself"
    SKIPPED+=("$name (container of $_kids repos)")
    return
  fi

  local slug url
  slug="$(resolve_remote "$dir")"
  case "$slug" in AMBIGUOUS:*) AMBIGUOUS="${slug#AMBIGUOUS:}"; slug="" ;; *) AMBIGUOUS="" ;; esac
  if [ -z "$slug" ]; then
    if [ -n "$AMBIGUOUS" ]; then
      step "SKIP — AMBIGUOUS, name exists in several owners:$AMBIGUOUS"
    else
      step "SKIP — cannot resolve remote. Add a line to config/repo_remotes.txt:"
      step "        $name  $OWNER_DEFAULT/<repo>"
    fi
    SKIPPED+=("$name (unresolved remote)")
    return
  fi
  url="$(to_url "$slug")"
  step "remote: $slug"

  local tracked; tracked=$(find "$dir" -maxdepth 1 -mindepth 1 | wc -l | tr -d ' ')
  step "working tree: $tracked top-level entries (will NOT be modified)"

  if [ "$APPLY" != "1" ]; then
    step "DRY-RUN — would: git init → remote add → fetch → reset --mixed → dropbox-ignore .git"
    return
  fi

  git init -q "$dir" || { step "FAIL — git init"; SKIPPED+=("$name (init failed)"); return; }
  git -C "$dir" remote add origin "$url" 2>/dev/null

  step "fetching…"
  if ! git -C "$dir" fetch -q --prune origin 2>&1 | tail -3; then :; fi
  if ! git -C "$dir" rev-parse --verify -q refs/remotes/origin/HEAD >/dev/null 2>&1; then
    git -C "$dir" remote set-head origin -a >/dev/null 2>&1
  fi

  # default branch, from the remote itself
  local def
  def=$(git -C "$dir" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
  [ -z "$def" ] && def=$(git -C "$dir" branch -r 2>/dev/null | sed -n 's|^ *origin/\(main\|master\)$|\1|p' | head -1)
  if [ -z "$def" ]; then
    step "FAIL — fetched no branches (auth? empty repo?). Leaving .git in place for inspection."
    SKIPPED+=("$name (no branches fetched)")
    return
  fi
  step "default branch: $def"

  # born the local branch AT the remote tip, point HEAD at it, then rebuild the
  # index only. Working tree is never written.
  git -C "$dir" update-ref "refs/heads/$def" "refs/remotes/origin/$def" || {
    step "FAIL — update-ref"; SKIPPED+=("$name (update-ref failed)"); return; }
  git -C "$dir" symbolic-ref HEAD "refs/heads/$def"
  git -C "$dir" branch --set-upstream-to="origin/$def" "$def" >/dev/null 2>&1
  git -C "$dir" reset -q --mixed HEAD || { step "FAIL — reset --mixed"; SKIPPED+=("$name (reset failed)"); return; }

  # keep Dropbox out of .git immediately — otherwise we have re-created exactly
  # the conflicted-copy corruption the ignore policy exists to prevent.
  case "$dir" in
    */Dropbox*)
      xattr -w com.dropbox.ignored 1 "$dir/.git" 2>/dev/null \
        && step "dropbox-ignore set on .git" \
        || step "WARN — could not set com.dropbox.ignored on .git"
      ;;
  esac

  [ -x "$REPO_ROOT/scripts/install_git_hooks.sh" ] && \
    "$REPO_ROOT/scripts/install_git_hooks.sh" "$dir" >/dev/null 2>&1 && step "git hooks installed"

  local head dirty
  head=$(git -C "$dir" log --oneline -1 2>/dev/null)
  local porcelain deleted untracked modified tracked
  porcelain=$(git -C "$dir" status --porcelain 2>/dev/null)
  dirty=$(printf '%s\n' "$porcelain" | grep -c . )
  deleted=$(printf '%s\n' "$porcelain" | grep -c '^ *D')
  untracked=$(printf '%s\n' "$porcelain" | grep -c '^??')
  modified=$(printf '%s\n' "$porcelain" | grep -c '^ *M')
  tracked=$(git -C "$dir" ls-files 2>/dev/null | grep -c . )
  step "HEAD: $head"
  step "drift vs $def: ${modified} modified, ${untracked} untracked, ${deleted} DELETED (of $tracked tracked)"

  # A correct remote leaves few or no DELETIONS: the working tree Dropbox
  # preserved should contain what the branch tracks. Mass deletions mean the
  # index was rebuilt against the WRONG history — which is exactly how a
  # container path like `legacy-project/2025` once fuzzy-matched an OLDER repo
  # of the same base name instead of the intended `legacy-project-25`. Nothing
  # is lost (--mixed never writes files), but the
  # repo must NOT be committed from until the remote is corrected.
  if [ "$deleted" -gt 50 ] && [ "$tracked" -gt 0 ] && [ "$((deleted * 100 / tracked))" -gt 30 ]; then
    step "*** PROBABLE WRONG REMOTE — ${deleted}/${tracked} tracked files absent from disk."
    step "*** Working tree untouched. Fix: rm -rf '$dir/.git' then re-run with"
    step "***   --remote <owner/correct-repo> '$dir'"
    SKIPPED+=("$name (WRONG REMOTE? $slug — ${deleted}/${tracked} deleted)")
    return
  fi
  FIXED+=("$name ($def, ${modified}M/${untracked}??/${deleted}D)")
}

# ── target selection ────────────────────────────────────────────────────────
if [ "$FLEET" = "1" ]; then
  ROSTER="$REPO_ROOT/config/managed_repos.txt"
  if [ -f "$ROSTER" ]; then
    while IFS= read -r line; do
      case "$line" in ''|'#'*) continue ;; esac
      TARGETS+=("$(eval echo "$line")")
    done < "$ROSTER"
  fi
  TARGETS+=("$REPO_ROOT")
elif [ "${#TARGETS[@]}" -eq 0 ]; then
  TARGETS=("$REPO_ROOT")
fi

say "restore_git_metadata — $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN) — ${#TARGETS[@]} target(s)"
for t in "${TARGETS[@]}"; do restore_one "$t"; done

say ""
say "════════════════════════════════════════════════"
say "restored: ${#FIXED[@]}"
for f in "${FIXED[@]}"; do say "  ✓ $f"; done
say "skipped:  ${#SKIPPED[@]}"
for s in "${SKIPPED[@]}"; do say "  · $s"; done
[ "$APPLY" != "1" ] && say "" && say "DRY-RUN only — re-run with --apply to write."
exit 0
