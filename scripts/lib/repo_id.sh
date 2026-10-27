#!/usr/bin/env bash
# repo_id.sh — the ONE place that resolves a repo's canonical task-queue id
# (task-89077bf0-f4a1-490c-ac69-1be63c050a2f).
#
# THE PROBLEM: the master framework repo's checkout folder is often literally
# named "AI", but every other subsystem that talks about this
# repo calls it "ai_management" — the task store's `repo` field, the brain
# namespace (slugified further to "ai-management" by _brain_slugify/
# runtime's slugify()), the dashboard, etc. Before this file existed, each
# script that needed to go from "a repo's checkout folder" or "a repo id
# string" to "the id to filter the task queue by" carried its OWN copy of
# that folder→id mapping:
#   • scripts/schedule_task.sh had NONE — it defaulted --repo to the raw git
#     basename, so run from the master checkout it queued/queried "AI".
#   • hooks/session/17-schedule-status.sh special-cased the master checkout →
#     "ai_management" for its SCHEDULE banner query.
#   • scripts/reconcile_review_tasks.sh, scripts/cli_task_runner.sh and
#     scripts/triage_blocked_tasks.sh each carried their own
#     `[ "$repo" = "AI" ] || [ "$repo" = "ai_management" ]` alias check.
# Same repo, disagreeing spellings depending which script asked → `schedule
# --list` (queried "AI") and the SCHEDULE banner (queried "ai_management")
# showed different queues for the exact same repo.
#
# THE FIX: resolve through the two functions below EVERYWHERE a repo id is
# derived from a checkout path or normalized from a string. New tasks are
# always created/queried under the canonical id; repo_aliases_for() lets a
# caller widen an existing query across every historical spelling so tasks
# queued before this fix (under the literal "AI" string) are never orphaned.
#
# Canonical id spelling must match the TS-side master-repo alias in
# runtime/src/memory/indexer.ts (repoNameForBrainNamespace: hardcodes
# slugify('ai_management')) — if you ever add a new alias here, add it there
# too so the brain-side RAG indexer doesn't silently drift back out of sync.
#
# Sourceable, set -e/-u safe, bash 3.2 (stock macOS).

# repo_id_from_path <abs-path-to-a-repo-checkout> → canonical id on stdout.
repo_id_from_path() {
  local path="$1" name parent
  name="$(basename "$path")"
  parent="$(basename "$(dirname "$path")")"
  # The framework's own checkout, whatever its folder is called (it is
  # recognised by its package name) — canonicalize to the one id every other
  # subsystem (task queue, brain namespace, dashboard) recognizes.
  if [ -f "$path/package.json" ] && grep -qE '"name"[[:space:]]*:[[:space:]]*"ai-management"' "$path/package.json" 2>/dev/null; then
    echo "ai_management"; return
  fi
  # A lane worktree (scripts/lane_worktree.sh: ~/.myai/worktrees/<repo>/<task>)
  # belongs to <repo>, not to a repo named after the task — otherwise a worker
  # building in its lane lost its repo's mail and swarm eligibility.
  case "$path" in
    */.myai/worktrees/*/*)
      if [ "$(basename "$(dirname "$(dirname "$path")")")" = worktrees ]; then
        canonical_repo_id "$parent"; return
      fi ;;
  esac
  # A bare "AI" folder under any other parent (a worktree, a fresh clone
  # elsewhere) is still assumed to be this same master checkout — it is the
  # only repo in the fleet with that two-letter folder name.
  if [ "$name" = "AI" ]; then
    echo "ai_management"
  else
    echo "$name"
  fi
}

# is_master_repo_id <repo-id-string> → exit 0 if the string names the master
# AI/ai_management repo under any known alias, 1 otherwise.
is_master_repo_id() {
  case "$1" in
    AI|ai_management|ai-management) return 0 ;;
    *) return 1 ;;
  esac
}

# canonical_repo_id <path-or-repo-id> → canonical id on stdout. Accepts
# either a filesystem path (resolved via repo_id_from_path) or an already-bare
# repo-id string (aliases folded via is_master_repo_id).
canonical_repo_id() {
  local input="$1"
  if [ -d "$input" ]; then
    repo_id_from_path "$input"
    return
  fi
  if is_master_repo_id "$input"; then
    echo "ai_management"
  else
    echo "$input"
  fi
}

# repo_aliases_for <canonical-repo-id> → space-separated list of every
# historical spelling a caller should query to avoid orphaning tasks queued
# before a repo's ids were unified. Non-master repos have no known aliases —
# only themselves.
repo_aliases_for() {
  if is_master_repo_id "$1"; then
    echo "ai_management AI"
  else
    echo "$1"
  fi
}
