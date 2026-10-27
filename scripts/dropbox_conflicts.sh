#!/bin/bash
set +e
# dropbox_conflicts.sh — find, classify and safely resolve Dropbox conflict
# copies across the whole workspace.
#
# WHY. Dropbox writes "<name> (HOST's conflicted copy YYYY-MM-DD).ext" whenever
# two machines touch one file between syncs. The fleet accumulates them: on
# 2026-08-29 there were 21 across six repos, 16 of them 7 weeks old from the
# other Mac — and hooks/session/02-dropbox-conflicts.sh had been reporting "No
# Dropbox conflict files found" the whole time because it only scanned the
# current repo.
#
# WHY NOT JUST `find -delete`. The old advice in that hook was
# `find . -name '*conflicted*' -delete`. That is unsafe: a conflicted copy can
# hold the ONLY copy of an edit made on the other machine, and the pattern
# '*conflicted*' also matches ordinary filenames containing the word. This
# script instead CLASSIFIES first, and only ever removes what it can PROVE is
# lossless:
#   identical  — byte-for-byte equal to its live counterpart      -> noise, safe
#   in-git     — live file is git-tracked AND the copy's exact content is a
#                blob REACHABLE from some ref (`git log --all --find-object`)
#                -> the edit is preserved in history, the copy is an echo -> safe
#                (NOT `cat-file -e`: a staged-but-never-committed blob exists in
#                the object store too, and gc prunes it — review 2026-09-22)
#   regen      — a machine-generated snapshot named in
#                config/dropbox_conflict_policy.txt (`regen <glob>`): its
#                generator rewrites it every run, the copy is a stale snapshot
#                                                                   -> safe
#   merge      — an append-only JSONL log named in the policy (`merge <glob>`):
#                lines the live file lacks are appended (set union), THEN the
#                copy is removed                                    -> lossless
#   differing  — content the live file does not have, none of the above
#                                                                   -> NEVER auto-deleted
#   orphan     — no live counterpart                                -> needs a human
#
# WHY THE THREE NEW CLASSES (2026-09-22). The same 13 differing copies from the
# other Mac sat as a WARN in three consecutive boot reports — every one of them
# was lossless (6 in-git, 6 regen snapshots, 1 mergeable audit log), but the
# only auto-clean was byte-identical, so they waited five days for a human.
# `--clean-safe` is what the boot and the session hook run now.
#
# Usage:
#   dropbox_conflicts.sh --list              classify and print (default)
#   dropbox_conflicts.sh --clean-safe        resolve identical + in-git + regen + merge;
#                                            exit 3 if differing/orphaned copies remain
#   dropbox_conflicts.sh --clean-identical   delete ONLY byte-identical copies
#   dropbox_conflicts.sh --diff              show a diff per differing copy
#   dropbox_conflicts.sh --clean-all --yes   delete every conflict copy (needs --yes)
#   flags: --root <dir>  --quiet
# Env:  DROPBOX_CONFLICT_POLICY=<file>  (default: <this repo>/config/dropbox_conflict_policy.txt)
#       DROPBOX_CONFLICTS_MAXDEPTH=<n>  find depth under --root (default 8)
# Exit: 0 nothing left to review · 3 differing/orphaned copies remain · 2 usage/refused

MODE=list ROOT="" YES=0 QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --list)            MODE=list ;;
    --clean-identical) MODE=clean_identical ;;
    --clean-safe)      MODE=clean_safe ;;
    --clean-all)       MODE=clean_all ;;
    --diff)            MODE="diff" ;;
    --yes)             YES=1 ;;
    --quiet)           QUIET=1 ;;
    --root)            shift; ROOT="$1" ;;
    *) ;;
  esac
  shift
done

if [ -z "$ROOT" ]; then
  R="$(git rev-parse --show-toplevel 2>/dev/null)"
  ROOT="${MYAI_WORKSPACE_ROOT:-$(dirname "${R:-$PWD}")}"
fi
[ -d "$ROOT" ] || { echo "dropbox_conflicts: no such dir: $ROOT" >&2; exit 2; }
say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
POLICY="${DROPBOX_CONFLICT_POLICY:-$SCRIPT_DIR/../config/dropbox_conflict_policy.txt}"

# live counterpart = the path with the " (… conflicted copy YYYY-MM-DD)" chunk removed
live_of() {
  python3 - "$1" <<'PY'
import re,sys
print(re.sub(r" \([^()]*conflicted copy \d{4}-\d{2}-\d{2}\)", "", sys.argv[1]))
PY
}

