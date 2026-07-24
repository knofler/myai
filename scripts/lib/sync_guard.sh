#!/usr/bin/env bash
# sync_guard.sh — durable fix for the recurring Dropbox "conflicted copy" pileup
# (DEVOPS root-cause, 2026-07-20).
#
# Root cause: every managed repo in config/managed_repos.txt lives under
# a cloud-synced dir (the sync client mirrors the working tree itself, not just
# what git tracks). update_all.sh
# used to `cp -v`/`cp -r` CLAUDE.md, hooks/, AI/scripts/*, agents/, skills/ into
# each target UNCONDITIONALLY, every run, whether or not the content had
# changed. Two machines syncing within the same Dropbox propagation window
# (autonomous runner on one Mac + an interactive session on another, or two
# machines both idling through `wrap up`) each touch the same destination
# paths; Dropbox's last-writer-wins reconciliation can't tell the difference
# between "real concurrent edit" and "two machines re-writing identical bytes",
# so it defensively spins up "<file> (<machine>'s conflicted copy <date>)".
#
# Fix, two layers:
#   1. sync_file/sync_tree — skip the write (and therefore the touch) when the
#      destination is already byte-identical. Most update_all.sh runs re-sync
#      unchanged framework files, so this removes the write entirely for the
#      dominant case — a no-op sync now produces zero filesystem events on
#      either machine, so Dropbox has nothing to reconcile.
#   2. acquire_repo_lock/release_repo_lock — best-effort mutual exclusion via
#      atomic mkdir, so two machines that DO start a sync within the same
#      few seconds serialize instead of racing raw writes. Not airtight (the
#      lock dir itself has to propagate through Dropbox like anything else),
#      but it closes the window for the common near-simultaneous case and
#      degrades safely: a stale lock (>5 min old — the other machine's run
#      almost certainly died or Dropbox hasn't caught up) is reclaimed rather
#      than blocking forever.
#
# Consumers: scripts/update_all.sh. Sourced, not executed.
# Layout note: lives at <root>/scripts/lib/ (master) or <root>/AI/scripts/lib/
# (managed) — same convention as gateway.sh / secret_patterns.sh.

# sync_file SRC DST — copy only when DST doesn't exist or differs from SRC.
# Echoes a one-line note when it actually writes; silent on skip (keeps
# update_all.sh output focused on real changes).
sync_file() {
    local src="$1" dst="$2"
    [ -f "$src" ] || return 0
    if [ -f "$dst" ] && cmp -s "$src" "$dst" 2>/dev/null; then
        return 0
    fi
    mkdir -p "$(dirname "$dst")" 2>/dev/null
    cp "$src" "$dst"
    echo "  synced: $dst"
}

# sync_tree SRC_DIR DST_DIR — mirror every file under SRC_DIR into DST_DIR,
# skipping any file that's already byte-identical (see sync_file). Does not
# delete files present in DST_DIR but absent from SRC_DIR (matches the prior
# `cp -r` behavior, which was additive-only too).
sync_tree() {
    # Strip any trailing slash first — update_all.sh's `"$REPO_DIR/skills"/*/`
    # glob hands sync_tree a src_dir WITH a trailing slash. Left unstripped,
    # `${f#"$src_dir"/}` below tries to match a "//" prefix against find's
    # single-slash-joined paths, the strip silently fails, and `rel` becomes
    # the entire absolute source path — nesting the whole host directory tree
    # (e.g. /Users/you/...) under dst_dir. Harmless-looking on macOS/Linux
    # (just bloats the target repo); on Windows it can blow past MAX_PATH.
    local src_dir="${1%/}" dst_dir="$2"
    [ -d "$src_dir" ] || return 0
    mkdir -p "$dst_dir"
    local f rel
    while IFS= read -r f; do
        rel="${f#"$src_dir"/}"
        sync_file "$f" "$dst_dir/$rel"
    done < <(find "$src_dir" -type f)
}

# acquire_repo_lock REPO_PATH [STALE_SECS=300] — atomic mkdir-based lock so two
# machines syncing the same Dropbox-synced repo within the same window
# serialize instead of both writing at once. Returns 0 + prints the lock dir
# path on success, 1 if another machine's sync is genuinely in flight.
acquire_repo_lock() {
    local repo_path="$1" stale="${2:-300}"
    local lock_dir="$repo_path/.ai-sync.lock"
    local attempt age mtime
    for attempt in 1 2 3; do
        if mkdir "$lock_dir" 2>/dev/null; then
            { hostname -s 2>/dev/null; echo "$$"; } > "$lock_dir/owner" 2>/dev/null || true
            echo "$lock_dir"
            return 0
        fi
        if [ -d "$lock_dir" ]; then
            mtime=$(stat -c %Y "$lock_dir" 2>/dev/null || stat -f %m "$lock_dir" 2>/dev/null || echo 0)  # GNU-first: BSD `stat -f` on Linux pollutes stdout (see runner_worktree.sh)
            age=$(( $(date +%s) - mtime ))
            if [ "$age" -gt "$stale" ]; then
                rm -rf "$lock_dir" 2>/dev/null
                continue
            fi
        fi
        sleep 2
    done
    return 1
}

# release_repo_lock REPO_PATH — always call after acquire_repo_lock succeeds,
# even on error paths (caller's responsibility — use a trap or explicit call
# in both the success and failure branch).
release_repo_lock() {
    local repo_path="$1"
    rm -rf "$repo_path/.ai-sync.lock" 2>/dev/null
    return 0
}
