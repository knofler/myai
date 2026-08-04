#!/usr/bin/env bash
# runner_worktree.sh — sourceable helper: per-task `git worktree` isolation for
# the off-hours runner (GRAND_PRODUCT_ROADMAP §3.3 execution-isolation, risk #3).
#
# Two tenant tasks (or two concurrent slots) touching the SAME repo must never
# share a working tree — one task's uncommitted state, checked-out branch, or
# build artifacts must not leak into another's. `git worktree` gives each task
# its own checkout (own index, own working files) that shares the repo's object
# store with the base clone, so it's cheap — no full re-clone per task.
#
# Every worktree gets a branch name unique to (tenant, taskId), so concurrent
# worktrees on the same repo never collide on "which branch is checked out
# where" (git refuses to check out a branch already checked out elsewhere).
#
# bash 3.2-safe — no associative arrays, no mapfile.

# wt_sanitize <string> — a single branch/path SEGMENT: keep [A-Za-z0-9_-],
# everything else becomes '-'. Used on tenant ids, repo names, and task ids
# before they land in a path or ref name (all may contain arbitrary characters
# from the queue/registry). '.' and '/' are deliberately EXCLUDED from the safe
# set: a crafted tenant id like '../../etc' would otherwise survive verbatim
# and traverse OUT of the worktree root in wt_dir — whose result wt_create
# feeds to `rm -rf`. Separators belong to the fixed templates below only,
# never to the input.
wt_sanitize() { printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '-'; }

# wt_branch_name <tenantId> <taskId> — the unique local branch a task's
# worktree is checked out on. Never collides across tenants or tasks, so N
# concurrent worktrees on one repo can each hold a different branch.
wt_branch_name() {
    printf 'runner/%s/%s' "$(wt_sanitize "${1:-default}")" "$(wt_sanitize "$2")"
}

# wt_dir <ws_root> <repo> <tenantId> <taskId> — the worktree's checkout path,
# namespaced by tenant so two tenants' concurrent tasks on the same repo never
# share a directory even if task ids ever collided across tenants.
wt_dir() {
    printf '%s/.worktrees/%s/%s-%s' "$1" "$(wt_sanitize "${3:-default}")" "$(wt_sanitize "$2")" "$(wt_sanitize "$4")"
}

# wt_path_tenant <worktree_dir> — extract the (sanitized) tenant segment from a
# wt_dir-shaped path (<root>/.worktrees/<tenant>/<repo>-<taskId>). rc 1 when the
# path doesn't look like a wt_dir product. Lets the stale sweep resolve which
# tenant OWNS a worktree, so its age check can use that tenant's own cap.
wt_path_tenant() {
    case "$1" in */.worktrees/*/*) : ;; *) return 1 ;; esac
    local rest="${1##*/.worktrees/}"
    printf '%s' "${rest%%/*}"
}

# wt_create <base_repo_dir> <worktree_dir> <branch> <base_ref> — create (or
# reset, if a same-named leftover exists) an isolated worktree at
# <worktree_dir>, checked out on <branch> starting from <base_ref>
# (e.g. origin/test or origin/main). Idempotent: clears any stale worktree /
# branch of the same name first (crash-leftover from a prior attempt on the
# same task), so a retried task always gets a clean start. rc = git's exit code.
wt_create() {
    local base="$1" dir="$2" branch="$3" base_ref="$4"
    mkdir -p "$(dirname "$dir")" 2>/dev/null || true
    git -C "$base" worktree remove --force "$dir" >/dev/null 2>&1 || true
    rm -rf "$dir" 2>/dev/null || true
    git -C "$base" worktree prune >/dev/null 2>&1 || true
    git -C "$base" branch -D "$branch" >/dev/null 2>&1 || true
    git -C "$base" worktree add -B "$branch" "$dir" "$base_ref" >/dev/null 2>&1
}

# wt_remove <base_repo_dir> <worktree_dir> <branch> — tear down one task's
# worktree + its branch. Best-effort and always rc 0 — cleanup must never fail
# the runner (an already-gone worktree/branch is a no-op, not an error).
wt_remove() {
    local base="$1" dir="$2" branch="$3"
    git -C "$base" worktree remove --force "$dir" >/dev/null 2>&1 || true
    rm -rf "$dir" 2>/dev/null || true
    git -C "$base" worktree prune >/dev/null 2>&1 || true
    [ -n "$branch" ] && { git -C "$base" branch -D "$branch" >/dev/null 2>&1 || true; }
    return 0
}

