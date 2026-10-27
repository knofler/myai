#!/bin/bash
set +e
# dropbox_ignore_git.sh
# -----------------------------------------------------------------------------
# FLEET POLICY (AI_RULES §12): a repo's `.git` dir must NEVER sync to Dropbox.
#
# WHY .git specifically (measured on exo, 2026-09-04):
#   - exo's .git is 13 MB / 1,911 objects / 2.58 MiB packed and `git status`
#     runs in 0.02s — yet GitLens reported single git ops taking up to 6.3s. The
#     stall is Dropbox syncing .git/objects CONCURRENTLY with git's own writes,
#     not git being slow.
#   - Same mechanism caused real data loss: 2026-07-17 Dropbox corrupted exo's
#     .git mid-session (missing blobs, `git status` fatal, two unpushed commits
#     unreadable). Recurring on Dropbox-hosted repos.
#   - Fix: `xattr -w com.dropbox.ignored 1 .git` → Dropbox stops indexing .git;
#     `git fsck` clean afterwards, status back to 0.00s.
#
# This tool makes "Dropbox never syncs .git" a rule APPLIED AND VERIFIED by a
# script, not remembered per-repo. It is READ-ONLY by default: it walks a root,
# finds every .git, and reports IGNORED vs SYNCING. `--apply` marks the SYNCING
# ones — but ONLY after passing hard safety preconditions, because marking a
# folder ignored is DESTRUCTIVE across machines (see below).
#
# ⚠️ DESTRUCTIVE / CROSS-MACHINE — READ BEFORE --apply:
#   Marking .git `com.dropbox.ignored=1` removes it from dropbox.com as a
#   sync-config change (NOT a user delete → no rewind point on Dropbox's side),
#   and therefore Dropbox will delete .git from EVERY OTHER machine that syncs
#   this folder (e.g. another Mac). Working files are unaffected — they sync
#   separately. Recovery on the other machine is a re-clone from origin, or
#   restore from the backup tarball this script can write.
#   Correct fleet rollout order:
#     1. push everything on BOTH machines (nothing lives only in a .git)
#     2. apply on machine A (this script)
#     3. on machine B: re-clone or restore .git from the tarball
#     4. apply on machine B too
#
#   Because of that, before applying to any repo we REFUSE unless the repo is
#   fully safe to lose its local-only .git state:
#     - no uncommitted changes (working tree + index clean)
#     - no unpushed commits on any branch
#     - no local branch without an upstream (its commits exist only here)
#     - no stash entries
#   ...OR a backup tarball was written OUTSIDE Dropbox first
#   (~/.git-backups/<repo>-git-<ts>.tar.gz — pass --backup to do this
#   automatically and proceed even when the repo is not clean).
#
# Idempotent (already-ignored .git is left untouched). macOS + Dropbox only;
# Linux / no-Dropbox / inside-container = silent no-op.
#
# Usage:
#   ./scripts/dropbox_ignore_git.sh                 # report every .git under the Dropbox root (READ-ONLY)
#   ./scripts/dropbox_ignore_git.sh <root>          # report under a specific root
#   ./scripts/dropbox_ignore_git.sh --apply         # mark SYNCING .git ignored (preconditions enforced)
#   ./scripts/dropbox_ignore_git.sh --apply --backup # tarball .git first, then apply even if not clean
#   ./scripts/dropbox_ignore_git.sh --check-current  # one-line WARN if THIS repo's .git syncs (agent-mode)
#   ./scripts/dropbox_ignore_git.sh --quiet          # suppress "nothing to do" chatter
# -----------------------------------------------------------------------------

APPLY=0
BACKUP=0
QUIET=0
CHECK_CURRENT=0
ROOT_ARG=""
for arg in "$@"; do
  case "$arg" in
    --apply)         APPLY=1 ;;
    --backup)        BACKUP=1 ;;
    --quiet)         QUIET=1 ;;
    --check-current) CHECK_CURRENT=1 ;;
    --*)             echo "dropbox-ignore-git: unknown flag '$arg'" >&2; exit 2 ;;
    *)               ROOT_ARG="$arg" ;;
  esac
