#!/usr/bin/env bash
# rollout_permission_mode.sh — set permissions.defaultMode fleet-wide.
#
# WHY: since ~2026-09-03 Team/Enterprise orgs carry a server-side policy that
# disables bypassPermissions. Claude Code silently downgrades a declared
# "bypassPermissions" to "manual" (the new name for default) — every session
# started prompting even though every repo's .claude/settings.json still said
# bypass. "auto" is the sanctioned zero-prompt mode (classifier-gated), so the
# fleet default moves there. Hooks stay the safety rails regardless of mode.
#
# Usage: scripts/rollout_permission_mode.sh [--mode auto] [--dry-run] [--no-push]
#   --dry-run  report what would change, touch nothing
#   --no-push  edit + commit on `test`, but leave the push to the operator
set -u
MODE="auto"; DRY=0; PUSH=1
while [ $# -gt 0 ]; do case "$1" in
  --mode) MODE="$2"; shift 2;; --dry-run) DRY=1; shift;; --no-push) PUSH=0; shift;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; done
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROSTER="$ROOT/config/managed_repos.txt"
changed=0; skipped=0; pushed=0
while IFS= read -r line; do
  line="${line%%#*}"; line="$(echo "$line" | xargs)"; [ -z "$line" ] && continue
  repo="${line/#\~/$HOME}"
  f="$repo/.claude/settings.json"
  name="$(basename "$repo")"
  if [ ! -f "$f" ]; then printf '%-22s no settings.json\n' "$name"; skipped=$((skipped+1)); continue; fi
  cur="$(grep -o -E '"defaultMode": *"[A-Za-z]+"' "$f" | head -1 | sed -E 's/.*"([A-Za-z]+)"$/\1/')"
  br="$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  if [ "$cur" = "$MODE" ]; then printf '%-22s already %s (%s)\n' "$name" "$MODE" "$br"; skipped=$((skipped+1)); continue; fi
  printf '%-22s %s -> %s (branch %s)%s\n' "$name" "${cur:-unset}" "$MODE" "$br" "$([ $DRY = 1 ] && echo '  [dry-run]')"
  [ $DRY = 1 ] && continue
  sed -i '' -E "s/\"defaultMode\": *\"[A-Za-z]+\"/\"defaultMode\": \"$MODE\"/" "$f"
  changed=$((changed+1))
  if [ "$br" = "test" ]; then
    git -C "$repo" add .claude/settings.json
    git -C "$repo" commit -q -m "chore(permissions): defaultMode $MODE — bypass is org-gated since 2026-09-03, auto is the zero-prompt mode" -- .claude/settings.json 2>/dev/null || true
    if [ $PUSH = 1 ]; then
      git -C "$repo" push -q origin test 2>&1 | tail -1 && pushed=$((pushed+1))
    fi
  else
    echo "   (edited, left uncommitted: branch is $br, not test)"
  fi
done < "$ROSTER"
echo "changed=$changed pushed=$pushed skipped=$skipped mode=$MODE"
