#!/usr/bin/env bash
# =============================================================================
# brain_ns_gc.sh — garbage-collect polluted brain namespaces, and re-join a
# repo's memory when it got split across alias namespaces.
#
# WHY: the brain namespace used to be derived from a directory basename
# (fixed at the source by brain_repo_name in scripts/lib/brain.sh). Two kinds
# of damage accumulated and this script cleans up the existing store:
#
#   1. PER-TASK JUNK. The runner works each task in a worktree named
#      <repo>-task-<uuid>, so every task minted its own namespace holding a
#      compiled brief/working/rollup plus a mechanical `session-auto` atom.
#      661 of these existed (~10MB of a 21MB store). The REAL atom for each of
#      those tasks was written to the parent namespace at the same time
#      (brain(session): ai-management/task-XXXX), so the per-task copy is a
#      duplicate lane, not unique history.
#
#   2. ALIAS SPLIT. The same repo answered to two namespaces depending on who
#      wrote: interactive sessions used the checkout dir basename ("AI" -> `ai`)
#      while the runner passed the repo name (`ai-management`). brain_delta
#      therefore returned only half the history and every session booted from a
#      partial memory. --alias merges one into the other.
#
# SAFETY (this script deletes things):
#   • --dry-run is the DEFAULT. Nothing changes without --apply.
#   • --apply first creates a backup branch on the brain repo, so every removed
#     atom stays recoverable from git regardless of what is pruned.
#   • A junk namespace holding ANY real atom (kind: session | handoff | memory)
#     is NEVER deleted outright — its real atoms are MOVED into the parent
#     namespace first. Only mechanical `session-auto` atoms are discarded.
#
# Usage:
#   scripts/brain_ns_gc.sh                       # dry-run report
#   scripts/brain_ns_gc.sh --apply               # prune per-task junk
#   scripts/brain_ns_gc.sh --alias ai=ai-management --apply
#   scripts/brain_ns_gc.sh --alias ai=ai-management            # preview it
# =============================================================================
set -uo pipefail

APPLY=0
ALIASES=""
OBS_ALIASES=""
while [ $# -gt 0 ]; do
    case "$1" in
        --apply)   APPLY=1; shift ;;
        --dry-run) APPLY=0; shift ;;
        --alias)   ALIASES="$ALIASES $2"; shift 2 ;;
        --observe-alias) OBS_ALIASES="$OBS_ALIASES $2"; shift 2 ;;
        -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=lib/brain.sh
. "$REPO_ROOT/scripts/lib/brain.sh" 2>/dev/null || {
    echo "brain_ns_gc: cannot source scripts/lib/brain.sh" >&2; exit 1
}

BDIR="$(brain_dir 2>/dev/null)"
[ -n "$BDIR" ] && [ -d "$BDIR/repos" ] || { echo "brain_ns_gc: no brain store at '${BDIR:-?}'" >&2; exit 1; }
brain_is_repo "$BDIR" 2>/dev/null || { echo "brain_ns_gc: '$BDIR' is not a git repo — refusing to prune" >&2; exit 1; }

if [ "$APPLY" = 1 ] && [ -n "$(git -C "$BDIR" status --porcelain 2>/dev/null)" ]; then
    echo "brain_ns_gc: the brain store has uncommitted changes — commit or stash them first" >&2
    exit 1
fi

# atom_kind <file> — the frontmatter `kind:` value ("" when absent).
atom_kind() { sed -n '1,20p' "$1" 2>/dev/null | grep -m1 '^kind:' | awk '{print $2}'; }

