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
# script instead CLASSIFIES first:
#   identical  — byte-for-byte equal to its live counterpart -> pure noise, safe
#   differing  — content the live file does not have -> NEVER auto-deleted
#   orphan     — no live counterpart -> needs a human, could be the only copy
# Only --clean-identical removes anything by default.
#
# Usage:
#   dropbox_conflicts.sh --list              classify and print (default)
#   dropbox_conflicts.sh --clean-identical   delete ONLY byte-identical copies
#   dropbox_conflicts.sh --diff              show a diff per differing copy
#   dropbox_conflicts.sh --clean-all --yes   delete every conflict copy (needs --yes)
#   flags: --root <dir>  --quiet

MODE=list ROOT="" YES=0 QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --list)            MODE=list ;;
    --clean-identical) MODE=clean_identical ;;
    --clean-all)       MODE=clean_all ;;
    --diff)            MODE=diff ;;
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

# live counterpart = the path with the " (… conflicted copy YYYY-MM-DD)" chunk removed
live_of() {
  python3 - "$1" <<'PY'
import re,sys
print(re.sub(r" \([^()]*conflicted copy \d{4}-\d{2}-\d{2}\)", "", sys.argv[1]))
PY
}

FOUND=$(find "$ROOT" -maxdepth 8 \
  \( -name node_modules -o -name .next -o -name .git -o -name coverage -o -name .turbo \) -prune -o \
  -type f -name "*conflicted copy*" -print 2>/dev/null)

if [ -z "$FOUND" ]; then
  say "dropbox_conflicts: none found under $ROOT"
  exit 0
fi

SAME=() DIFF=() ORPHAN=()
while IFS= read -r f; do
  [ -n "$f" ] || continue
  live="$(live_of "$f")"
  if [ ! -f "$live" ]; then ORPHAN+=("$f")
  elif cmp -s "$f" "$live"; then SAME+=("$f")
  else DIFF+=("$f")
  fi
done <<< "$FOUND"

total=$(( ${#SAME[@]} + ${#DIFF[@]} + ${#ORPHAN[@]} ))
say "dropbox_conflicts: $total conflict copy/copies under ${ROOT}"
say "  identical to live (safe to remove): ${#SAME[@]}"
say "  differing (review — may hold the only copy of an edit): ${#DIFF[@]}"
say "  orphaned (no live counterpart): ${#ORPHAN[@]}"

show() { local label="$1"; shift; [ "$#" -eq 0 ] && return 0; say ""; say "$label"; local f; for f in "$@"; do say "  · ${f#$ROOT/}"; done; }

case "$MODE" in
  list)
    show "IDENTICAL — removable with --clean-identical:" "${SAME[@]}"
    show "DIFFERING — inspect with --diff before deciding:" "${DIFF[@]}"
    show "ORPHANED — no live file; decide by hand:" "${ORPHAN[@]}"
    [ "${#DIFF[@]}" -gt 0 ] || [ "${#ORPHAN[@]}" -gt 0 ] && exit 3
    exit 0 ;;
  diff)
    for f in "${DIFF[@]}"; do
      live="$(live_of "$f")"
      say ""; say "=== ${f#$ROOT/}"; say "--- live: ${live#$ROOT/}"
      diff -u "$live" "$f" 2>/dev/null | head -40
    done
    exit 0 ;;
  clean_identical)
    n=0
    for f in "${SAME[@]}"; do rm -f -- "$f" && n=$((n+1)); done
    say ""; say "removed $n byte-identical conflict copy/copies."
    [ "${#DIFF[@]}" -gt 0 ] && say "KEPT ${#DIFF[@]} differing + ${#ORPHAN[@]} orphaned — review those by hand."
    exit 0 ;;
  clean_all)
    if [ "$YES" != 1 ]; then
      say ""; say "REFUSING: --clean-all deletes ${#DIFF[@]} differing and ${#ORPHAN[@]} orphaned copy/copies that may hold the only copy of an edit."
      say "Re-run with --yes if that is genuinely what you want."
      exit 2
    fi
    n=0
    for f in "${SAME[@]}" "${DIFF[@]}" "${ORPHAN[@]}"; do rm -f -- "$f" && n=$((n+1)); done
    say ""; say "removed $n conflict copy/copies (all classes)."
    exit 0 ;;
esac