done

BACKUP_DIR="$HOME/.git-backups"

# --- guards: macOS + host only (Dropbox runs on the host) --------------------
if [ "$(uname)" != "Darwin" ]; then
  [ "$QUIET" = "1" ] || echo "dropbox-ignore-git: skipped (not macOS)"
  exit 0
fi
if [ -f /.dockerenv ] || [ -n "$MYAI_IN_CONTAINER" ]; then
  [ "$QUIET" = "1" ] || echo "dropbox-ignore-git: skipped (inside container)"
  exit 0
fi

is_ignored() { [ "$(xattr -p com.dropbox.ignored "$1" 2>/dev/null)" = "1" ]; }
under_dropbox() { case "$1" in */Dropbox/*|*/Dropbox|*/Dropbox\ */|*/Dropbox\ *) return 0 ;; *) return 1 ;; esac }

# --- --check-current: cheap single-repo warn for `agent mode` ----------------
# Warns (exit 0 regardless) when the current repo lives under Dropbox and its
# .git is NOT ignored. Never applies anything — deliberately non-destructive so
# it is safe to run unattended at session start.
if [ "$CHECK_CURRENT" = "1" ]; then
  R=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  if ! under_dropbox "$R"; then
    [ "$QUIET" = "1" ] || echo "dropbox-ignore-git: repo not under Dropbox — nothing to check"
    exit 0
  fi
  GITDIR="$R/.git"
  if [ ! -d "$GITDIR" ]; then
    exit 0  # worktree / submodule with a .git file, not a dir — skip
  fi
  if is_ignored "$GITDIR"; then
    [ "$QUIET" = "1" ] || echo "dropbox-ignore-git: ✅ .git already Dropbox-ignored"
  else
    echo "⚠️  DROPBOX .git GUARD: this repo is under Dropbox and its .git is NOT ignored."
    echo "    Dropbox syncing .git/objects corrupts repos + stalls git ops (AI_RULES §12)."
    echo "    Fix (after pushing all work): ./scripts/dropbox_ignore_git.sh --apply"
    echo "    Cross-machine: this DELETES .git from other synced machines — re-clone/restore there."
  fi
  exit 0
fi

# --- resolve report/apply roots ----------------------------------------------
ROOTS=()
if [ -n "$ROOT_ARG" ]; then
  ROOTS+=("$ROOT_ARG")
else
  for d in "$HOME"/Dropbox*; do [ -d "$d" ] && ROOTS+=("$d"); done
fi
if [ "${#ROOTS[@]}" -eq 0 ]; then
  [ "$QUIET" = "1" ] || echo "dropbox-ignore-git: no Dropbox root found (default: the Dropbox folder in the home directory) — nothing to do"
  exit 0
fi

# --- precondition check for a single repo ------------------------------------
# echoes "" (empty) when safe to apply, or a human reason when NOT safe.
precondition_reason() {
  local repo="$1"
  # uncommitted changes (tracked + untracked)
  if [ -n "$(git -C "$repo" status --porcelain 2>/dev/null)" ]; then
    echo "uncommitted changes in working tree"; return
  fi
  # stash entries
  if [ -n "$(git -C "$repo" stash list 2>/dev/null)" ]; then
    echo "stash entries present"; return
  fi
  # every local branch must have an upstream AND be fully pushed
  local branch upstream ahead
  while IFS='|' read -r branch upstream; do
    [ -z "$branch" ] && continue
    if [ -z "$upstream" ]; then
      echo "local branch '$branch' has no upstream (its commits exist only in this .git)"; return
    fi
    ahead=$(git -C "$repo" rev-list --count "$upstream..$branch" 2>/dev/null)
    if [ -n "$ahead" ] && [ "$ahead" -gt 0 ] 2>/dev/null; then
      echo "branch '$branch' has $ahead unpushed commit(s)"; return
    fi
  done < <(git -C "$repo" for-each-ref --format='%(refname:short)|%(upstream:short)' refs/heads 2>/dev/null)
  echo ""  # safe
}