# real_atoms <ns-dir> — count atoms worth keeping (anything but session-auto).
real_atoms() {
    local d="$1" f n=0
    for f in "$d"/sessions/*.md "$d"/handoffs/*.md "$d"/memory/*.md; do
        [ -f "$f" ] || continue
        case "$(atom_kind "$f")" in
            session|handoff|memory) n=$((n+1)) ;;
        esac
    done
    printf '%s\n' "$n"
}

count_md() { find "$1" -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' '; }

MOVED_TOTAL=0 PRUNED_TOTAL=0 KEPT_TOTAL=0 RECLAIM_KB=0

# move_real_atoms <from-ns-dir> <to-ns-name> — relocate keepable atoms.
move_real_atoms() {
    local from="$1" to="$2" sub f base dest
    for sub in sessions handoffs memory; do
        [ -d "$from/$sub" ] || continue
        for f in "$from/$sub"/*.md; do
            [ -f "$f" ] || continue
            case "$(atom_kind "$f")" in
                session|handoff|memory) : ;;
                *) continue ;;
            esac
            dest="$BDIR/repos/$to/$sub"
            base="$(basename "$f")"
            if [ "$APPLY" = 1 ]; then
                mkdir -p "$dest"
                # never clobber: an existing atom of the same name wins
                [ -e "$dest/$base" ] || git -C "$BDIR" mv "$f" "$dest/$base" 2>/dev/null || mv "$f" "$dest/$base"
            fi
            echo "      move  $sub/$base -> repos/$to/$sub/"
            MOVED_TOTAL=$((MOVED_TOTAL+1))
        done
    done
}

echo "=== brain_ns_gc — $( [ "$APPLY" = 1 ] && echo APPLY || echo 'DRY RUN (nothing will change)' ) ==="
echo "store: $BDIR"
echo

# ── part 1: per-task junk namespaces ────────────────────────────────────────
echo "--- per-task namespaces (<repo>-task-<uuid>) ---"
JUNK_LIST=""
for d in "$BDIR"/repos/*/; do
    ns="$(basename "$d")"
    # the runner's worktree shape: <repo>-task-<hex/uuid>
    case "$ns" in
        *-task-*) : ;;
        *) continue ;;
    esac
    parent="${ns%%-task-*}"
    [ -n "$parent" ] || continue
    if [ ! -d "$BDIR/repos/$parent" ]; then
        echo "  KEEP  $ns — parent namespace '$parent' does not exist, not safe to fold"
        KEPT_TOTAL=$((KEPT_TOTAL+1))
        continue
    fi
    n_real="$(real_atoms "$d")"
    n_all="$(count_md "$d")"
    kb="$(du -sk "$d" 2>/dev/null | cut -f1)"
    if [ "$n_real" -gt 0 ]; then
        echo "  FOLD  $ns — $n_real real atom(s) of $n_all -> merged into '$parent', then pruned"
        move_real_atoms "$d" "$parent"
    else
        echo "  PRUNE $ns — $n_all atom(s), all mechanical session-auto (duplicated in '$parent')"
    fi
    JUNK_LIST="$JUNK_LIST $ns"
    PRUNED_TOTAL=$((PRUNED_TOTAL+1))
    RECLAIM_KB=$((RECLAIM_KB + ${kb:-0}))
done
[ "$PRUNED_TOTAL" = 0 ] && echo "  (none found)"

# ── part 2: alias namespaces ────────────────────────────────────────────────
if [ -n "$ALIASES" ]; then
    echo
    echo "--- alias merges (re-joining split memory) ---"
    for spec in $ALIASES; do
        from="${spec%%=*}"; to="${spec##*=}"
        if [ "$from" = "$to" ] || [ -z "$from" ] || [ -z "$to" ]; then
            echo "  SKIP  '$spec' — expected <from>=<to> with different names"; continue
        fi
        if [ ! -d "$BDIR/repos/$from" ]; then echo "  SKIP  '$from' — no such namespace"; continue; fi
        if [ ! -d "$BDIR/repos/$to" ];   then echo "  SKIP  '$to' — target namespace missing"; continue; fi
        n_real="$(real_atoms "$BDIR/repos/$from")"
        n_all="$(count_md "$BDIR/repos/$from")"
        echo "  MERGE $from -> $to  ($n_real real of $n_all atoms)"
        move_real_atoms "$BDIR/repos/$from" "$to"
        JUNK_LIST="$JUNK_LIST $from"
        RECLAIM_KB=$((RECLAIM_KB + $(du -sk "$BDIR/repos/$from" 2>/dev/null | cut -f1)))
    done
fi

