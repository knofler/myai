#!/bin/bash
set +e
# Hook: Block Push to Main — prevents direct push, allows state commits

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

# Swarm ship lock (plan/SWARM_COORDINATOR_PLAN.md row 4): while a swarm is
# ACTIVE on this Mac (`swarm master take` wrote ~/.myai/swarm/active.<host>),
# only the coordinator SESSION merges. scripts/ship_lock.sh allows when no swarm
# is active, when the gateway is down, or with SHIP_LOCK_OFF=1, so a normal
# single-session `ship it` is unaffected.
# Operator decision 2026-10-03 (option 1): only MERGING is locked — workers may
# open PRs for review; the coordinator alone merges.
# Detection is by command words, not substrings (`ship_lock.sh is-merge`
# tokenises the line: `gh … pr … merge` in any chain/spacing, `gh api
# …/pulls/<n>/merge`; quoted text such as a commit message never matches). The
# cheap substring pre-filter below only decides whether to tokenise at all.
# NOT covered: the GitHub MCP server's merge tool (an MCP call, not Bash) and
# `bash -c "<string>"` — GitHub branch protection is the backstop for those.
# Resolved relative to this hook: hooks/pre-tool → scripts (master) and
# AI/hooks/pre-tool → AI/scripts (managed repos). Missing script → no lock.
if [[ "$CMD" == *gh* && ( "$CMD" == *merge* || "$CMD" == *Merge* ) ]]; then
  SHIP_LOCK="${SHIP_LOCK_SCRIPT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)/scripts/ship_lock.sh}"
  if [[ -f "$SHIP_LOCK" ]] && printf '%s' "$CMD" | bash "$SHIP_LOCK" is-merge; then
    if ! LOCK_OUT=$(bash "$SHIP_LOCK" check 2>&1); then
      echo "$LOCK_OUT" >&2
      echo "BLOCKED: swarm ship lock — only the coordinator merges PRs (gh pr merge). Open the PR and mail the coordinator." >&2
      exit 2
    fi
    [[ -n "$LOCK_OUT" ]] && echo "$LOCK_OUT" >&2
  fi
fi

# Only care about git push
[[ "$CMD" != *"git push"* ]] && exit 0

# The BRAIN repo manages its own main (sessions merge to brain main by design) —
# never our concern. Exempt any push targeting a repo via -C outside this one,
# or the brain path explicitly.
[[ "$CMD" == *".myai/brain"* ]] && exit 0
[[ "$CMD" == *"git -C "* && "$CMD" != *"git -C ."* ]] && exit 0

# Check if pushing to main/master
IS_MAIN=false
[[ "$CMD" == *"origin main"* ]] && IS_MAIN=true
[[ "$CMD" == *"origin master"* ]] && IS_MAIN=true
[[ "$CMD" == *":main"* ]] && IS_MAIN=true
[[ "$CMD" == *":master"* ]] && IS_MAIN=true

[[ "$IS_MAIN" == false ]] && exit 0

# Allow gh pr commands
[[ "$CMD" == *"gh pr"* ]] && exit 0

# Allow state update commits
LAST_MSG=$(git log -1 --format=%s 2>/dev/null || true)
[[ "$LAST_MSG" == "chore: update state"* ]] && exit 0

# Allow DOCS-SAFE direct pushes to main (AI_RULES §17): docs / AI_RULES / plans /
# ADRs / state / logs can't affect the app, gain nothing from a PR's checks or
# Copilot review, and MUST reach main so other machines' `agent mode` (which pulls
# main) sees them. A direct push triggers ZERO check workflows (all PR-only), so
# this is the zero-Actions path for docs. Allowed ONLY when EVERY changed file in
# the push range is docs-safe (*.md or under state/ logs/ docs/ plan/ architecture/
# design/ documentation/) — any code/script/hook/workflow/config file → BLOCK
# (force a PR). Fail closed: if the range can't be computed, block.
RANGE_FILES=$(git diff --name-only origin/main..HEAD 2>/dev/null)
if [[ -n "$RANGE_FILES" ]]; then
  NONDOC=0
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    case "$f" in
      *.md) ;;
      state/*|logs/*|docs/*|plan/*|architecture/*|design/*|documentation/*|*/documentation/*) ;;
      *) NONDOC=1; break ;;
    esac
  done <<< "$RANGE_FILES"
  if [[ "$NONDOC" == 0 ]]; then exit 0; fi   # docs-safe → allow direct to main
fi

echo "BLOCKED: Direct push to main/master is not allowed for code." >&2
echo "Docs/AI_RULES/plans/state may push direct to main; code must go via a PR." >&2
echo "Push code to 'test' and open a (batched) PR." >&2
exit 2