# wt_list_stale <base_repo_dir> <worktrees_root> <max_age_sec> [now_epoch] [age_fn] —
# print "path<TAB>branch" for every registered worktree under <worktrees_root>
# whose directory is older than <max_age_sec>. Read-only (no removal) so it's
# unit-testable independent of wt_remove. Guards against a worktree left behind
# by a hard crash (the script's own EXIT-trap cleanup handles the normal case).
# [age_fn] (optional): name of a function called with each worktree's path; if
# it prints a numeric max-age-sec, THAT threshold is used for the path instead
# of the sweep-wide <max_age_sec> (rc!=0 / empty / non-numeric → fall back).
# This is how the runner sizes each age check to the OWNING tenant's resolved
# maxMinutes override rather than the global default cap.
wt_list_stale() {
    local base="$1" root="$2" max_age="${3:-3600}" now="${4:-}" age_fn="${5:-}"
    [ -n "$now" ] || now="$(date +%s)"
    local porcelain path="" branch="" mtime age line
    # `git worktree list --porcelain` reports each worktree's CANONICAL path
    # (symlinks resolved, e.g. macOS /tmp → /private/tmp) — resolve $root the
    # same way before prefix-matching, or a symlinked ci-workspaces root would
    # silently match nothing.
    root="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$root" 2>/dev/null || printf '%s' "$root")"
    porcelain="$(git -C "$base" worktree list --porcelain 2>/dev/null)"
    _wt_emit_if_stale() {
        [ -z "$path" ] && return 0
        case "$path" in
            "$root"/*) : ;;
            *) return 0 ;;
        esac
        # mtime epoch — GNU (`stat -c %Y`) FIRST, then BSD/macOS (`stat -f %m`).
        # ORDER MATTERS on Linux: a failing GNU `stat -f %m "$path"` treats `-f`
        # as --file-system and `%m` as a bogus file operand — it errors on `%m`
        # (to stderr, so `||` fires) but STILL prints $path's filesystem status
        # to stdout, polluting the captured value and breaking the arithmetic
        # below. Trying `-c` first means `stat -f` never runs on Linux; on macOS
        # `stat -c` fails cleanly (usage → stderr) and the BSD form takes over.
        mtime=$(stat -c %Y "$path" 2>/dev/null || stat -f %m "$path" 2>/dev/null || printf '%s' "$now")
        case "$mtime" in ''|*[!0-9]*) mtime="$now" ;; esac   # never let a non-numeric value break the age math
        age=$(( now - mtime ))
        local cap="$max_age" per
        if [ -n "$age_fn" ] && per="$("$age_fn" "$path" 2>/dev/null)"; then
            case "$per" in ''|*[!0-9]*) : ;; *) cap="$per" ;; esac
        fi
        [ "$age" -ge "$cap" ] && printf '%s\t%s\n' "$path" "$branch"
    }
    while IFS= read -r line; do
        case "$line" in
            worktree\ *) _wt_emit_if_stale; path="${line#worktree }"; branch="" ;;
            branch\ refs/heads/*) branch="${line#branch refs/heads/}" ;;
            '') : ;;   # blank separator between records — nothing to do here
        esac
    done <<EOF
$porcelain
EOF
    _wt_emit_if_stale   # the final record has no trailing blank-line trigger
}

# wt_prune_stale <base_repo_dir> <worktrees_root> <max_age_sec> [now_epoch] [age_fn] —
# remove every stale worktree wt_list_stale finds. Safe to call on every fire
# (cheap no-op when nothing is stale); mirrors the runner's existing stale-slot
# pruning pattern (SLOT_ROOT) at the top of cli_task_runner.sh. [age_fn] is
# threaded through to wt_list_stale (per-path threshold, see there).
wt_prune_stale() {
    local base="$1" root="$2" max_age="$3" now="${4:-}" age_fn="${5:-}" path branch TAB
    TAB="$(printf '\t')"
    while IFS="$TAB" read -r path branch; do
        [ -z "$path" ] && continue
        wt_remove "$base" "$path" "$branch"
    done <<EOF
$(wt_list_stale "$base" "$root" "$max_age" "$now" "$age_fn")
EOF
}