# ── part 3: scratch/observe buffers ────────────────────────────────────────
# The observe buffers are keyed by the RAW repo name (repos/ uses the slug), and
# they carry the same per-task pollution. They must be cleaned in the SAME pass:
# brain_health's captureCoverage matches observed sessions against atoms, so
# pruning repos/<ns> while leaving scratch/observe/<ns> behind makes coverage
# read 0 — 161 "uncaptured" sessions that were in fact captured, in the parent
# namespace, all along. (Found exactly that way: the score fell 71 -> 67 after
# the namespace prune.) These buffers are transient tool-call scratch used to
# build session-auto atoms, so per-task ones are safe to drop outright.
OBS_DIR="$BDIR/scratch/observe"
OBS_PRUNED=0
if [ -d "$OBS_DIR" ]; then
    echo
    echo "--- scratch/observe buffers ---"
    for d in "$OBS_DIR"/*/; do
        [ -d "$d" ] || continue
        ob="$(basename "$d")"
        case "$ob" in *-task-*) : ;; *) continue ;; esac
        [ "$APPLY" = 1 ] && rm -rf "${d:?}"
        OBS_PRUNED=$((OBS_PRUNED+1))
    done
    echo "  $( [ "$APPLY" = 1 ] && echo pruned || echo 'would prune') $OBS_PRUNED per-task observe buffer(s)"

    # Alias buffers: the pre-fix code keyed these off the checkout dir basename
    # (e.g. "AI"), the fix keys them off the canonical repo name.
    for spec in $OBS_ALIASES; do
        from="${spec%%=*}"; to="${spec##*=}"
        [ -n "$from" ] && [ -n "$to" ] && [ "$from" != "$to" ] || continue
        [ -d "$OBS_DIR/$from" ] || { echo "  SKIP observe alias '$from' — not present"; continue; }
        echo "  MERGE observe $from -> $to"
        if [ "$APPLY" = 1 ]; then
            mkdir -p "$OBS_DIR/$to"
            for f in "$OBS_DIR/$from"/*; do
                [ -e "$f" ] || continue
                [ -e "$OBS_DIR/$to/$(basename "$f")" ] || mv "$f" "$OBS_DIR/$to/"
            done
            rmdir "$OBS_DIR/$from" 2>/dev/null || rm -rf "${OBS_DIR:?}/${from:?}"
        fi
    done
fi

# ── remove the emptied namespaces + commit ──────────────────────────────────
echo
if [ "$APPLY" = 1 ] && [ -n "$JUNK_LIST" ]; then
    BACKUP="brain-ns-gc-backup-$(date -u +%Y%m%dT%H%M%SZ)"
    git -C "$BDIR" branch "$BACKUP" >/dev/null 2>&1 \
        && echo "backup branch: $BACKUP (every pruned atom stays recoverable here)" \
        || echo "WARNING: could not create backup branch — continuing, git history still holds the atoms"
    for ns in $JUNK_LIST; do
        rm -rf "${BDIR:?}/repos/${ns:?}"
    done
    git -C "$BDIR" add -A repos >/dev/null 2>&1
    git -C "$BDIR" commit -q -m "brain(gc): prune $PRUNED_TOTAL per-task namespace(s), move $MOVED_TOTAL real atom(s)

Namespaces were derived from a directory basename, so the runner's
<repo>-task-<uuid> worktrees each minted a throwaway namespace, and one repo
answered to two names (dir basename vs repo name) which split its memory in
half. Source fixed by brain_repo_name in scripts/lib/brain.sh; this is the
cleanup of the store that flaw left behind. Backup branch: $BACKUP" 2>/dev/null \
        && echo "committed to brain main" || echo "nothing to commit"
fi

echo
echo "RESULT: ${PRUNED_TOTAL} namespace(s) $( [ "$APPLY" = 1 ] && echo pruned || echo 'would be pruned'), ${MOVED_TOTAL} real atom(s) $( [ "$APPLY" = 1 ] && echo moved || echo 'would move'), ${KEPT_TOTAL} kept, ${OBS_PRUNED:-0} observe buffer(s), ~$((RECLAIM_KB/1024)) MB reclaimed"
[ "$APPLY" = 1 ] || echo "(dry run — re-run with --apply to act)"