backup_git() {
  # tarball a repo's .git OUTSIDE Dropbox; echoes the tarball path on success.
  local repo="$1" name ts out
  name=$(basename "$repo")
  ts=$(date +%Y%m%d-%H%M%S)
  out="$BACKUP_DIR/${name}-git-${ts}.tar.gz"
  mkdir -p "$BACKUP_DIR" 2>/dev/null || return 1
  # -C so the archive holds ".git" not the absolute path
  if tar czf "$out" -C "$repo" .git 2>/dev/null && [ -s "$out" ]; then
    echo "$out"; return 0
  fi
  return 1
}

# --- walk + report / apply ---------------------------------------------------
IGNORED=0
SYNCING=0
APPLIED=0
SKIPPED=0
WARNED_HEADER=0

for ROOT in "${ROOTS[@]}"; do
  [ -d "$ROOT" ] || continue
  # find every .git dir; -prune so we never descend INTO a .git
  while IFS= read -r gitdir; do
    [ -d "$gitdir" ] || continue
    repo=$(dirname "$gitdir")
    if is_ignored "$gitdir"; then
      IGNORED=$((IGNORED+1))
      [ "$QUIET" = "1" ] || echo "  [ignored] $repo"
      continue
    fi
    SYNCING=$((SYNCING+1))

    if [ "$APPLY" != "1" ]; then
      echo "  [SYNCING] $repo"
      continue
    fi

    # --apply path: one-time destructive-action warning header
    if [ "$WARNED_HEADER" = "0" ]; then
      echo ""
      echo "⚠️  APPLYING com.dropbox.ignored to .git dirs is DESTRUCTIVE across machines:"
      echo "    Dropbox will DELETE .git from every OTHER machine syncing these folders"
      echo "    (e.g. another Mac). Working files are unaffected. Recover there by re-cloning"
      echo "    from origin or restoring the ~/.git-backups tarball. Ensure all machines"
      echo "    pushed first; apply here → re-clone/restore on the other → apply there."
      echo ""
      WARNED_HEADER=1
    fi

    reason=$(precondition_reason "$repo")
    if [ -n "$reason" ]; then
      if [ "$BACKUP" = "1" ]; then
        tarball=$(backup_git "$repo")
        if [ -z "$tarball" ]; then
          echo "  [SKIP]    $repo — $reason; backup FAILED, not applying"
          SKIPPED=$((SKIPPED+1)); continue
        fi
        echo "  [backup]  $repo — $reason → tarball $tarball"
      else
        echo "  [SKIP]    $repo — $reason (push it, or re-run with --backup)"
        SKIPPED=$((SKIPPED+1)); continue
      fi
    fi

    if xattr -w com.dropbox.ignored 1 "$gitdir" 2>/dev/null; then
      echo "  [applied] $repo — .git now Dropbox-ignored"
      APPLIED=$((APPLIED+1))
    else
      echo "  [SKIP]    $repo — xattr write failed"
      SKIPPED=$((SKIPPED+1))
    fi
  done < <(find "$ROOT" -type d -name .git -prune 2>/dev/null)
done

echo ""
if [ "$APPLY" = "1" ]; then
  echo "dropbox-ignore-git: $APPLIED applied, $SKIPPED skipped, $IGNORED already ignored"
else
  TOTAL=$((IGNORED+SYNCING))
  echo "dropbox-ignore-git: $TOTAL .git dir(s) — $IGNORED ignored, $SYNCING still syncing"
  if [ "$SYNCING" -gt 0 ]; then
    echo "  → to fix (after pushing all work): $0 --apply   (add --backup for repos with local-only state)"
  fi
fi
exit 0