# repo_of <file> → the git worktree root containing it, or empty
repo_of() { git -C "$(dirname "$1")" rev-parse --show-toplevel 2>/dev/null; }

# policy_match <verb> <relpath> → 0 when a `<verb> <glob>` line matches the path
# (glob tried as-is and with a leading "*/", so repo-relative rules also match
# paths taken relative to a wider sweep root).
policy_match() {
  local verb="$1" rel="$2" v g
  [ -f "$POLICY" ] || return 1
  while read -r v g _; do
    case "$v" in ''|'#'*) continue ;; esac
    [ "$v" = "$verb" ] || continue
    [ -n "$g" ] || continue
    # shellcheck disable=SC2254  # $g IS the pattern — quoting it would defeat the glob
    case "$rel" in $g|*/$g) return 0 ;; esac
  done < "$POLICY"
  return 1
}

# in_git <repo> <live_rel> <copy> → 0 when live is tracked AND the copy's exact
# bytes are a blob reachable from a commit on ANY ref — i.e. genuinely in
# history. A blob that is merely present in the object store (staged and never
# committed, or a dangling leftover) does not count: gc prunes those.
in_git() {
  local repo="$1" rel="$2" copy="$3" h
  git -C "$repo" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1 || return 1
  h="$(git -C "$repo" hash-object -- "$copy" 2>/dev/null)" || return 1
  [ -n "$h" ] || return 1
  [ -n "$(git -C "$repo" log --all -1 --format=%h --find-object="$h" 2>/dev/null)" ]
}

# merge_jsonl <copy> <live> → appends the copy's lines that live lacks; prints the count
merge_jsonl() {
  python3 - "$1" "$2" <<'PY'
import sys
copy, live = sys.argv[1], sys.argv[2]
with open(live, 'rb') as f:
    raw = f.read()
have = set(l for l in raw.split(b'\n') if l.strip())
with open(copy, 'rb') as f:
    lines = [l for l in f.read().split(b'\n') if l.strip()]
added = 0
with open(live, 'ab') as out:
    if raw and not raw.endswith(b'\n'):
        out.write(b'\n')
    for l in lines:
        if l not in have:
            out.write(l + b'\n'); have.add(l); added += 1
print(added)
PY
}

MAXDEPTH="${DROPBOX_CONFLICTS_MAXDEPTH:-8}"   # the 10s SessionStart hook passes 6 for its workspace-wide pass
FOUND=$(find "$ROOT" -maxdepth "$MAXDEPTH" \
  \( -name node_modules -o -name .next -o -name .git -o -name coverage -o -name .turbo \) -prune -o \
  -type f -name "*conflicted copy*" -print 2>/dev/null)

if [ -z "$FOUND" ]; then
  say "dropbox_conflicts: none found under $ROOT"
  exit 0
fi

SAME=() INGIT=() REGEN=() MERGE=() DIFF=() ORPHAN=()
while IFS= read -r f; do
  [ -n "$f" ] || continue
  live="$(live_of "$f")"
  if [ ! -f "$live" ]; then ORPHAN+=("$f"); continue; fi
  if cmp -s "$f" "$live"; then SAME+=("$f"); continue; fi
  repo="$(repo_of "$live")"
  if [ -n "$repo" ]; then rel="${live#"$repo"/}"; else rel="${live#"$ROOT"/}"; fi
  if [ -n "$repo" ] && in_git "$repo" "$rel" "$f"; then INGIT+=("$f")
  elif policy_match regen "$rel"; then REGEN+=("$f")
  elif policy_match merge "$rel" && case "$live" in *.jsonl) true ;; *) false ;; esac; then MERGE+=("$f")
  else DIFF+=("$f")
  fi
done <<< "$FOUND"

