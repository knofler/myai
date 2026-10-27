#!/usr/bin/env bash
# stash_safe.sh — `git stash pop` that can never leave conflict markers behind.
#
# 2026-10-18: a stash+pop across live (Dropbox-synced) fleet trees left
# <<<<<<< markers in three fleet repos' .mcp.json → invalid
# JSON, MCP dead in all three. A plain `git stash pop` that conflicts writes
# the markers into the working tree, keeps the stash, and exits non-zero — and
# update_all.sh then staged .mcp.json and committed whatever was there.
#
# stash_pop_safe <repo> [<stash-ref>]
#   clean apply   → stash dropped, return 0 (same as a successful pop)
#   any conflict  → working tree + index put back to HEAD, untracked files the
#                   apply wrote removed, stash KEPT, return 1. Nothing is lost:
#                   every change is still in `git stash list`.
# Only call on a tree that was clean (or fully stashed) before the apply — the
# rollback resets to HEAD. bash 3.2-safe; never trips a caller's `set -e`.

stash_pop_safe() {
  # The default lives in its own variable: "${2:-stash@{0\}}" keeps the
  # backslash on bash 3.2 and drops it on bash 5.
  local top='stash@{0}' repo="$1" ref f
  ref="${2:-$top}"
  if git -C "$repo" stash apply -q "$ref" >/dev/null 2>&1; then
    git -C "$repo" stash drop -q "$ref" >/dev/null 2>&1 || true
    return 0
  fi
  git -C "$repo" reset -q --hard HEAD >/dev/null 2>&1 || true
  # `stash push -u` keeps untracked files in the stash's third parent; an apply
  # that got that far wrote them back. Remove exactly those, nothing else.
  if git -C "$repo" rev-parse -q --verify "$ref^3" >/dev/null 2>&1; then
    while IFS= read -r -d '' f; do
      [ -n "$f" ] || continue
      git -C "$repo" ls-files --error-unmatch -- ":(literal)$f" >/dev/null 2>&1 && continue
      rm -f -- "$repo/$f" 2>/dev/null || true
    done < <(git -C "$repo" ls-tree -r -z --name-only "$ref^3" 2>/dev/null)
  fi
  return 1
}
