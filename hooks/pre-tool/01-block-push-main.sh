#!/bin/bash
set +e
# Hook: Block Push to Main — prevents direct push, allows state commits

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

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

echo "BLOCKED: Direct push to main/master is not allowed for code."
echo "Docs/AI_RULES/plans/state may push direct to main; code must go via a PR."
echo "Push code to 'test' and open a (batched) PR."
exit 2