safe=$(( ${#SAME[@]} + ${#INGIT[@]} + ${#REGEN[@]} + ${#MERGE[@]} ))
total=$(( safe + ${#DIFF[@]} + ${#ORPHAN[@]} ))
say "dropbox_conflicts: $total conflict copy/copies under ${ROOT}"
say "  identical to live (safe to remove): ${#SAME[@]}"
say "  content already in git history (safe to remove): ${#INGIT[@]}"
say "  regenerated snapshot per policy (safe to remove): ${#REGEN[@]}"
say "  append-only log — merge missing lines, then remove: ${#MERGE[@]}"
say "  differing (review — may hold the only copy of an edit): ${#DIFF[@]}"
say "  orphaned (no live counterpart): ${#ORPHAN[@]}"
[ -f "$POLICY" ] || say "  (no policy file at $POLICY — regen/merge classes disabled)"

show() { local label="$1"; shift; [ "$#" -eq 0 ] && return 0; say ""; say "$label"; local f; for f in "$@"; do say "  · ${f#"$ROOT"/}"; done; }

case "$MODE" in
  list)
    show "IDENTICAL — removable with --clean-safe:" "${SAME[@]}"
    show "IN GIT HISTORY — removable with --clean-safe:" "${INGIT[@]}"
    show "REGENERATED SNAPSHOT (policy) — removable with --clean-safe:" "${REGEN[@]}"
    show "APPEND-ONLY LOG (policy) — merged then removed by --clean-safe:" "${MERGE[@]}"
    show "DIFFERING — inspect with --diff before deciding:" "${DIFF[@]}"
    show "ORPHANED — no live file; decide by hand:" "${ORPHAN[@]}"
    [ "$safe" -gt 0 ] && say "" && say "resolve the $safe lossless copy/copies: $0 --clean-safe --root '$ROOT'"
    if [ "${#DIFF[@]}" -gt 0 ] || [ "${#ORPHAN[@]}" -gt 0 ]; then exit 3; fi
    exit 0 ;;
  diff)
    for f in "${DIFF[@]}"; do
      live="$(live_of "$f")"
      say ""; say "=== ${f#"$ROOT"/}"; say "--- live: ${live#"$ROOT"/}"
      diff -u "$live" "$f" 2>/dev/null | head -40
    done
    exit 0 ;;
  clean_identical)
    n=0
    for f in "${SAME[@]}"; do rm -f -- "$f" && n=$((n+1)); done
    say ""; say "removed $n byte-identical conflict copy/copies."
    left=$(( ${#INGIT[@]} + ${#REGEN[@]} + ${#MERGE[@]} ))
    [ "$left" -gt 0 ] && say "$left more are lossless (in-git/regen/merge) — resolve with --clean-safe."
    [ "${#DIFF[@]}" -gt 0 ] && say "KEPT ${#DIFF[@]} differing + ${#ORPHAN[@]} orphaned — review those by hand."
    exit 0 ;;
  clean_safe)
    ni=0 ng=0 nr=0 nm=0
    for f in "${SAME[@]}";  do rm -f -- "$f" && ni=$((ni+1)); done
    for f in "${INGIT[@]}"; do rm -f -- "$f" && ng=$((ng+1)); done
    for f in "${REGEN[@]}"; do rm -f -- "$f" && nr=$((nr+1)); done
    for f in "${MERGE[@]}"; do
      live="$(live_of "$f")"
      added="$(merge_jsonl "$f" "$live")" || { say "  merge FAILED for ${f#"$ROOT"/} — kept"; continue; }
      say "  merged $added line(s) from ${f#"$ROOT"/} into ${live#"$ROOT"/}"
      rm -f -- "$f" && nm=$((nm+1))
    done
    say ""; say "removed $((ni+ng+nr+nm)) lossless conflict copy/copies (identical $ni · in-git $ng · regenerated $nr · merged $nm)."
    if [ "${#DIFF[@]}" -gt 0 ] || [ "${#ORPHAN[@]}" -gt 0 ]; then
      say "KEPT ${#DIFF[@]} differing + ${#ORPHAN[@]} orphaned — a human decides: $0 --diff --root '$ROOT'"
      show "DIFFERING:" "${DIFF[@]}"
      show "ORPHANED:" "${ORPHAN[@]}"
      exit 3
    fi
    exit 0 ;;
  clean_all)
    if [ "$YES" != 1 ]; then
      say ""; say "REFUSING: --clean-all deletes ${#DIFF[@]} differing and ${#ORPHAN[@]} orphaned copy/copies that may hold the only copy of an edit."
      say "Re-run with --yes if that is genuinely what you want."
      exit 2
    fi
    n=0
    for f in "${SAME[@]}" "${INGIT[@]}" "${REGEN[@]}" "${MERGE[@]}" "${DIFF[@]}" "${ORPHAN[@]}"; do rm -f -- "$f" && n=$((n+1)); done
    say ""; say "removed $n conflict copy/copies (all classes)."
    exit 0 ;;
esac
