#!/usr/bin/env bash
# myai_ns.sh — brain-namespace registration for `myai init`
# (plan MYAI_INIT_ONE_COMMAND_PLAN.md S-INIT-4, ADR-016 §0.1/§0.4).
#
# `myai init` (greenfield) registers repos/<ns>/ in the one-per-user brain and
# records the resolved namespace id in .myai-local. This lib owns that logic so
# it is unit-testable in isolation (scripts/tests/test_myai_init_ns.sh) and reused
# by both the greenfield init path and any future callers.
#
# CONTRACT (both guardrails from S-INIT-4):
#   • Idempotent — re-init NEVER duplicates or renames an existing namespace. An
#     id already recorded in .myai-local is AUTHORITATIVE and honored verbatim;
#     brain_ensure_ns is a no-op when the namespace dir already exists.
#   • Collision-safe — when choosing a NEW namespace, if the brain already holds
#     one under the derived slug claimed by a DIFFERENT code repo, disambiguate
#     (group/owner-qualified first, then numeric, then a content hash). A
#     provenance marker (repos/<ns>/.origin = the owning code repo's identity)
#     makes both re-init and a same-named sibling repo resolve deterministically.
#
# Canonicalization matches the brain everywhere (brain.sh `_brain_slugify`, its
# node mirror, and distill.ts `slugify` used by `readCompiledBrief`/context_boot)
# so the id stored in .myai-local IS the on-disk brain dir name — context_boot in
# the repo resolves straight to repos/<ns>/brief.md on brain main.
#
# Sourceable, set -e/-u safe, bash 3.2 (stock macOS). Non-fatal: prints the
# resolved id even when the brain is absent (registration is then skipped).

_MYAI_NS_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# brain.sh is the single source of truth for brain_dir/brain_ensure_ns/slugify.
if ! command -v brain_dir >/dev/null 2>&1; then
  # shellcheck source=brain.sh
  . "$_MYAI_NS_HERE/brain.sh"
fi

# _myai_ns_code_id <code_repo_dir> — a stable identity for the OWNING code repo:
# its normalized origin remote when it has one, else its absolute path. Used as
# the provenance marker so two different repos can never silently share a ns.
_myai_ns_code_id() {
  local dir="$1" url=""
  if git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
    url="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
  fi
  if [ -n "$url" ]; then
    printf '%s' "$url" | sed -e 's#/*$##' -e 's#\.git$##'
  else
    printf '%s' "$dir"
  fi
}

# _myai_ns_owner <code_repo_dir> — the git "group"/owner segment from origin
# (git@github.com:knofler/app.git → knofler; https://…/knofler/app → knofler).
# Empty when there is no origin remote. This is the "name/group" collision hint.
_myai_ns_owner() {
  local dir="$1" url owner=""
  git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || return 0
  url="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
  [ -n "$url" ] || return 0
  url="${url%.git}"
  owner="$(printf '%s' "$url" | sed -E 's#[:/]+#/#g' | awk -F/ '{ if (NF>=2) print $(NF-1) }')"
  printf '%s' "$owner"
}

# myai_ns_register <code_repo_dir> <desired_base> [pinned_ns]
#   Ensure a collision-safe brain namespace exists for this code repo and print
#   the final, brain-canonical namespace id on stdout.
#     • pinned_ns non-empty (an existing .myai-local id) → register that exact ns,
#       never rename (idempotency guardrail).
#     • else derive from desired_base; reuse an existing ns only when its .origin
#       marks it as THIS repo's, otherwise walk to the next free candidate.
#   Registration + provenance stamping are best-effort (no brain → skipped); the
#   resolved id is always printed. rc 0.
myai_ns_register() {
  local cdir="$1" base="$2" pinned="${3:-}"
  local d; d="$(brain_dir)"
  local codeid; codeid="$(_myai_ns_code_id "$cdir")"

  base="$(_brain_slugify "$base")"; [ -n "$base" ] || base="repo"

  local ns
  if [ -n "$pinned" ]; then
    # The recorded id wins — canonicalize but never renumber it.
    ns="$(_brain_slugify "$pinned")"; [ -n "$ns" ] || ns="$base"
  else
    ns="$base"
    # Collision resolution only makes sense against an existing brain.
    if brain_is_repo "$d"; then
      local owner cand n
      owner="$(_myai_ns_owner "$cdir")"
      local -a candidates=("$base")
      [ -n "$owner" ] && candidates+=("$(_brain_slugify "$owner-$base")")
      for n in 2 3 4 5 6 7 8 9; do candidates+=("$base-$n"); done
      ns=""
      for cand in "${candidates[@]}"; do
        if [ ! -d "$d/repos/$cand" ]; then ns="$cand"; break; fi
        if [ "$(cat "$d/repos/$cand/.origin" 2>/dev/null || true)" = "$codeid" ]; then
          ns="$cand"; break
        fi
      done
      # Everything taken by other repos → deterministic hash suffix.
      [ -n "$ns" ] || ns="$base-$(printf '%s' "$codeid" | _brain_sha8)"
    fi
  fi

  # Register (idempotent) + stamp provenance once. All best-effort.
  if brain_is_repo "$d"; then
    brain_ensure_ns "$ns" >/dev/null 2>&1 || true
    if [ -d "$d/repos/$ns" ] && [ ! -f "$d/repos/$ns/.origin" ]; then
      printf '%s\n' "$codeid" > "$d/repos/$ns/.origin" 2>/dev/null || true
      git -C "$d" add "repos/$ns/.origin" >/dev/null 2>&1 || true
      git -C "$d" commit -q -m "brain(ns): stamp origin for $ns" >/dev/null 2>&1 || true
    fi
  fi

  printf '%s\n' "$ns"
  return 0
}
